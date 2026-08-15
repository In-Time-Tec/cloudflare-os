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

// ── Test doubles ────────────────────────────────────────────────────────────

/** Records every authorizeObservation/submitAction; approvals resolve immediately. */
function fakeApprovalQueue() {
  const observations: { title: string; description: string }[] = [];
  const actions: { id: number; description: { title: string } }[] = [];
  const queue = {
    async authorizeObservation(description: { title: string; description: string }) {
      observations.push(description);
    },
    async submitAction(id: number, description: { title: string }) {
      actions.push({ id, description });
    },
    dup() { return queue; },
  };
  return { queue: queue as never, observations, actions };
}

/** Stub the workerd-global fetch with canned Graph responses keyed by pathname. */
function stubGraph(responses: Record<string, unknown>) {
  const requests: { url: URL; method: string; headers: Headers; body?: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const key = Object.keys(responses).find(k => url.pathname === `/v1.0/${k}`);
    if (!key) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(responses[key]), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return requests;
}

/** Seed a UserAccount DO with a valid unexpired access token, bypassing OAuth. */
async function seedAccount(name: string): Promise<string> {
  const stub = env.TEST_USER_ACCOUNT.getByName(name);
  let id = "";
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.kv.put("accessToken", { token: "seeded-token", expires: Date.now() + 3600_000 });
    state.storage.kv.put("grantedScopes", ["Mail.ReadWrite"]);
    id = state.id.toString();
  });
  return id;
}

/**
 * The capability DOs read ctx.props.userObjectId. vitest-pool-workers test namespaces can't set
 * props, so tests patch the instance's props before use.
 */
async function primeGatekeeper<T extends Rpc.DurableObjectBranded | undefined>(
    stub: DurableObjectStub<T>, userObjectId: string): Promise<void> {
  await runInDurableObject(stub, async (instance: unknown) => {
    (instance as { ctx: { props?: unknown } }).ctx.props = { userObjectId };
  });
}

beforeEach(() => vi.unstubAllGlobals());

// ── Mail ────────────────────────────────────────────────────────────────────

describe("MailboxGatekeeperImpl", () => {
  const MESSAGE = {
    id: "m1", subject: "Hello", bodyPreview: "hi", isRead: false,
    from: { emailAddress: { address: "bob@corp.example" } },
    receivedDateTime: "2026-08-14T12:00:00Z",
  };

  it("lists the inbox as an authorized observation", async () => {
    stubGraph({ "me/mailFolders/inbox/messages": { value: [MESSAGE] } });
    const accountId = await seedAccount("mail-list");
    const gk = env.TEST_MAILBOX.getByName("mail-list");
    await primeGatekeeper(gk, accountId);
    const { queue, observations } = fakeApprovalQueue();

    const result = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(queue);
      const cursor = await session.listInbox();
      const page = await cursor.next();
      return { page, done: await cursor.next() };
    });

    expect(result.page![0]).toMatchObject({ id: "m1", subject: "Hello", isRead: false });
    expect(result.done).toBeNull();
    expect(observations).toHaveLength(1);
    expect(observations[0].title).toContain("1 Outlook messages");
    expect(observations[0].description).toContain("Hello");
  });

  it("stages a draft on submit and creates it only on applyAction", async () => {
    const requests = stubGraph({ "me/messages": { id: "draft-9" } });
    const accountId = await seedAccount("mail-draft");
    const gk = env.TEST_MAILBOX.getByName("mail-draft");
    await primeGatekeeper(gk, accountId);
    const { queue, actions } = fakeApprovalQueue();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(queue);
      const pending = await session.createDraft(["a@x.example"], "Subj", "Body");
      expect(pending.id).toMatch(/^pending-draft-/);
    });

    // Nothing hit Graph at submit time.
    expect(requests.filter(r => r.method === "POST")).toHaveLength(0);
    expect(actions).toHaveLength(1);
    expect(actions[0].description.title).toContain("Subj");

    await runInDurableObject(gk, instance => instance.applyAction(actions[0].id));
    const posts = requests.filter(r => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ subject: "Subj" });
    expect(posts[0].headers.get("Authorization")).toBe("Bearer seeded-token");

    // The action is consumed: applying again fails.
    await expect(runInDurableObject(gk, instance => instance.applyAction(actions[0].id)))
        .rejects.toThrow(/Unknown pending/);
  });

  it("rejectAction discards the staged draft without touching Graph", async () => {
    const requests = stubGraph({});
    const accountId = await seedAccount("mail-reject");
    const gk = env.TEST_MAILBOX.getByName("mail-reject");
    await primeGatekeeper(gk, accountId);
    const { queue, actions } = fakeApprovalQueue();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(queue);
      await session.createDraft(["a@x.example"], "S", "B");
      await instance.rejectAction(actions[0].id);
      await expect(instance.applyAction(actions[0].id)).rejects.toThrow(/Unknown pending/);
    });
    expect(requests).toHaveLength(0);
  });

  it("surfaces expired credentials as the reconnect message", async () => {
    stubGraph({ "me/mailFolders/inbox/messages": { value: [MESSAGE] } });
    // An account with no token and no refresh token yields null from getAccessToken.
    const stub = env.TEST_USER_ACCOUNT.getByName("mail-expired");
    let accountId = "";
    await runInDurableObject(stub, async (_i, state) => { accountId = state.id.toString(); });
    const gk = env.TEST_MAILBOX.getByName("mail-expired");
    await primeGatekeeper(gk, accountId);
    const { queue } = fakeApprovalQueue();

    await expect(runInDurableObject(gk, async instance => {
      const session = await instance.startSession(queue);
      const cursor = await session.listInbox();
      return cursor.next();
    })).rejects.toThrow(/reconnect the account/);
  });

  it("refuses observers: Microsoft-bound workspaces cannot be shared", async () => {
    const gk = env.TEST_MAILBOX.getByName("mail-observer");
    await expect(runInDurableObject(gk,
        instance => instance.addObserver("u1", null as never)))
        .rejects.toThrow(/cannot be shared/);
  });
});

