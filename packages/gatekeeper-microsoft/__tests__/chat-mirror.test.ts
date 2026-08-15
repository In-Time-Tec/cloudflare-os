import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ChatMirror, UserAccount } from "../src/microsoft.js";
import { sanitizeTeamsHtml } from "../src/sanitize.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
    TEST_CHAT_MIRROR: DurableObjectNamespace<ChatMirror>;
  }
}

function stubGraph(responses: Record<string, unknown>) {
  const requests: { url: URL; method: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    // POSTs answer with a created-id payload keyed "POST <path>", falling back to a plain id.
    if (method === "POST") {
      const postKey = Object.keys(responses).find(k => `POST /v1.0/${k.slice(5)}` ===
          `POST ${url.pathname}` && k.startsWith("POST "));
      return new Response(JSON.stringify(postKey ? responses[postKey] : { id: "created-1" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const key = Object.keys(responses).find(k => url.pathname === `/v1.0/${k}`);
    if (key === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(responses[key]), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return requests;
}

async function seededMirror(name: string): Promise<DurableObjectStub<ChatMirror>> {
  const account = env.TEST_USER_ACCOUNT.getByName(name);
  let accountId = "";
  await runInDurableObject(account, async (_i, state) => {
    state.storage.kv.put("accessToken", { token: "tok", expires: Date.now() + 3600_000 });
    accountId = state.id.toString();
  });
  const mirror = env.TEST_CHAT_MIRROR.getByName(name);
  await mirror.configure(accountId, "self-oid");
  return mirror;
}

beforeEach(() => vi.unstubAllGlobals());

describe("sanitizeTeamsHtml", () => {
  it("strips scripts, event handlers, and unsafe URLs but keeps content", async () => {
    const dirty = `<p onclick="evil()">Hi <b>there</b></p>` +
        `<script>steal()</script>` +
        `<a href="javascript:alert(1)">bad</a>` +
        `<a href="https://ok.example/x">good</a>` +
        `<img src="data:image/png;base64,xxx">`;
    const clean = await sanitizeTeamsHtml(dirty);
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("data:image");
    expect(clean).toContain("Hi <b>there</b>");
    expect(clean).toContain('href="https://ok.example/x"');
    expect(clean).toContain('rel="noopener noreferrer"');
  });
});

describe("ChatMirror", () => {
  const CHAT = {
    id: "19:chat1",
    chatType: "oneOnOne",
    members: [
      { displayName: "Me", userId: "self-oid" },
      { displayName: "Cody Wirth", userId: "cody-oid" },
    ],
    lastMessagePreview: {
      createdDateTime: "2026-08-15T12:00:00Z",
      body: { contentType: "text", content: "yo" },
      from: { user: { displayName: "Cody Wirth" } },
    },
  };

  it("hydrates chats titled by the other member and channels from associated teams", async () => {
    stubGraph({
      "me/chats": { value: [CHAT] },
      "me/teamwork/associatedTeams": { value: [{ id: "t1", displayName: "ITT" }] },
      "teams/t1/channels": { value: [{ id: "ch1", displayName: "General" }] },
    });
    const mirror = await seededMirror("mirror-hydrate");
    const conversations = await mirror.listConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].title).toBe("Cody Wirth");
    expect(conversations[0].members).toEqual([{ name: "Cody Wirth", userId: "cody-oid" }]);
    expect(conversations[0].lastMessage?.preview).toBe("yo");

    const channels = await mirror.listChannels();
    expect(channels[0]).toMatchObject({ title: "General", subtitle: "ITT" });
  });

  it("serves messages from Graph, marks own messages, and sends directly", async () => {
    const requests = stubGraph({
      "me/chats": { value: [CHAT] },
      "me/teamwork/associatedTeams": { value: [] },
      "me/chats/19:chat1/messages": { value: [
        { id: "m1", messageType: "message",
          from: { user: { displayName: "Cody Wirth", id: "cody-oid" } },
          createdDateTime: "2026-08-15T12:00:00Z",
          body: { contentType: "html", content: "<p>hello <script>x</script></p>" } },
        { id: "m2", messageType: "message",
          from: { user: { displayName: "Me", id: "self-oid" } },
          createdDateTime: "2026-08-15T12:01:00Z",
          body: { contentType: "text", content: "hi <b>not html</b>" } },
      ] },
    });
    const mirror = await seededMirror("mirror-messages");
    const { messages } = await mirror.getMessages({ kind: "chat", chatId: "19:chat1" });
    expect(messages).toHaveLength(2);
    expect(messages[0].html).toContain("hello");
    expect(messages[0].html).not.toContain("script");
    expect(messages[0].fromSelf).toBe(false);
    expect(messages[1].fromSelf).toBe(true);
    // Plain-text bodies are escaped, not interpreted.
    expect(messages[1].html).toContain("&lt;b&gt;");

    const sent = await mirror.sendMessage({ kind: "chat", chatId: "19:chat1" }, "reply!");
    expect(sent.id).toBeDefined();
    const post = requests.find(r => r.method === "POST");
    expect(post!.url.pathname).toBe("/v1.0/me/chats/19:chat1/messages");
  });

  it("ingests a notification exactly once and skips duplicates", async () => {
    stubGraph({
      "me/chats": { value: [CHAT] },
      "me/teamwork/associatedTeams": { value: [] },
      "me/chats/19:chat1/messages": { value: [] },
      "chats/19:chat1/messages/msg-9": {
        id: "msg-9", messageType: "message",
        from: { user: { displayName: "Cody Wirth", id: "cody-oid" } },
        createdDateTime: "2026-08-15T13:00:00Z",
        body: { contentType: "text", content: "ding" },
      },
    });
    const mirror = await seededMirror("mirror-ingest");
    await mirror.listConversations();  // hydrate so the conversation row exists
    await mirror.ingest("chats('19:chat1')/messages('msg-9')");
    await mirror.ingest("chats('19:chat1')/messages('msg-9')");  // duplicate doorbell
    const { messages } = await runInDurableObject(env.TEST_CHAT_MIRROR.getByName("mirror-ingest"),
        instance => instance.getMessages({ kind: "chat", chatId: "19:chat1" }));
    expect(messages.filter(m => m.id === "msg-9")).toHaveLength(1);

    const conversations = await mirror.listConversations();
    expect(conversations[0].lastMessage?.preview).toBe("ding");
  });

  it("subscribes active chats per-chat with clientState carrying the mirror id", async () => {
    const requests = stubGraph({
      "me/chats": { value: [CHAT] },
      "me/teamwork/associatedTeams": { value: [] },
      "POST /subscriptions": { id: "sub-1", resource: "/chats/19:chat1/messages",
                               expirationDateTime: "2026-08-18T00:00:00Z" },
    });
    const mirror = await seededMirror("mirror-subs");
    await mirror.listConversations();  // hydrate so the chat is known
    await mirror.ensureSubscriptions("https://example.test/gatekeeper/microsoft");
    const post = requests.find(r => r.method === "POST" && r.url.pathname === "/v1.0/subscriptions");
    expect(post!.body).toMatchObject({
      resource: "/chats/19:chat1/messages",
      notificationUrl: "https://example.test/gatekeeper/microsoft/notifications",
      includeResourceData: false,
    });
    const clientState = (post!.body as { clientState: string }).clientState;
    expect(await mirror.verifyClientState(clientState)).toBe(true);
    expect(await mirror.verifyClientState("bogus")).toBe(false);
  });

  it("mints one-time socket tokens", async () => {
    const mirror = await seededMirror("mirror-ws");
    const token = await mirror.mintSocketToken();
    expect(await mirror.consumeSocketToken(token)).toBe(true);
    // One-time: a second consumption fails, as does garbage.
    expect(await mirror.consumeSocketToken(token)).toBe(false);
    expect(await mirror.consumeSocketToken("bogus")).toBe(false);
  });
});
