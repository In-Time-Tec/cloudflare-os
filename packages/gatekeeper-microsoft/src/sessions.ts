// The four Microsoft capability gatekeepers (one Durable Object class per resource type) and
// their agent-facing sessions.
//
// Security model (uniform across all four):
//   - every read fetches from Graph, then calls approvalQueue.authorizeObservation() BEFORE any
//     data is returned to the caller;
//   - every write is staged in DO storage and submitted with approvalQueue.submitAction(); the
//     Graph call happens only in applyAction() after approval. Writes are not simulated, so every
//     ActionDescription sets awaitDecision — the agent pauses until the user decides;
//   - all four capabilities expose broad personal data, so observers are never allowed
//     (addObserver throws): a gadget bound to one of these cannot be shared.
//
// Effect stays inside this file: sessions run SDK operations with runGraph(), which converts
// tagged Graph failures into plain Errors whose messages tell the caller its next valid action.

import { DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { Effect, Result } from "effect";
import {
  ActionDescription, ActionKind, ApprovalQueue, Cursor, Gatekeeper, GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GraphError, GraphTransport, makeTransport, PageCursor,
  calendar, files, mail, teams,
} from "@gadgets/microsoft-graph";
import type {
  BusySpan, CalendarEventInfo, ChannelInfo, FileEntry, MicrosoftFilesSession,
  OutlookCalendarSession, OutlookMailSession, OutlookMessageDetail, OutlookMessageInfo,
  SiteInfo, TeamInfo, TeamsChatInfo, TeamsMessageInfo, TeamsSession,
} from "./types.js";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env;

type SessionProps = { userObjectId: string };

// ── Shared plumbing ─────────────────────────────────────────────────────────

/**
 * Run one SDK operation at the RPC boundary: Effect in, plain value out. Tagged failures become
 * Errors whose messages name the caller's next valid action; the tags never cross the boundary.
 */
async function runGraph<A>(operation: Effect.Effect<A, GraphError>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return result.success;
  const failure = result.failure;
  switch (failure._tag) {
    case "GraphAuthError":
      throw new Error(
          "Microsoft credentials have expired or been revoked. Please reconnect the account.");
    case "GraphConsentError":
      throw new Error(
          "The connected Microsoft account has not granted this capability. Expand the " +
          "account's access from the Connectors page.");
    case "GraphThrottledError":
      throw new Error(
          `Microsoft is throttling requests; try again in ${Math.ceil(failure.retryAfterMs / 1000)}s.`);
    case "GraphNotFoundError":
      throw new Error(`Not found: ${failure.resource}.`);
    case "GraphConflictError":
      throw new Error("The item changed remotely; re-read it and try again.");
    case "GraphUnavailableError":
      throw new Error("Microsoft Graph is temporarily unavailable. Try again shortly.");
    case "GraphDecodeError":
      throw new Error("Microsoft returned an unexpected response. Try again shortly.");
  }
}

/** Sequential action ids + staged payloads, keyed in DO storage. */
class PendingActionStore<Action> {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  submit(action: Action): number {
    const id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(`pending:action:${id}`, action);
    return id;
  }

  get(id: number): Action | undefined {
    return this.#kv.get<Action>(`pending:action:${id}`);
  }

  remove(id: number): void {
    this.#kv.delete(`pending:action:${id}`);
  }
}

/**
 * Base class for the four capability gatekeepers: transport wiring, the private-only observer
 * policy, and the staged-action skeleton. Subclasses own their session, action set, and applys.
 */
abstract class MicrosoftGatekeeperBase<Action>
    extends DurableObject<Env, SessionProps> {
  protected transport(): GraphTransport {
    const account = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return makeTransport(() => account.getAccessToken());
  }

  protected actions(): PendingActionStore<Action> {
    return new PendingActionStore<Action>(this.ctx.storage.kv);
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Everything these gatekeepers read is broad personal Microsoft data (a whole mailbox,
   * calendar, drive, or Teams account), which no other user could be entitled to wholesale —
   * so gadgets bound to them cannot be shared.
   */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
        "Workspaces connected to a Microsoft account cannot be shared: they may expose " +
        "personal mail, calendar, file, or Teams data.");
  }

  async removeObserver(_id: string): Promise<void> {}

  async rejectAction(actionId: number): Promise<void> {
    this.actions().remove(actionId);
  }

  async revertAction(_actionId: number): Promise<{ message: string; canRetry: boolean }> {
    return {
      message: "This Microsoft action cannot be reverted automatically; undo it in the " +
          "Microsoft app if needed.",
      canRetry: false,
    };
  }
}

