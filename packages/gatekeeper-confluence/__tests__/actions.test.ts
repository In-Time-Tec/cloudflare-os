import { describe, expect, it } from "vitest";
import {
  ConfluenceStore,
  performAction,
  type ConfluenceAction,
} from "../src/confluence-actions";
import type { ConfluenceApi } from "../src/confluence-api";
import type { ActionRecorder } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "cloudflare:workers";

type Kv = ConstructorParameters<typeof ConfluenceStore>[0];

// Minimal in-memory KV matching the slice of the DO storage API the store uses.
function makeKv(): Kv {
  const map = new Map<string, unknown>();
  return {
    get: <T>(k: string) => map.get(k) as T | undefined,
    put: (k: string, v: unknown) => void map.set(k, v),
    delete: (k: string) => void map.delete(k),
  } as unknown as Kv;
}

type Recorded = {
  addComment: { id: string; type: string }[];
  updateContent: { title: string; status?: string }[];
};

// Fake API recording the calls performAction makes. `contentType` controls what getContentById
// reports; `status` controls whether the target page reads back as a draft or a published page.
function makeApi(contentType: "page" | "blogpost" = "page", status: string = "current") {
  const calls: Recorded = { addComment: [], updateContent: [] };
  const api = {
    getContentById: async (id: string) => ({
      id, type: contentType, status, title: "Title", version: { number: 3 },
      body: { storage: { value: "<p>body</p>" } },
      _links: { webui: "/spaces/ENG/pages/" + id },
    }),
    updateContent: async (b: { title: string; status?: string }) => { calls.updateContent.push(b); return {}; },
    addComment: async (id: string, _storage: string, type: string) => {
      calls.addComment.push({ id, type });
      return { id: "comment-1" };
    },
    trashContent: async () => {},
    restoreContent: async () => {},
  } as unknown as ConfluenceApi;
  return { api, calls };
}

// Records which outcome the action reported, so a test can assert the handle was closed exactly once.
function makeRecorder() {
  const outcomes: string[] = [];
  const recorder = {
    authorizeAction: async () => ({
      succeeded: async () => void outcomes.push("succeeded"),
      failed: async (error: string) => void outcomes.push(`failed: ${error}`),
    }),
  } as unknown as RpcStub<ActionRecorder>;
  return { recorder, outcomes };
}

function run(api: ConfluenceApi, action: ConfluenceAction) {
  const { recorder, outcomes } = makeRecorder();
  return { outcomes, done: performAction(new ConfluenceStore(makeKv(), api), recorder, action) };
}

describe("performAction", () => {
  it("reports success once the action reaches Confluence", async () => {
    const { api } = makeApi();
    const { outcomes, done } = run(api, { type: "setTitle", contentId: "123", title: "New" });

    await done;

    expect(outcomes).toEqual(["succeeded"]);
  });

  it("reports failure, as possibly having taken effect, when Confluence rejects it", async () => {
    const { api } = makeApi();
    api.updateContent = async () => { throw new Error("boom"); };
    const { outcomes, done } = run(api, { type: "setTitle", contentId: "123", title: "New" });

    await expect(done).rejects.toThrow("boom");
    expect(outcomes).toEqual(["failed: boom"]);
  });

  it("posts blog-post comments with a blogpost container type", async () => {
    const { api, calls } = makeApi("blogpost");

    await run(api, { type: "addComment", contentId: "555", text: "hi" }).done;

    expect(calls.addComment).toEqual([{ id: "555", type: "blogpost" }]);
  });

  it("posts page comments with a page container type", async () => {
    const { api, calls } = makeApi("page");

    await run(api, { type: "addComment", contentId: "555", text: "hi" }).done;

    expect(calls.addComment).toEqual([{ id: "555", type: "page" }]);
  });

  it("keeps a draft page a draft when editing its content (does not publish it)", async () => {
    const { api, calls } = makeApi("page", "draft");

    await run(api, { type: "setContent", contentId: "123", markdown: "new" }).done;

    expect(calls.updateContent).toHaveLength(1);
    expect(calls.updateContent[0].status).toBe("draft");
  });

  it("publishes edits to a current page as current", async () => {
    const { api, calls } = makeApi("page", "current");

    await run(api, { type: "setContent", contentId: "123", markdown: "new" }).done;

    expect(calls.updateContent[0].status).toBe("current");
  });
});