// ── Calendar ────────────────────────────────────────────────────────────────

describe("CalendarGatekeeperImpl", () => {
  it("reads the agenda as one authorized observation", async () => {
    stubGraph({
      "me/calendarView": { value: [{
        id: "e1", subject: "Standup",
        start: { dateTime: "2026-08-15T09:00:00" }, end: { dateTime: "2026-08-15T09:15:00" },
      }] },
    });
    const accountId = await seedAccount("cal-agenda");
    const gk = env.TEST_CALENDAR.getByName("cal-agenda");
    await primeGatekeeper(gk, accountId);
    const { queue, observations } = fakeApprovalQueue();

    const events = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(queue);
      return session.agenda(new Date("2026-08-15T00:00:00Z"), new Date("2026-08-16T00:00:00Z"));
    });
    expect(events[0]).toMatchObject({ subject: "Standup" });
    expect(observations[0].title).toContain("1 calendar events");
  });

  it("stages event creation behind approval; invitations only go out on apply", async () => {
    const requests = stubGraph({ "me/events": { id: "ev-1" } });
    const accountId = await seedAccount("cal-create");
    const gk = env.TEST_CALENDAR.getByName("cal-create");
    await primeGatekeeper(gk, accountId);
    const { queue, actions } = fakeApprovalQueue();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(queue);
      await session.createEvent({
        subject: "Review", start: new Date("2026-08-20T15:00:00Z"),
        end: new Date("2026-08-20T16:00:00Z"), attendees: ["bob@corp.example"],
      });
    });
    expect(requests.filter(r => r.method === "POST")).toHaveLength(0);

    await runInDurableObject(gk, instance => instance.applyAction(actions[0].id));
    const posts = requests.filter(r => r.method === "POST");
    expect(posts[0].body).toMatchObject({ subject: "Review" });
  });

  it("offers calendar action kinds for opt-in auto-approval", async () => {
    const gk = env.TEST_CALENDAR.getByName("cal-kinds");
    const kinds = await runInDurableObject(gk, i => i.getAutoApprovableActions());
    expect(kinds.map(k => k.tag)).toContain("microsoft.calendar.event.create");
  });
});

// ── Files ───────────────────────────────────────────────────────────────────

describe("FilesGatekeeperImpl", () => {
  it("lists OneDrive and reads text content as authorized observations", async () => {
    stubGraph({
      "me/drive/items/root/children": { value: [
        { id: "f1", name: "notes.md", size: 10, file: { mimeType: "text/markdown" } },
      ] },
      "me/drive/items/f1": { id: "f1", name: "notes.md", file: {} },
    });
    const accountId = await seedAccount("files-list");
    const gk = env.TEST_FILES.getByName("files-list");
    await primeGatekeeper(gk, accountId);
    const { queue, observations } = fakeApprovalQueue();

    const entries = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(queue);
      return session.listOneDrive("root");
    });
    expect(entries[0]).toMatchObject({ name: "notes.md", kind: "file" });
    expect(observations[0].description).toContain("notes.md");
  });

  it("rejects unknown action ids", async () => {
    const gk = env.TEST_FILES.getByName("files-readonly");
    await expect(runInDurableObject(gk, i => i.applyAction(999)))
        .rejects.toThrow(/Unknown pending/);
  });
});

// ── Teams ───────────────────────────────────────────────────────────────────

describe("TeamsGatekeeperImpl", () => {
  it("reads a chat and filters system events", async () => {
    stubGraph({
      "me/chats/c1/messages": { value: [
        { id: "m1", messageType: "message", from: { user: { displayName: "Bob" } },
          body: { contentType: "text", content: "hello" } },
        { id: "m2", messageType: "systemEventMessage" },
      ] },
    });
    const accountId = await seedAccount("teams-read");
    const gk = env.TEST_TEAMS.getByName("teams-read");
    await primeGatekeeper(gk, accountId);
    const { queue, observations } = fakeApprovalQueue();

    const messages = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(queue);
      const cursor = await session.readChat("c1");
      return cursor.next();
    });
    expect(messages).toHaveLength(1);
    expect(messages![0]).toMatchObject({ from: "Bob", content: "hello" });
    expect(observations[0].title).toContain("1 Teams messages");
  });

  it("stages channel posts behind approval and posts only on apply", async () => {
    const requests = stubGraph({ "teams/t1/channels/ch1/messages": { id: "sent-1" } });
    const accountId = await seedAccount("teams-post");
    const gk = env.TEST_TEAMS.getByName("teams-post");
    await primeGatekeeper(gk, accountId);
    const { queue, actions } = fakeApprovalQueue();

    await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(queue);
      await session.postToChannel("t1", "ch1", "ship it");
    });
    expect(requests.filter(r => r.method === "POST")).toHaveLength(0);
    expect(actions[0].description.title).toContain("channel");

    await runInDurableObject(gk, instance => instance.applyAction(actions[0].id));
    const posts = requests.filter(r => r.method === "POST");
    expect(posts[0].body).toEqual({ body: { contentType: "text", content: "ship it" } });
  });

  it("offers post and chat-create kinds for opt-in auto-approval", async () => {
    const gk = env.TEST_TEAMS.getByName("teams-kinds");
    const kinds = await runInDurableObject(gk, i => i.getAutoApprovableActions());
    expect(kinds.map(k => k.tag)).toEqual([
      "microsoft.teams.message.post", "microsoft.teams.chat.create",
    ]);
  });
});
