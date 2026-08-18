import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  MailboxGatekeeperImpl, CalendarGatekeeperImpl, FilesGatekeeperImpl, TeamsGatekeeperImpl,
  UserAccount,
} from "../src/microsoft.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
    TEST_MAILBOX: DurableObjectNamespace<MailboxGatekeeperImpl>;
    TEST_CALENDAR: DurableObjectNamespace<CalendarGatekeeperImpl>;
    TEST_FILES: DurableObjectNamespace<FilesGatekeeperImpl>;
    TEST_TEAMS: DurableObjectNamespace<TeamsGatekeeperImpl>;
  }
}

function fakeRecorder() {
  const observations: { title: string; description: string }[] = [];
  const actions: {
    description: { title: string; actionKind: { tag: string } };
    outcome?: { state: "succeeded"; detail?: string }
              | { state: "failed"; error: string; mayHaveTakenEffect: boolean };
  }[] = [];
  const recorder = {
    async authorizeObservation(description: { title: string; description: string }) {
      observations.push(description);
    },
    async authorizeAction(description: { title: string; actionKind: { tag: string } }) {
      const entry: (typeof actions)[number] = { description };
      actions.push(entry);
      return {
        async succeeded(detail?: string) { entry.outcome = { state: "succeeded", detail }; },
        async failed(error: string, mayHaveTakenEffect: boolean) {
          entry.outcome = { state: "failed", error, mayHaveTakenEffect };
        },
      };
    },
    dup() { return recorder; },
  };
  return { recorder: recorder as never, observations, actions };
}

function stubGraph(responses: Record<string, unknown>) {
  const requests: { url: URL; method: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" && headers.get("Content-Type") === "application/json"
          ? JSON.parse(init.body) : init?.body,
    });
    const key = Object.keys(responses).find(k => url.pathname === `/v1.0/${k}`);
    if (key === undefined) return new Response("{}", { status: 404 });
    const value = responses[key];
    if (value === null) return new Response(null, { status: 202 });
    return new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return requests;
}

async function seedAccount(name: string): Promise<string> {
  const stub = env.TEST_USER_ACCOUNT.getByName(name);
  let id = "";
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.kv.put("accessToken", { token: "seeded-token", expires: Date.now() + 3600_000 });
    id = state.id.toString();
  });
  return id;
}

async function primeGatekeeper<T extends Rpc.DurableObjectBranded | undefined>(
    stub: DurableObjectStub<T>, userObjectId: string): Promise<void> {
  await runInDurableObject(stub, async (instance: unknown) => {
    (instance as { ctx: { props?: unknown } }).ctx.props = { userObjectId };
  });
}

beforeEach(() => vi.unstubAllGlobals());

describe("mail sending", () => {
  it("sends inline and records the send", async () => {
    const requests = stubGraph({ "me/sendMail": null });
    const accountId = await seedAccount("mail2-send");
    const gk = env.TEST_MAILBOX.getByName("mail2-send");
    await primeGatekeeper(gk, accountId);
    const { recorder, actions } = fakeRecorder();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      await session.sendMail(["a@x.example"], "Hello", "Body text", { cc: ["c@x.example"] });
    });
    expect(actions[0].description.title).toContain("Send email");
    expect(actions[0].outcome).toMatchObject({ state: "succeeded" });

    const posts = requests.filter(r => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      message: { subject: "Hello" }, saveToSentItems: true,
    });
  });

  it("sends reply / replyAll / forward / sendDraft each as its own action", async () => {
    const requests = stubGraph({
      "me/messages/m1/reply": null,
      "me/messages/m1/replyAll": null,
      "me/messages/m1/forward": null,
      "me/messages/d1/send": null,
    });
    const accountId = await seedAccount("mail2-replies");
    const gk = env.TEST_MAILBOX.getByName("mail2-replies");
    await primeGatekeeper(gk, accountId);
    const { recorder, actions } = fakeRecorder();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      await session.reply("m1", "r");
      await session.replyAll("m1", "ra");
      await session.forward("m1", ["f@x.example"]);
      await session.sendDraft("d1");
    });
    expect(requests.filter(r => r.method === "POST").map(r => r.url.pathname)).toEqual([
      "/v1.0/me/messages/m1/reply",
      "/v1.0/me/messages/m1/replyAll",
      "/v1.0/me/messages/m1/forward",
      "/v1.0/me/messages/d1/send",
    ]);
    expect(actions).toHaveLength(4);
    expect(actions.every(a => a.description.actionKind.tag === "microsoft.mail.send")).toBe(true);
  });

  it("browses folders and reads attachments as observations", async () => {
    stubGraph({
      "me/mailFolders": { value: [{ id: "f1", displayName: "Archive" }] },
      "me/mailFolders/f1/messages": { value: [{ id: "m9", subject: "Archived" }] },
      "me/messages/m9/attachments": { value: [
        { id: "a1", name: "doc.pdf", size: 9,
          "@odata.type": "#microsoft.graph.fileAttachment" },
      ] },
      "me/messages/m9/attachments/a1": { id: "a1", name: "doc.pdf", contentBytes: "QUJD" },
    });
    const accountId = await seedAccount("mail2-folders");
    const gk = env.TEST_MAILBOX.getByName("mail2-folders");
    await primeGatekeeper(gk, accountId);
    const { recorder, observations } = fakeRecorder();

    const result = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      const folders = await session.listFolders();
      const cursor = await session.listFolder("f1");
      const messages = await cursor.next();
      const attachments = await session.listAttachments("m9");
      const content = await session.getAttachment("m9", "a1");
      return { folders, messages, attachments, content };
    });
    expect(result.folders[0].name).toBe("Archive");
    expect(result.messages![0].subject).toBe("Archived");
    expect(result.attachments[0].name).toBe("doc.pdf");
    expect(result.content.base64).toBe("QUJD");
    expect(observations.map(o => o.title)).toEqual([
      "List 1 mail folders",
      "Read 1 Outlook messages (folder: f1)",
      "List 1 attachments",
      "Download attachment: doc.pdf",
    ]);
  });

  it("declares drafting and sending as separate kinds", async () => {
    const gk = env.TEST_MAILBOX.getByName("mail2-kinds");
    const catalog = await runInDurableObject(gk, i => i.getActionCatalog());
    expect(catalog.map(c => c.kind.tag)).toEqual([
      "microsoft.mail.draft.create", "microsoft.mail.send",
    ]);
    expect(catalog[0].risk).toEqual({
      reversible: "automatic", reach: "creates-content", audience: "private", freeform: true,
    });
    expect(catalog[1].risk).toEqual({
      reversible: "no", reach: "acts-on-world", audience: "external", freeform: true,
    });
  });
});

