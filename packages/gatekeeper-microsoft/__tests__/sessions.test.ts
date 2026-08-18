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

/**
 * Records every authorizeObservation/authorizeAction, and the outcome reported on each action's
 * handle. Every action is authorized; `refuse` makes authorizeAction throw instead, standing in
 * for a kind an administrator disabled.
 */
function fakeRecorder(options?: { refuse?: string }) {
  const observations: { title: string; description: string }[] = [];
  const actions: {
    description: { title: string; description: string; actionKind: { tag: string } };
    outcome?: { state: "succeeded"; detail?: string }
              | { state: "failed"; error: string; mayHaveTakenEffect: boolean };
  }[] = [];
  const recorder = {
    async authorizeObservation(description: { title: string; description: string }) {
      observations.push(description);
    },
    async authorizeAction(
        description: { title: string; description: string; actionKind: { tag: string } }) {
      if (options?.refuse) throw new Error(options.refuse);
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
    const { recorder, observations } = fakeRecorder();

    const result = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
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

  it("creates a draft inline and returns the real id", async () => {
    const requests = stubGraph({ "me/messages": { id: "draft-9" } });
    const accountId = await seedAccount("mail-draft");
    const gk = env.TEST_MAILBOX.getByName("mail-draft");
    await primeGatekeeper(gk, accountId);
    const { recorder, actions } = fakeRecorder();

    const draft = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      return session.createDraft(["a@x.example"], "Subj", "Body");
    });

    expect(draft.id).toBe("draft-9");
    const posts = requests.filter(r => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ subject: "Subj" });
    expect(posts[0].headers.get("Authorization")).toBe("Bearer seeded-token");
    expect(actions).toHaveLength(1);
    expect(actions[0].description.title).toContain("Subj");
    expect(actions[0].description.actionKind.tag).toBe("microsoft.mail.draft.create");
    expect(actions[0].outcome).toEqual({ state: "succeeded", detail: "Draft id: draft-9" });
  });

  it("performs nothing when authorization refuses the action", async () => {
    const requests = stubGraph({ "me/messages": { id: "draft-9" } });
    const accountId = await seedAccount("mail-refused");
    const gk = env.TEST_MAILBOX.getByName("mail-refused");
    await primeGatekeeper(gk, accountId);
    const { recorder } = fakeRecorder({ refuse: "Drafting is disabled on this deployment." });

    await expect(runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      return session.createDraft(["a@x.example"], "S", "B");
    })).rejects.toThrow(/disabled on this deployment/);
    expect(requests).toHaveLength(0);
  });

  it("records a failed send as possibly having taken effect", async () => {
    // A 500 from Graph leaves the outcome unknown: the request was already sent.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const accountId = await seedAccount("mail-failed");
    const gk = env.TEST_MAILBOX.getByName("mail-failed");
    await primeGatekeeper(gk, accountId);
    const { recorder, actions } = fakeRecorder();

    await expect(runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      return session.sendMail(["a@x.example"], "S", "B");
    })).rejects.toThrow(/temporarily unavailable/);
    expect(actions[0].outcome).toMatchObject({ state: "failed", mayHaveTakenEffect: true });
  });

  it("surfaces expired credentials as the reconnect message", async () => {
    stubGraph({ "me/mailFolders/inbox/messages": { value: [MESSAGE] } });
    // An account with no token and no refresh token yields null from getAccessToken.
    const stub = env.TEST_USER_ACCOUNT.getByName("mail-expired");
    let accountId = "";
    await runInDurableObject(stub, async (_i, state) => { accountId = state.id.toString(); });
    const gk = env.TEST_MAILBOX.getByName("mail-expired");
    await primeGatekeeper(gk, accountId);
    const { recorder } = fakeRecorder();

    await expect(runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
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
    const { recorder, observations } = fakeRecorder();

    const events = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      return session.agenda(new Date("2026-08-15T00:00:00Z"), new Date("2026-08-16T00:00:00Z"));
    });
    expect(events[0]).toMatchObject({ subject: "Standup" });
    expect(observations[0].title).toContain("1 calendar events");
  });

  it("creates an event inline and records the new event id", async () => {
    const requests = stubGraph({ "me/events": { id: "ev-1" } });
    const accountId = await seedAccount("cal-create");
    const gk = env.TEST_CALENDAR.getByName("cal-create");
    await primeGatekeeper(gk, accountId);
    const { recorder, actions } = fakeRecorder();

    const event = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      return session.createEvent({
        subject: "Review", start: new Date("2026-08-20T15:00:00Z"),
        end: new Date("2026-08-20T16:00:00Z"), attendees: ["bob@corp.example"],
      });
    });
    expect(event.id).toBe("ev-1");
    const posts = requests.filter(r => r.method === "POST");
    expect(posts[0].body).toMatchObject({ subject: "Review" });
    expect(actions[0].outcome).toEqual({ state: "succeeded", detail: "Event id: ev-1" });
  });

  it("declares every calendar kind it can record, with its risk", async () => {
    const gk = env.TEST_CALENDAR.getByName("cal-kinds");
    const catalog = await runInDurableObject(gk, i => i.getActionCatalog());
    expect(catalog.map(c => c.kind.tag)).toContain("microsoft.calendar.event.create");
    expect(catalog.every(c => c.summary.length > 0)).toBe(true);
    expect(catalog.find(c => c.kind.tag === "microsoft.calendar.event.modify")!.risk)
        .toEqual({
          reversible: "no", reach: "modifies-content", audience: "external", freeform: true,
        });
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
    const { recorder, observations } = fakeRecorder();

    const entries = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      return session.listOneDrive("root");
    });
    expect(entries[0]).toMatchObject({ name: "notes.md", kind: "file" });
    expect(observations[0].description).toContain("notes.md");
  });

  it("separates writing files from deleting them in its catalog", async () => {
    const gk = env.TEST_FILES.getByName("files-kinds");
    const catalog = await runInDurableObject(gk, i => i.getActionCatalog());
    expect(catalog.map(c => c.kind.tag))
        .toEqual(["microsoft.files.write", "microsoft.files.delete"]);
    expect(catalog[1].risk.freeform).toBe(false);
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
    const { recorder, observations } = fakeRecorder();

    const messages = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      const cursor = await session.readChat("c1");
      return cursor.next();
    });
    expect(messages).toHaveLength(1);
    expect(messages![0]).toMatchObject({ from: "Bob", content: "hello" });
    expect(observations[0].title).toContain("1 Teams messages");
  });

  it("posts to a channel inline and returns the provider message id", async () => {
    const requests = stubGraph({ "teams/t1/channels/ch1/messages": { id: "sent-1" } });
    const accountId = await seedAccount("teams-post");
    const gk = env.TEST_TEAMS.getByName("teams-post");
    await primeGatekeeper(gk, accountId);
    const { recorder, actions } = fakeRecorder();

    const sent = await runInDurableObject(gk, async instance => {
      const session = await instance.startSession(recorder);
      return session.postToChannel("t1", "ch1", "ship it");
    });
    expect(sent.id).toBe("sent-1");
    expect(actions[0].description.title).toContain("channel");
    expect(actions[0].outcome).toEqual({ state: "succeeded", detail: "Message id: sent-1" });
    const posts = requests.filter(r => r.method === "POST");
    expect(posts[0].body).toEqual({ body: { contentType: "text", content: "ship it" } });
  });

  it("declares posting and chat creation with different reach", async () => {
    const gk = env.TEST_TEAMS.getByName("teams-kinds");
    const catalog = await runInDurableObject(gk, i => i.getActionCatalog());
    expect(catalog.map(c => c.kind.tag)).toEqual([
      "microsoft.teams.message.post", "microsoft.teams.chat.create",
    ]);
    expect(catalog[0].risk.reach).toBe("acts-on-world");
    expect(catalog[1].risk.reach).toBe("creates-content");
  });
});