/** Format a bounded, human-readable field block for approval descriptions. */
function approvalField(label: string, value: string): string {
  const bounded = value.length > 2000 ? value.slice(0, 2000) + "…" : value;
  return `**${label}:**\n\n${bounded}\n`;
}

// ── Outlook Mail ────────────────────────────────────────────────────────────

type MailAction =
  | { type: "createDraft"; to: string[]; cc?: string[]; subject: string; body: string }
  | { type: "createReplyDraft"; messageId: string; comment: string };

const CREATE_DRAFT_KIND: ActionKind = {
  tag: "microsoft.mail.draft.create", label: "Create Outlook drafts",
};

export class MailboxGatekeeperImpl extends MicrosoftGatekeeperBase<MailAction>
    implements Gatekeeper<OutlookMailSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://outlook.office.com/mail/",
      title: "Outlook Mailbox",
      snippet: "The connected account's Outlook mailbox",
      suggestedBindingName: "OUTLOOK_MAIL",
      tsType: "OutlookMailSession",
    };
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // Drafts are additive and invisible to recipients until the user sends them.
    return [CREATE_DRAFT_KIND];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<OutlookMailSession> {
    return new MailSessionImpl(this.transport(), approvalQueue.dup(), this.actions());
  }

  async applyAction(actionId: number): Promise<void> {
    const action = this.actions().get(actionId);
    if (!action) throw new Error(`Unknown pending Microsoft mail action: ${actionId}`);
    const transport = this.transport();
    const created = action.type === "createDraft"
        ? await runGraph(mail.createDraft(transport, {
            to: action.to, cc: action.cc, subject: action.subject, body: action.body,
          }))
        : await runGraph(mail.createReplyDraft(transport, action.messageId, action.comment));
    // Record the terminal provider result alongside the consumed action.
    this.ctx.storage.kv.put(`applied:action:${actionId}`, { draftId: created.id });
    this.actions().remove(actionId);
  }
}

/** Pages one mailbox listing through the Cursor RPC contract. */
class MessageCursorImpl extends RpcTarget implements Cursor<OutlookMessageInfo> {
  #fetchFirst: () => Effect.Effect<mail.MessagePage, GraphError>;
  #transport: GraphTransport;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #what: string;
  #next: PageCursor | undefined;
  #started = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(transport: GraphTransport, approvalQueue: RpcStub<ApprovalQueue>, what: string,
              fetchFirst: () => Effect.Effect<mail.MessagePage, GraphError>) {
    super();
    this.#transport = transport;
    this.#approvalQueue = approvalQueue;
    this.#what = what;
    this.#fetchFirst = fetchFirst;
  }

  next(): Promise<OutlookMessageInfo[] | null> {
    const result = this.#tail.then(() => this.#nextPage());
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #nextPage(): Promise<OutlookMessageInfo[] | null> {
    if (this.#started && !this.#next) return null;
    const page = await runGraph(this.#started
        ? mail.nextMessagePage(this.#transport, this.#next!)
        : this.#fetchFirst());
    this.#started = true;
    this.#next = page.next;
    if (page.messages.length === 0) return null;
    await this.#approvalQueue.authorizeObservation({
      title: `Read ${page.messages.length} Outlook messages (${this.#what})`,
      description: `Fetch a page of Outlook message summaries.\n\n` +
          approvalField("Subjects", page.messages.map(m => m.subject).join("\n")),
    });
    return page.messages.map(toMessageInfo);
  }
}