describe("chaining one action onto another's result", () => {
  it("sends the draft the previous call actually created", async () => {
    const requests = stubGraph({
      "me/messages": { id: "real-draft-42" },
      "me/messages/real-draft-42/send": null,
    });
    const accountId = await seedAccount("mail2-chain");
    const gk = env.TEST_MAILBOX.getByName("mail2-chain");
    await primeGatekeeper(gk, accountId);
    const { recorder } = fakeRecorder();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      const draft = await session.createDraft(["a@x.example"], "Chained", "B");
      await session.sendDraft(draft.id);
    });
    const posts = requests.filter(r => r.method === "POST").map(r => r.url.pathname);
    expect(posts).toEqual(["/v1.0/me/messages", "/v1.0/me/messages/real-draft-42/send"]);
  });

  it("uploads into the folder the previous call actually created", async () => {
    const requests = stubGraph({
      "me/drive/items/root/children": { id: "real-folder-7", name: "Reports", folder: {} },
      "me/drive/items/real-folder-7:/notes.md:/content":
          { id: "up1", name: "notes.md", file: {} },
    });
    const accountId = await seedAccount("files2-chain");
    const gk = env.TEST_FILES.getByName("files2-chain");
    await primeGatekeeper(gk, accountId);
    const { recorder } = fakeRecorder();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      const folder = await session.createFolder(null, "root", "Reports");
      await session.uploadFile(null, folder.id, "notes.md", "# hi");
    });
    const writes = requests.filter(r => r.method !== "GET").map(r => r.url.pathname);
    expect(writes).toEqual([
      "/v1.0/me/drive/items/root/children",
      "/v1.0/me/drive/items/real-folder-7:/notes.md:/content",
    ]);
  });
});

describe("calendar management", () => {
  it("updates, cancels, and responds, each through Graph immediately", async () => {
    const requests = stubGraph({
      "me/events/e1": { id: "e1" },       // PATCH + DELETE
      "me/events/e2/accept": null,
    });
    const accountId = await seedAccount("cal2-manage");
    const gk = env.TEST_CALENDAR.getByName("cal2-manage");
    await primeGatekeeper(gk, accountId);
    const { recorder, actions } = fakeRecorder();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      await session.updateEvent("e1", { subject: "Moved" });
      await session.cancelEvent("e1");
      await session.respondToEvent("e2", "accept", "see you there");
    });
    expect(actions.map(a => a.description.actionKind.tag)).toEqual([
      "microsoft.calendar.event.modify",
      "microsoft.calendar.event.modify",
      "microsoft.calendar.event.respond",
    ]);
    expect(requests.filter(r => r.method !== "GET").map(r => [r.method, r.url.pathname]))
        .toEqual([
          ["PATCH", "/v1.0/me/events/e1"],
          ["DELETE", "/v1.0/me/events/e1"],
          ["POST", "/v1.0/me/events/e2/accept"],
        ]);
    expect(requests.find(r => r.method === "POST")!.body)
        .toEqual({ sendResponse: true, comment: "see you there" });
  });

  it("declares every calendar kind it can record", async () => {
    const gk = env.TEST_CALENDAR.getByName("cal2-kinds");
    const catalog = await runInDurableObject(gk, i => i.getActionCatalog());
    expect(catalog.map(c => c.kind.tag)).toEqual([
      "microsoft.calendar.event.create",
      "microsoft.calendar.event.modify",
      "microsoft.calendar.event.respond",
    ]);
  });
});

