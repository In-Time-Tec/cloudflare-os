// The ChatMirror Durable Object: one per connected full-mode Microsoft account, mirroring the
// user's Teams conversations for the Workshop's human chat UI.
//
// Graph remains the only source of truth. This DO holds a rebuildable projection:
//   - conversations (chats + followed channels) and a bounded window of recent messages,
//   - Graph change-notification subscriptions (aggregate beta all-chats feed + per-followed-
//     channel v1.0 subs) with alarm-driven renewal,
//   - open-tab WebSockets (hibernatable) receiving live ConversationEvents,
//   - Web Push subscriptions for closed-tab notification.
//
// The human sends through here act directly under the user's delegated token — deliberately NOT
// through the agent approval queue (a person pressing Send is the user acting, as in Teams).

import { DurableObject } from "cloudflare:workers";
import { Effect, Result } from "effect";
import {
  ConversationMessage, ConversationRef, ConversationSummary,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GraphError, GraphTransport, makeTransport, profile, subscriptions, teams,
} from "@gadgets/microsoft-graph";
import { sanitizeTeamsHtml, escapeHtml } from "./sanitize.js";
import { PushSubscriptionInfo, sendWebPush } from "./webpush.js";
import { obsContext } from "./observability.js";
import { VENDOR_ID } from "./vendor.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.microsoft.chatmirror", vendorId: VENDOR_ID,
});

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

/** How long the conversation list is served from cache before a re-hydrate. */
const LIST_TTL_MS = 45_000;
/** Renewal alarm cadence; also drives the reconcile sweep. */
const ALARM_INTERVAL_MS = 10 * 60_000;
/** Renew subscriptions with at least this much runway left. */
const RENEW_BEFORE_MS = 60 * 60_000;
/** Bounded per-conversation message window. */
const MESSAGE_WINDOW = 200;

function refKey(ref: ConversationRef): string {
  return ref.kind === "chat" ? `chat:${ref.chatId}`
      : `channel:${ref.teamId}:${ref.channelId}`;
}

function parseRefKey(key: string): ConversationRef {
  const parts = key.split(":");
  return parts[0] === "chat"
      ? { kind: "chat", chatId: parts.slice(1).join(":") }
      : { kind: "channel", teamId: parts[1], channelId: parts.slice(2).join(":") };
}