function toMessageInfo(summary: mail.MessageSummary): OutlookMessageInfo {
  return {
    id: summary.id, subject: summary.subject, from: summary.from, to: summary.to,
    received: summary.received, preview: summary.preview, isRead: summary.isRead,
    hasAttachments: summary.hasAttachments, webLink: summary.webLink,
  };
}

@validateRpc()
class MailSessionImpl extends RpcTarget implements OutlookMailSession {
  constructor(private transport: GraphTransport,
              private approvalQueue: RpcStub<ApprovalQueue>,
              private actions: PendingActionStore<MailAction>) {
    super();
  }

  async listInbox(): Promise<Cursor<OutlookMessageInfo>> {
    return new MessageCursorImpl(this.transport, this.approvalQueue.dup(), "inbox",
        () => mail.listInbox(this.transport));
  }

  async search(query: string): Promise<Cursor<OutlookMessageInfo>> {
    return new MessageCursorImpl(this.transport, this.approvalQueue.dup(), `search: ${query}`,
        () => mail.searchMessages(this.transport, query));
  }

  async getMessage(id: string): Promise<OutlookMessageDetail> {
    const detail = await runGraph(mail.getMessage(this.transport, id));
    await this.approvalQueue.authorizeObservation({
      title: `Read Outlook message: ${detail.subject || "(no subject)"}`,
      description: `Read the full content of one Outlook message.\n\n` +
          approvalField("From", detail.from?.address ?? "unknown") +
          approvalField("Subject", detail.subject || "(no subject)"),
    });
    return detail;
  }

  async createDraft(to: string[], subject: string, body: string, cc?: string[])
      : Promise<{ id: string }> {
    const actionId = this.actions.submit({ type: "createDraft", to, cc, subject, body });
    await this.approvalQueue.submitAction(actionId, draftDescription(
        `Create Outlook draft: ${subject || "(no subject)"}`,
        approvalField("To", to.join(", ")) +
        (cc?.length ? approvalField("Cc", cc.join(", ")) : "") +
        approvalField("Subject", subject) +
        approvalField("Body", body)));
    return { id: `pending-draft-${actionId}` };
  }

  async createReplyDraft(messageId: string, comment: string): Promise<{ id: string }> {
    const actionId = this.actions.submit({ type: "createReplyDraft", messageId, comment });
    await this.approvalQueue.submitAction(actionId, draftDescription(
        "Create Outlook reply draft",
        approvalField("In reply to message", messageId) +
        approvalField("Reply body", comment)));
    return { id: `pending-draft-${actionId}` };
  }
}

function draftDescription(title: string, fields: string): ActionDescription {
  return {
    title,
    description: `Create a draft in the user's Outlook Drafts folder. Nothing is sent.\n\n` + fields,
    implementsRevert: false,
    awaitDecision: true,
    autoApprovable: true,
    actionKind: CREATE_DRAFT_KIND,
  };
}

// ── Outlook Calendar ────────────────────────────────────────────────────────

type CalendarAction = {
  type: "createEvent";
  subject: string; startIso: string; endIso: string;
  body?: string; location?: string; attendees?: string[]; onlineMeeting?: boolean;
};

const CREATE_EVENT_KIND: ActionKind = {
  tag: "microsoft.calendar.event.create", label: "Create calendar events",
};