describe("files writes", () => {
  it("creates, uploads, replaces, and deletes through Graph inline", async () => {
    const requests = stubGraph({
      "me/drive/items/root/children": { id: "nf1", name: "Reports", folder: {} },
      "me/drive/items/root:/notes.md:/content": { id: "file1", name: "notes.md", file: {} },
      "me/drive/items/file1/content": { id: "file1", name: "notes.md", file: {} },
      "me/drive/items/file1": { id: "file1", name: "notes.md", file: {} },  // getItem + DELETE
    });
    const accountId = await seedAccount("files2-write");
    const gk = env.TEST_FILES.getByName("files2-write");
    await primeGatekeeper(gk, accountId);
    const { recorder, actions } = fakeRecorder();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      await session.createFolder(null, "root", "Reports");
      await session.uploadFile(null, "root", "notes.md", "# hi", "text/markdown");
      await session.replaceFileContent(null, "file1", "# v2");
      await session.deleteFile(null, "file1");
    });
    expect(requests.filter(r => r.method !== "GET").map(r => [r.method, r.url.pathname]))
        .toEqual([
          ["POST", "/v1.0/me/drive/items/root/children"],
          ["PUT", "/v1.0/me/drive/items/root:/notes.md:/content"],
          ["PUT", "/v1.0/me/drive/items/file1/content"],
          ["DELETE", "/v1.0/me/drive/items/file1"],
        ]);
    expect(actions.map(a => a.description.title)).toEqual([
      "Create folder: Reports",
      "Create file: notes.md",
      "Replace file content: notes.md",
      "Delete: notes.md",
    ]);
  });

  it("lists shared files and downloads binary content as observations", async () => {
    stubGraph({
      "me/drive/sharedWithMe": { value: [
        { id: "w1", remoteItem: { id: "r1", name: "Plan.docx",
          parentReference: { driveId: "d9" } } },
      ] },
      "me/drive/items/bin1": { id: "bin1", name: "logo.png", file: {} },
      "me/drive/items/bin1/content": null,  // replaced below
    });
    // downloadContent hits .../content with raw bytes; override the stub for that path.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/bin1/content")) {
        return new Response(new Uint8Array([137, 80, 78, 71]));
      }
      return realFetch(input, init);
    });
    const accountId = await seedAccount("files2-shared");
    const gk = env.TEST_FILES.getByName("files2-shared");
    await primeGatekeeper(gk, accountId);
    const { recorder, observations } = fakeRecorder();

    const result = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      const shared = await session.listSharedWithMe();
      const content = await session.readContent(null, "bin1");
      return { shared, content };
    });
    expect(result.shared[0]).toMatchObject({ id: "r1", name: "Plan.docx", driveId: "d9" });
    expect(result.content.name).toBe("logo.png");
    expect(Uint8Array.fromBase64(result.content.base64)[0]).toBe(137);
    expect(observations.some(o => o.title.startsWith("Download file: logo.png"))).toBe(true);
  });
});

describe("teams chats", () => {
  it("pages chats and messages through cursors", async () => {
    stubGraph({
      "me/chats": {
        value: [{ id: "c1", chatType: "oneOnOne" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?$skip=1",
      },
      "me/chats/c1/messages": {
        value: [{ id: "m1", messageType: "message",
                  from: { user: { displayName: "Bob" } },
                  body: { content: "hi" } }],
      },
    });
    const accountId = await seedAccount("teams2-page");
    const gk = env.TEST_TEAMS.getByName("teams2-page");
    await primeGatekeeper(gk, accountId);
    const { recorder } = fakeRecorder();

    const result = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      const chats = await session.listChats();
      const first = await chats.next();
      const messages = await (await session.readChat("c1")).next();
      return { first, messages };
    });
    expect(result.first![0].id).toBe("c1");
    expect(result.messages![0].content).toBe("hi");
  });

  it("creates a chat inline, binding the signed-in user from their profile", async () => {
    const requests = stubGraph({
      "me": { id: "self-oid", displayName: "Me" },
      "chats": { id: "new-chat" },
    });
    const accountId = await seedAccount("teams2-create");
    const gk = env.TEST_TEAMS.getByName("teams2-create");
    await primeGatekeeper(gk, accountId);
    const { recorder, actions } = fakeRecorder();

    const chat = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      return session.createChat(["bob@corp.example"]);
    });
    expect(chat.id).toBe("new-chat");
    expect(actions[0].outcome).toEqual({ state: "succeeded", detail: "Chat id: new-chat" });
    const post = requests.find(r => r.method === "POST");
    expect(post!.body).toMatchObject({ chatType: "oneOnOne" });
  });
});