export class ChatMirror extends DurableObject<Env> {
  #sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        ref_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        members_json TEXT NOT NULL DEFAULT '[]',
        last_from TEXT,
        last_preview TEXT,
        last_activity INTEGER,
        followed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        graph_id TEXT NOT NULL,
        ref_key TEXT NOT NULL,
        from_name TEXT NOT NULL,
        from_user_id TEXT,
        from_self INTEGER NOT NULL DEFAULT 0,
        created INTEGER,
        html TEXT NOT NULL,
        PRIMARY KEY (ref_key, graph_id)
      );
      CREATE INDEX IF NOT EXISTS messages_by_time ON messages (ref_key, created);
      CREATE TABLE IF NOT EXISTS graph_subs (
        sub_id TEXT PRIMARY KEY,
        resource TEXT NOT NULL,
        client_state TEXT NOT NULL,
        expires INTEGER
      );
      CREATE TABLE IF NOT EXISTS push_subs (
        endpoint TEXT PRIMARY KEY,
        keys_json TEXT NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  /** Bind this mirror to its owning UserAccount DO (id string) and self oid; idempotent. */
  async configure(userObjectId: string, selfUserId: string): Promise<void> {
    this.#metaPut("userObjectId", userObjectId);
    this.#metaPut("selfUserId", selfUserId);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
    }
  }

  #meta(key: string): string | undefined {
    const row = this.#sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value as string | undefined;
  }

  #metaPut(key: string, value: string): void {
    this.#sql.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
        key, value, value);
  }

  #transport(): GraphTransport {
    const userObjectId = this.#meta("userObjectId");
    if (!userObjectId) throw new Error("Chat mirror is not configured yet.");
    const account = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(userObjectId));
    return makeTransport(() => account.getAccessToken());
  }

  async #run<A>(operation: Effect.Effect<A, GraphError>): Promise<A> {
    const result = await Effect.runPromise(Effect.result(operation));
    if (Result.isSuccess(result)) return result.success;
    const failure = result.failure;
    if (failure._tag === "GraphAuthError") {
      throw new Error(
          "Microsoft credentials have expired or been revoked. Please reconnect the account.");
    }
    throw new Error(`Microsoft Graph request failed (${failure._tag}).`);
  }

  // ── Conversation list ─────────────────────────────────────────────────────

  async listConversations(): Promise<ConversationSummary[]> {
    await this.#hydrateIfStale();
    return this.#readConversations("chat");
  }

  async listChannels(): Promise<ConversationSummary[]> {
    await this.#hydrateIfStale();
    return this.#readConversations("channel");
  }

  #readConversations(kind: "chat" | "channel"): ConversationSummary[] {
    const rows = this.#sql.exec(
        `SELECT * FROM conversations WHERE kind = ? ORDER BY last_activity DESC NULLS LAST`,
        kind).toArray();
    return rows.map(row => ({
      ref: parseRefKey(row.ref_key as string),
      title: row.title as string,
      subtitle: (row.subtitle as string | null) ?? undefined,
      members: JSON.parse(row.members_json as string),
      lastMessage: row.last_preview !== null ? {
        from: (row.last_from as string | null) ?? undefined,
        preview: row.last_preview as string,
        created: row.last_activity ? new Date(row.last_activity as number) : undefined,
      } : undefined,
      lastActivity: row.last_activity ? new Date(row.last_activity as number) : undefined,
    }));
  }

  async #hydrateIfStale(): Promise<void> {
    const last = Number(this.#meta("lastHydrate") ?? 0);
    if (Date.now() - last < LIST_TTL_MS) return;
    await this.hydrate();
  }

  /** Rebuild the conversation list from Graph (chats + channels of associated teams). */
  async hydrate(): Promise<void> {
    const transport = this.#transport();
    const selfUserId = this.#meta("selfUserId");

    const chatPage = await this.#run(teams.listChats(transport, { top: 50 }));
    for (const chat of chatPage.chats) {
      const others = chat.members.filter(m => m.userId && m.userId !== selfUserId);
      const title = chat.topic
          || others.map(m => m.displayName).filter(Boolean).join(", ")
          || "Chat";
      this.#upsertConversation({
        refKey: refKey({ kind: "chat", chatId: chat.id }),
        kind: "chat",
        title,
        subtitle: chat.chatType === "meeting" ? "Meeting chat" : undefined,
        members: others.map(m => ({ name: m.displayName ?? "", userId: m.userId })),
        lastFrom: chat.lastMessage?.from,
        lastPreview: chat.lastMessage
            ? await this.#previewText(chat.lastMessage.preview) : undefined,
        lastActivity: (chat.lastMessage?.created ?? chat.lastUpdated)?.valueOf(),
      });
    }

    const teamList = await this.#run(teams.listAssociatedTeams(transport));
    for (const team of teamList) {
      let channels;
      try {
        channels = await this.#run(teams.listChannels(transport, team.id));
      } catch {
        continue;  // e.g. host tenant policy; skip the team rather than fail the sweep
      }
      for (const channel of channels) {
        this.#upsertConversation({
          refKey: refKey({ kind: "channel", teamId: team.id, channelId: channel.id }),
          kind: "channel",
          title: channel.name,
          subtitle: team.name,
          members: [],
        });
      }
    }

    this.#metaPut("lastHydrate", String(Date.now()));
  }

  async #previewText(html: string): Promise<string> {
    // Previews render as plain text: strip tags via the sanitizer then collapse whitespace.
    const clean = await sanitizeTeamsHtml(html);
    return clean.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  #upsertConversation(record: {
    refKey: string; kind: string; title: string; subtitle?: string;
    members: { name: string; userId?: string }[];
    lastFrom?: string; lastPreview?: string; lastActivity?: number;
  }): void {
    this.#sql.exec(`
      INSERT INTO conversations
        (ref_key, kind, title, subtitle, members_json, last_from, last_preview, last_activity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ref_key) DO UPDATE SET
        title = excluded.title,
        subtitle = excluded.subtitle,
        members_json = excluded.members_json,
        last_from = COALESCE(excluded.last_from, conversations.last_from),
        last_preview = COALESCE(excluded.last_preview, conversations.last_preview),
        last_activity = COALESCE(excluded.last_activity, conversations.last_activity)
    `, record.refKey, record.kind, record.title, record.subtitle ?? null,
       JSON.stringify(record.members), record.lastFrom ?? null,
       record.lastPreview ?? null, record.lastActivity ?? null);
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async getMessages(ref: ConversationRef, _options?: { before?: string })
      : Promise<{ messages: ConversationMessage[]; hasMore: boolean }> {
    await this.#backfill(ref);
    const key = refKey(ref);
    const rows = this.#sql.exec(
        `SELECT * FROM messages WHERE ref_key = ? ORDER BY created DESC LIMIT 50`, key)
        .toArray().toReversed();
    return {
      messages: rows.map(row => ({
        id: row.graph_id as string,
        from: row.from_name as string,
        fromUserId: (row.from_user_id as string | null) ?? undefined,
        fromSelf: Boolean(row.from_self),
        created: row.created ? new Date(row.created as number) : undefined,
        html: row.html as string,
      })),
      hasMore: rows.length >= 50,
    };
  }

  /** Fetch the latest page from Graph into the window (idempotent by message id). */
  async #backfill(ref: ConversationRef): Promise<void> {
    const transport = this.#transport();
    const conversation = ref.kind === "chat"
        ? { kind: "chat" as const, chatId: ref.chatId }
        : { kind: "channel" as const, teamId: ref.teamId, channelId: ref.channelId };
    const page = await this.#run(teams.listMessages(transport, conversation, { top: 40 }));
    for (const message of page.messages) {
      await this.#storeMessage(ref, message);
    }
    this.#trimWindow(refKey(ref));
  }

  async #storeMessage(ref: ConversationRef, message: teams.TeamsMessage)
      : Promise<ConversationMessage | null> {
    const selfUserId = this.#meta("selfUserId");
    const html = message.contentType.toLowerCase() === "html"
        ? await sanitizeTeamsHtml(message.content)
        : `<p>${escapeHtml(message.content)}</p>`;
    const key = refKey(ref);
    const fromSelf = message.fromUserId !== undefined && message.fromUserId === selfUserId;
    const existing = this.#sql.exec(
        "SELECT 1 FROM messages WHERE ref_key = ? AND graph_id = ?", key, message.id)
        .toArray().length > 0;
    this.#sql.exec(`
      INSERT INTO messages (graph_id, ref_key, from_name, from_user_id, from_self, created, html)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ref_key, graph_id) DO UPDATE SET html = excluded.html
    `, message.id, key, message.from, message.fromUserId ?? null, fromSelf ? 1 : 0,
       message.created?.valueOf() ?? null, html);
    if (existing) return null;  // duplicate doorbell or edit — no fan-out as "new"
    return {
      id: message.id,
      from: message.from,
      fromUserId: message.fromUserId,
      fromSelf,
      created: message.created,
      html,
    };
  }

  #trimWindow(key: string): void {
    this.#sql.exec(`
      DELETE FROM messages WHERE ref_key = ? AND graph_id NOT IN (
        SELECT graph_id FROM messages WHERE ref_key = ? ORDER BY created DESC LIMIT ?)
    `, key, key, MESSAGE_WINDOW);
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async sendMessage(ref: ConversationRef, text: string): Promise<{ id: string }> {
    const transport = this.#transport();
    const conversation = ref.kind === "chat"
        ? { kind: "chat" as const, chatId: ref.chatId }
        : { kind: "channel" as const, teamId: ref.teamId, channelId: ref.channelId };
    const sent = await this.#run(teams.sendMessage(transport, conversation, text));
    const message: teams.TeamsMessage = {
      id: sent.id, from: "You", fromUserId: this.#meta("selfUserId"),
      created: new Date(), contentType: "text", content: text, mentionedUserIds: [],
    };
    const stored = await this.#storeMessage(ref, message);
    if (stored) this.#broadcast(ref, stored);
    this.#touchActivity(refKey(ref), "You", text);
    return { id: sent.id };
  }

  async replyToMessage(ref: ConversationRef & { kind: "channel" }, messageId: string,
                       text: string): Promise<{ id: string }> {
    const transport = this.#transport();
    const sent = await this.#run(teams.replyToChannelMessage(
        transport, ref.teamId, ref.channelId, messageId, text));
    return { id: sent.id };
  }

  #touchActivity(key: string, from: string, preview: string): void {
    this.#sql.exec(`
      UPDATE conversations SET last_from = ?, last_preview = ?, last_activity = ?
      WHERE ref_key = ?
    `, from, preview.slice(0, 120), Date.now(), key);
  }

  // ── Avatars ───────────────────────────────────────────────────────────────

  async getAvatar(userId: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
    const cached = await this.ctx.storage.kv.get<Uint8Array | "none">(`avatar:${userId}`);
    if (cached === "none") return null;
    if (cached) return cached;
    let photo: Uint8Array | null = null;
    try {
      photo = await this.#run(profile.getUserPhoto(this.#transport(), userId));
    } catch {
      return null;  // missing scope or transient failure: no avatar, don't cache
    }
    await this.ctx.storage.kv.put(`avatar:${userId}`, photo ?? "none");
    return photo;
  }

  // ── Live delivery: WebSockets ─────────────────────────────────────────────

  /** Mint a short-lived token the browser presents on the /ws upgrade. */
  async mintSocketToken(): Promise<string> {
    const token = crypto.getRandomValues(new Uint8Array(24)).toBase64({ alphabet: "base64url" });
    await this.ctx.storage.kv.put(`wstoken:${token}`, Date.now() + 5 * 60_000);
    return token;
  }

  /** Consume a one-time socket token; true when it was valid and unexpired. */
  async consumeSocketToken(token: string): Promise<boolean> {
    const expiry = await this.ctx.storage.kv.get<number>(`wstoken:${token}`);
    if (!expiry || expiry < Date.now()) return false;
    this.ctx.storage.kv.delete(`wstoken:${token}`);
    return true;
  }

  async acceptSocket(token: string): Promise<Response> {
    if (!await this.consumeSocketToken(token)) {
      return new Response("Invalid or expired socket token", { status: 403 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // The client reports which conversation it is viewing, for push suppression.
    try {
      const message = JSON.parse(String(raw));
      if (message.kind === "viewing") {
        ws.serializeAttachment({ viewing: message.refKey ?? null });
      }
    } catch {
      // ignore malformed frames
    }
  }

  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}

  #broadcast(ref: ConversationRef, message: ConversationMessage): void {
    const payload = JSON.stringify({ kind: "message", ref, message });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // dead socket; the runtime reaps it
      }
    }
  }

  // ── Web Push ──────────────────────────────────────────────────────────────

  async registerPush(subscription: PushSubscriptionInfo): Promise<void> {
    this.#sql.exec(`
      INSERT INTO push_subs (endpoint, keys_json, created) VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json
    `, subscription.endpoint, JSON.stringify(subscription.keys), Date.now());
  }

  async unregisterPush(endpoint: string): Promise<void> {
    this.#sql.exec("DELETE FROM push_subs WHERE endpoint = ?", endpoint);
  }

  async #pushToDevices(ref: ConversationRef, message: ConversationMessage,
                       conversationTitle: string): Promise<void> {
    const publicKey = this.env.VAPID_PUBLIC_KEY;
    const privateKey = this.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) return;
    const subject = this.env.VAPID_SUBJECT ?? "mailto:admin@example.com";
    const preview = message.html.replace(/<[^>]+>/g, "").slice(0, 140);
    const payload = JSON.stringify({
      title: ref.kind === "chat" ? message.from : `${message.from} in ${conversationTitle}`,
      body: preview,
      refKey: refKey(ref),
    });
    const rows = this.#sql.exec("SELECT endpoint, keys_json FROM push_subs").toArray();
    for (const row of rows) {
      const subscription: PushSubscriptionInfo = {
        endpoint: row.endpoint as string,
        keys: JSON.parse(row.keys_json as string),
      };
      try {
        const outcome = await sendWebPush(subscription, payload, publicKey, privateKey, subject);
        if (outcome === "gone") this.#sql.exec(
            "DELETE FROM push_subs WHERE endpoint = ?", subscription.endpoint);
      } catch (err) {
        logger.warn("web push send failed", { event: "chatmirror.push.failed", error: err });
      }
    }
  }

  // ── Notification ingest ───────────────────────────────────────────────────

  /** Verify a notification's clientState against any of this mirror's subscriptions. */
  async verifyClientState(clientState: string): Promise<boolean> {
    return this.#sql.exec("SELECT 1 FROM graph_subs WHERE client_state = ?", clientState)
        .toArray().length > 0;
  }

  /** Handle one change notification: fetch the message, store, fan out. */
  async ingest(resource: string): Promise<void> {
    const transport = this.#transport();
    let fetched;
    try {
      fetched = await this.#run(teams.getMessageByNotificationResource(transport, resource));
    } catch (err) {
      logger.warn("notification ingest fetch failed", {
        event: "chatmirror.ingest.failed", error: err,
      });
      return;
    }
    const ref: ConversationRef | null = fetched.chatId
        ? { kind: "chat", chatId: fetched.chatId }
        : fetched.teamId && fetched.channelId
            ? { kind: "channel", teamId: fetched.teamId, channelId: fetched.channelId }
            : null;
    if (!ref) return;

    const stored = await this.#storeMessage(ref, fetched);
    if (!stored) return;  // duplicate or edit

    const key = refKey(ref);
    const preview = stored.html.replace(/<[^>]+>/g, "").slice(0, 120);
    this.#touchActivity(key, stored.from, preview);
    this.#broadcast(ref, stored);

    if (stored.fromSelf) return;
    // Push suppression: skip when any open tab is viewing this conversation.
    const viewing = this.ctx.getWebSockets().some(ws => {
      const attachment = ws.deserializeAttachment() as { viewing?: string | null } | null;
      return attachment?.viewing === key;
    });
    if (viewing) return;
    // Channels: push only for mentions of the user or followed channels.
    if (ref.kind === "channel") {
      const selfUserId = this.#meta("selfUserId");
      const mentioned = selfUserId !== undefined
          && fetched.mentionedUserIds.includes(selfUserId);
      const followed = this.#sql.exec(
          "SELECT followed FROM conversations WHERE ref_key = ?", key)
          .toArray()[0]?.followed === 1;
      if (!mentioned && !followed) return;
    }
    const title = this.#sql.exec(
        "SELECT title FROM conversations WHERE ref_key = ?", key).toArray()[0]?.title as string
        ?? "Conversation";
    await this.#pushToDevices(ref, stored, title);
  }

  /** Follow/unfollow a channel for push notification. */
  async setFollowed(ref: ConversationRef, followed: boolean): Promise<void> {
    this.#sql.exec("UPDATE conversations SET followed = ? WHERE ref_key = ?",
        followed ? 1 : 0, refKey(ref));
  }

  // ── Subscription lifecycle ────────────────────────────────────────────────

  async ensureSubscriptions(notificationBaseUrl: string): Promise<void> {
    const selfUserId = this.#meta("selfUserId");
    if (!selfUserId) return;
    const wanted = [`/users/${selfUserId}/chats/getAllMessages`];
    const existing = new Map(this.#sql.exec("SELECT sub_id, resource, expires FROM graph_subs")
        .toArray().map(row => [row.resource as string, row]));

    const transport = this.#transport();
    for (const resource of wanted) {
      const current = existing.get(resource);
      if (current) {
        const expires = current.expires as number | null;
        if (expires && expires - Date.now() > RENEW_BEFORE_MS) continue;
        try {
          const renewed = await this.#run(
              subscriptions.renewSubscription(transport, current.sub_id as string));
          this.#sql.exec("UPDATE graph_subs SET expires = ? WHERE sub_id = ?",
              renewed.expires?.valueOf() ?? null, current.sub_id);
          continue;
        } catch {
          this.#sql.exec("DELETE FROM graph_subs WHERE sub_id = ?", current.sub_id);
        }
      }
      const clientState = crypto.getRandomValues(new Uint8Array(16))
          .toBase64({ alphabet: "base64url" });
      try {
        const created = await this.#run(subscriptions.createSubscription(transport, {
          resource,
          notificationUrl: `${notificationBaseUrl}/notifications`,
          lifecycleNotificationUrl: `${notificationBaseUrl}/notifications`,
          clientState: `${this.ctx.id.toString()}.${clientState}`,
        }));
        this.#sql.exec(
            "INSERT INTO graph_subs (sub_id, resource, client_state, expires) VALUES (?, ?, ?, ?)",
            created.id, resource, `${this.ctx.id.toString()}.${clientState}`,
            created.expires?.valueOf() ?? null);
      } catch (err) {
        logger.warn("subscription create failed", {
          event: "chatmirror.subscription.create.failed", error: err,
        });
      }
    }
  }

  /** A lifecycle event told us the subscription died; recreate on the next alarm. */
  async dropSubscription(subscriptionId: string): Promise<void> {
    this.#sql.exec("DELETE FROM graph_subs WHERE sub_id = ?", subscriptionId);
    await this.ctx.storage.setAlarm(Date.now() + 5_000);
  }

  async alarm(): Promise<void> {
    const baseUrl = stripBase(this.env.BASE_URL);
    try {
      await this.ensureSubscriptions(baseUrl);
    } catch (err) {
      logger.warn("subscription sweep failed", {
        event: "chatmirror.subscription.sweep.failed", error: err,
      });
    }
    // Reconcile: refresh the list; open-tab conversations heal on next read.
    try {
      await this.hydrate();
    } catch {
      // transient; next alarm retries
    }
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  /** Tear down on account disconnect: delete Graph subscriptions and all state. */
  async destroy(): Promise<void> {
    const transport = this.#transport();
    for (const row of this.#sql.exec("SELECT sub_id FROM graph_subs").toArray()) {
      try {
        await this.#run(subscriptions.deleteSubscription(transport, row.sub_id as string));
      } catch {
        // best-effort
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

function stripBase(baseUrl: string | undefined): string {
  const url = baseUrl || "http://localhost:8787/gatekeeper/microsoft";
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