export class CalendarGatekeeperImpl
    extends MicrosoftGatekeeperBase<CalendarAction>
    implements Gatekeeper<OutlookCalendarSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://outlook.office.com/calendar/",
      title: "Outlook Calendar",
      snippet: "The connected account's Outlook calendar",
      suggestedBindingName: "OUTLOOK_CALENDAR",
      tsType: "OutlookCalendarSession",
    };
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // Creating an event emails invitations to attendees, so it is never auto-approvable.
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<OutlookCalendarSession> {
    return new CalendarSessionImpl(this.transport(), approvalQueue.dup(), this.actions());
  }

  async applyAction(actionId: number): Promise<void> {
    const action = this.actions().get(actionId);
    if (!action) throw new Error(`Unknown pending Microsoft calendar action: ${actionId}`);
    const created = await runGraph(calendar.createEvent(this.transport(), {
      subject: action.subject,
      start: new Date(action.startIso),
      end: new Date(action.endIso),
      body: action.body,
      location: action.location,
      attendees: action.attendees,
      onlineMeeting: action.onlineMeeting,
    }));
    this.ctx.storage.kv.put(`applied:action:${actionId}`, { eventId: created.id });
    this.actions().remove(actionId);
  }
}

@validateRpc()
class CalendarSessionImpl extends RpcTarget implements OutlookCalendarSession {
  constructor(private transport: GraphTransport,
              private approvalQueue: RpcStub<ApprovalQueue>,
              private actions: PendingActionStore<CalendarAction>) {
    super();
  }

  async agenda(from: Date, to: Date): Promise<CalendarEventInfo[]> {
    // One agenda call returns at most one Graph page (50 events) plus follow-ups, bounded to
    // keep a runaway window from paging forever.
    const events: CalendarEventInfo[] = [];
    let page = await runGraph(calendar.listAgenda(this.transport, from, to));
    events.push(...page.events);
    for (let i = 0; page.next && i < 4; i++) {
      page = await runGraph(calendar.nextEventPage(this.transport, page.next));
      events.push(...page.events);
    }
    await this.approvalQueue.authorizeObservation({
      title: `Read ${events.length} calendar events`,
      description: `Read the agenda from ${from.toISOString()} to ${to.toISOString()}.\n\n` +
          approvalField("Events", events.map(e => e.subject).join("\n")),
    });
    return events;
  }

  async availability(addresses: string[], from: Date, to: Date)
      : Promise<Record<string, BusySpan[]>> {
    const map = await runGraph(
        calendar.getAvailability(this.transport, addresses, from, to));
    await this.approvalQueue.authorizeObservation({
      title: `Check availability for ${addresses.length} people`,
      description: `Read free/busy information.\n\n` +
          approvalField("People", addresses.join(", ")),
    });
    return Object.fromEntries(map);
  }

  async createEvent(event: {
    subject: string; start: Date; end: Date; body?: string; location?: string;
    attendees?: string[]; onlineMeeting?: boolean;
  }): Promise<{ id: string }> {
    const actionId = this.actions.submit({
      type: "createEvent", subject: event.subject,
      startIso: event.start.toISOString(), endIso: event.end.toISOString(),
      body: event.body, location: event.location, attendees: event.attendees,
      onlineMeeting: event.onlineMeeting,
    });
    await this.approvalQueue.submitAction(actionId, {
      title: `Create calendar event: ${event.subject}`,
      description: "Create an event on the user's calendar. Outlook sends invitations to " +
          "attendees when the event is created.\n\n" +
          approvalField("When", `${event.start.toISOString()} – ${event.end.toISOString()}`) +
          (event.attendees?.length ? approvalField("Attendees", event.attendees.join(", ")) : "") +
          (event.location ? approvalField("Location", event.location) : "") +
          (event.body ? approvalField("Description", event.body) : ""),
      implementsRevert: false,
      awaitDecision: true,
      actionKind: CREATE_EVENT_KIND,
    });
    return { id: `pending-event-${actionId}` };
  }
}

// ── OneDrive / SharePoint files ─────────────────────────────────────────────

export class FilesGatekeeperImpl extends MicrosoftGatekeeperBase<never>
    implements Gatekeeper<MicrosoftFilesSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://onedrive.office.com/",
      title: "OneDrive & SharePoint Files",
      snippet: "The connected account's OneDrive and visible SharePoint libraries (read-only)",
      suggestedBindingName: "MICROSOFT_FILES",
      tsType: "MicrosoftFilesSession",
    };
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<MicrosoftFilesSession> {
    return new FilesSessionImpl(this.transport(), approvalQueue.dup());
  }

  async applyAction(actionId: number): Promise<void> {
    throw new Error(`The Microsoft files capability is read-only; unknown action ${actionId}.`);
  }
}

@validateRpc()
class FilesSessionImpl extends RpcTarget implements MicrosoftFilesSession {
  constructor(private transport: GraphTransport,
              private approvalQueue: RpcStub<ApprovalQueue>) {
    super();
  }

  async #authorizeListing(title: string, entries: FileEntry[]): Promise<void> {
    await this.approvalQueue.authorizeObservation({
      title,
      description: approvalField("Entries", entries.map(e => e.name).join("\n")),
    });
  }

  async listOneDrive(folderId: string): Promise<FileEntry[]> {
    const page = await runGraph(
        files.listChildren(this.transport, { kind: "me" }, folderId));
    await this.#authorizeListing(`List OneDrive folder (${page.entries.length} entries)`,
        page.entries);
    return page.entries;
  }

  async searchOneDrive(query: string): Promise<FileEntry[]> {
    const page = await runGraph(
        files.searchDrive(this.transport, { kind: "me" }, query));
    await this.#authorizeListing(`Search OneDrive: ${query}`, page.entries);
    return page.entries;
  }

  async searchSites(query: string): Promise<SiteInfo[]> {
    const sites = await runGraph(files.searchSites(this.transport, query));
    await this.approvalQueue.authorizeObservation({
      title: `Search SharePoint sites: ${query || "(all)"}`,
      description: approvalField("Sites", sites.map(s => s.name).join("\n")),
    });
    return sites;
  }

  async listSiteDrives(siteId: string): Promise<{ id: string; name: string }[]> {
    const drives = await runGraph(files.listSiteDrives(this.transport, siteId));
    await this.approvalQueue.authorizeObservation({
      title: "List SharePoint document libraries",
      description: approvalField("Libraries", drives.map(d => d.name).join("\n")),
    });
    return drives;
  }

  async listDrive(driveId: string, folderId: string): Promise<FileEntry[]> {
    const page = await runGraph(
        files.listChildren(this.transport, { kind: "drive", driveId }, folderId));
    await this.#authorizeListing(`List drive folder (${page.entries.length} entries)`,
        page.entries);
    return page.entries;
  }

  async searchDrive(driveId: string, query: string): Promise<FileEntry[]> {
    const page = await runGraph(
        files.searchDrive(this.transport, { kind: "drive", driveId }, query));
    await this.#authorizeListing(`Search drive: ${query}`, page.entries);
    return page.entries;
  }

  async getFile(driveId: string | null, itemId: string): Promise<FileEntry> {
    const ref = driveId ? { kind: "drive" as const, driveId } : { kind: "me" as const };
    const entry = await runGraph(files.getItem(this.transport, ref, itemId));
    await this.approvalQueue.authorizeObservation({
      title: `Read file metadata: ${entry.name}`,
      description: approvalField("File", entry.name),
    });
    return entry;
  }

  async readTextContent(driveId: string | null, itemId: string): Promise<string> {
    const ref = driveId ? { kind: "drive" as const, driveId } : { kind: "me" as const };
    const entry = await runGraph(files.getItem(this.transport, ref, itemId));
    const content = await runGraph(files.downloadTextContent(this.transport, ref, itemId));
    await this.approvalQueue.authorizeObservation({
      title: `Read file content: ${entry.name}`,
      description: `Read a file's full text content (${content.length} characters).\n\n` +
          approvalField("File", entry.name),
    });
    return content;
  }
}

// ── Microsoft Teams ─────────────────────────────────────────────────────────

type TeamsAction =
  | { type: "postToChat"; chatId: string; text: string }
  | { type: "postToChannel"; teamId: string; channelId: string; text: string };

const POST_MESSAGE_KIND: ActionKind = {
  tag: "microsoft.teams.message.post", label: "Post Teams messages",
};

export class TeamsGatekeeperImpl extends MicrosoftGatekeeperBase<TeamsAction>
    implements Gatekeeper<TeamsSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "https://teams.microsoft.com/",
      title: "Microsoft Teams",
      snippet: "The connected account's Teams chats and channels",
      suggestedBindingName: "TEAMS",
      tsType: "TeamsSession",
    };
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    // Posting is visible to other people immediately, so it is never auto-approvable.
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<TeamsSession> {
    return new TeamsSessionImpl(this.transport(), approvalQueue.dup(), this.actions());
  }

  async applyAction(actionId: number): Promise<void> {
    const action = this.actions().get(actionId);
    if (!action) throw new Error(`Unknown pending Teams action: ${actionId}`);
    const ref = action.type === "postToChat"
        ? { kind: "chat" as const, chatId: action.chatId }
        : { kind: "channel" as const, teamId: action.teamId, channelId: action.channelId };
    const sent = await runGraph(teams.sendMessage(this.transport(), ref, action.text));
    this.ctx.storage.kv.put(`applied:action:${actionId}`, { messageId: sent.id });
    this.actions().remove(actionId);
  }
}

@validateRpc()
class TeamsSessionImpl extends RpcTarget implements TeamsSession {
  constructor(private transport: GraphTransport,
              private approvalQueue: RpcStub<ApprovalQueue>,
              private actions: PendingActionStore<TeamsAction>) {
    super();
  }

  async listChats(): Promise<TeamsChatInfo[]> {
    const { chats } = await runGraph(teams.listChats(this.transport));
    await this.approvalQueue.authorizeObservation({
      title: `List ${chats.length} Teams chats`,
      description: approvalField("Chats",
          chats.map(c => c.topic || `(${c.chatType})`).join("\n")),
    });
    return chats;
  }

  async listTeams(): Promise<TeamInfo[]> {
    const joined = await runGraph(teams.listJoinedTeams(this.transport));
    await this.approvalQueue.authorizeObservation({
      title: `List ${joined.length} teams`,
      description: approvalField("Teams", joined.map(t => t.name).join("\n")),
    });
    return joined;
  }

  async listChannels(teamId: string): Promise<ChannelInfo[]> {
    const channels = await runGraph(teams.listChannels(this.transport, teamId));
    await this.approvalQueue.authorizeObservation({
      title: `List ${channels.length} channels`,
      description: approvalField("Channels", channels.map(c => c.name).join("\n")),
    });
    return channels;
  }

  async #readMessages(ref: teams.ConversationRef, what: string): Promise<TeamsMessageInfo[]> {
    const page = await runGraph(teams.listMessages(this.transport, ref));
    await this.approvalQueue.authorizeObservation({
      title: `Read ${page.messages.length} Teams messages (${what})`,
      description: approvalField("From", page.messages.map(m => m.from).join(", ")),
    });
    return page.messages;
  }

  async readChat(chatId: string): Promise<TeamsMessageInfo[]> {
    return this.#readMessages({ kind: "chat", chatId }, "chat");
  }

  async readChannel(teamId: string, channelId: string): Promise<TeamsMessageInfo[]> {
    return this.#readMessages({ kind: "channel", teamId, channelId }, "channel");
  }

  async #post(action: TeamsAction, where: string): Promise<{ id: string }> {
    const actionId = this.actions.submit(action);
    await this.approvalQueue.submitAction(actionId, {
      title: `Post Teams message to ${where}`,
      description: "Post a message that is immediately visible to the other participants.\n\n" +
          approvalField("Message", action.text),
      implementsRevert: false,
      awaitDecision: true,
      actionKind: POST_MESSAGE_KIND,
    });
    return { id: `pending-message-${actionId}` };
  }

  async postToChat(chatId: string, text: string): Promise<{ id: string }> {
    return this.#post({ type: "postToChat", chatId, text }, "a chat");
  }

  async postToChannel(teamId: string, channelId: string, text: string): Promise<{ id: string }> {
    return this.#post({ type: "postToChannel", teamId, channelId, text }, "a channel");
  }
}
