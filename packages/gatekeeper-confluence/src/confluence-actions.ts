// Action machinery for the Confluence gatekeeper: the action model, its action kinds and
// descriptions, response caching, and the code that performs each action against Confluence.
//
// Reads are served from a short-TTL cache of what Confluence returned; an action invalidates the
// cache entries it affects, so the next read reflects it.

import type { RpcStub } from "cloudflare:workers";
import type {
  ActionCapability,
  ActionDescription,
  ActionKind,
  ActionRecorder,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ConfluenceApi,
  contentBodyMarkdown,
  contentToSummary,
  type ContentResponse,
} from "./confluence-api";
import { markdownToStorage, storageToMarkdown } from "./confluence-markdown";
import type { ContentType } from "./types";

// ---------------------------------------------------------------------------------------------
// Action model

export type ContentParent =
  | { type: "space"; spaceKey: string }
  | { type: "page"; parentId: string; spaceKey?: string };

export type ConfluenceAction =
  | {
      type: "createContent";
      kind: ContentType;
      parent: ContentParent;
      title: string;
      content?: string;
      status: "current" | "draft";
    }
  | { type: "setContent"; contentId: string; markdown: string }
  | { type: "appendContent"; contentId: string; markdown: string }
  | { type: "setTitle"; contentId: string; title: string }
  | { type: "addComment"; contentId: string; text: string }
  | { type: "addLabel"; contentId: string; name: string }
  | { type: "removeLabel"; contentId: string; name: string }
  | {
      type: "uploadAttachment";
      contentId: string;
      filename: string;
      mediaType: string;
      data: Uint8Array;
      comment?: string;
    }
  | { type: "trash"; contentId: string }
  | { type: "restore"; contentId: string };

// ---------------------------------------------------------------------------------------------
// Action kinds
//
// Confluence content is visible to everyone with access to its space, and Confluence sends
// watchers a notification for an edit or a comment. Page history keeps prior versions, but
// restoring one is a person's decision, so nothing here reverts automatically.

const CREATE_CONTENT: ActionKind = {
  tag: "confluence.createContent", label: "Create page/blog post",
};
const EDIT_CONTENT: ActionKind = { tag: "confluence.editContent", label: "Edit page content" };
const SET_TITLE: ActionKind = { tag: "confluence.setTitle", label: "Rename content" };
const ADD_COMMENT: ActionKind = { tag: "confluence.addComment", label: "Add comment" };
const LABEL: ActionKind = { tag: "confluence.label", label: "Add/remove label" };
const UPLOAD_ATTACHMENT: ActionKind = {
  tag: "confluence.uploadAttachment", label: "Upload attachment",
};
const TRASH: ActionKind = { tag: "confluence.trash", label: "Trash content" };

/** Every side-effecting operation this gatekeeper performs, for consent and deployment policy. */
export const ACTION_CATALOG: ActionCapability[] = [
  {
    kind: CREATE_CONTENT,
    summary: "Create pages and blog posts in the granted space",
    risk: {
      reversible: "manual", reach: "creates-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: EDIT_CONTENT,
    summary: "Replace or append to the body of an existing page or blog post",
    risk: {
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: SET_TITLE,
    summary: "Rename a page or blog post",
    risk: {
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: ADD_COMMENT,
    summary: "Post a comment, notifying the content's watchers",
    risk: {
      reversible: "manual", reach: "creates-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: LABEL,
    summary: "Add or remove a label on a page or blog post",
    risk: {
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: UPLOAD_ATTACHMENT,
    summary: "Attach a file to a page or blog post",
    risk: {
      reversible: "manual", reach: "creates-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: TRASH,
    summary: "Move a page or blog post to the trash, or restore one from it",
    risk: {
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: false,
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Response cache (backed by the gatekeeper DO's KV storage)

type Kv = DurableObjectStorage["kv"];
const CONTENT_TTL_MS = 30_000;

type ContentCache = { fetchedAt: number; content: ContentResponse };

export class ConfluenceStore {
  #kv: Kv;
  #api: ConfluenceApi;

  constructor(kv: Kv, api: ConfluenceApi) {
    this.#kv = kv;
    this.#api = api;
  }

  get api(): ConfluenceApi {
    return this.#api;
  }

  async getContentResponse(id: string, bypassCache = false): Promise<ContentResponse> {
    if (!bypassCache) {
      const cached = this.#kv.get<ContentCache>(`cache:content:${id}`);
      if (cached && Date.now() - cached.fetchedAt < CONTENT_TTL_MS) return cached.content;
    }
    const content = await this.#api.getContentById(id);
    this.#kv.put<ContentCache>(`cache:content:${id}`, { fetchedAt: Date.now(), content });
    return content;
  }

  /** The kind (page vs blog post) of a piece of content, resolved (and cached) via its response. */
  async getContentKind(id: string): Promise<ContentType> {
    return contentKindOf(await this.getContentResponse(id));
  }

  /** Resolve a space key to its numeric v2 space ID (cached). */
  async getSpaceId(key: string): Promise<string> {
    const cached = this.#kv.get<string>(`space:${key}`);
    if (cached) return cached;
    const space = await this.#api.getSpaceByKey(key);
    this.#kv.put(`space:${key}`, space.id);
    return space.id;
  }

  invalidateContent(id: string): void {
    this.#kv.delete(`cache:content:${id}`);
  }
}

const contentKindOf = (c: ContentResponse): ContentType => (c.type === "blogpost" ? "blogpost" : "page");

// ---------------------------------------------------------------------------------------------
// Observation / action descriptions

export function observation(title: string, description: string): ObservationDescription {
  return { title, description };
}

function describeAction(action: ConfluenceAction): ActionDescription {
  switch (action.type) {
    case "createContent":
      return {
        title: `Create Confluence ${action.kind === "blogpost" ? "blog post" : "page"}`,
        description: `Create a new ${action.kind === "blogpost" ? "blog post" : "page"} titled **${action.title}**` +
          (action.parent.type === "page" ? " as a child page." : ` in space ${action.parent.spaceKey}.`),
        actionKind: CREATE_CONTENT,
      };
    case "setContent":
      return {
        title: "Replace Confluence page content",
        description: `Replace the body with:\n\n${truncate(action.markdown)}`,
        actionKind: EDIT_CONTENT,
      };
    case "appendContent":
      return {
        title: "Append to Confluence page",
        description: `Append to the body:\n\n${truncate(action.markdown)}`,
        actionKind: EDIT_CONTENT,
      };
    case "setTitle":
      return {
        title: "Rename Confluence content",
        description: `Change the title to **${action.title}**.`,
        actionKind: SET_TITLE,
      };
    case "addComment":
      return {
        title: "Comment on Confluence content",
        description: `Post a comment:\n\n${truncate(action.text)}`,
        actionKind: ADD_COMMENT,
      };
    case "addLabel":
      return {
        title: "Add label to Confluence content",
        description: `Add the label \`${action.name}\`.`,
        actionKind: LABEL,
      };
    case "removeLabel":
      return {
        title: "Remove label from Confluence content",
        description: `Remove the label \`${action.name}\`.`,
        actionKind: LABEL,
      };
    case "uploadAttachment":
      return {
        title: "Upload attachment to Confluence",
        description: `Upload **${action.filename}** (${action.mediaType}, ${action.data.byteLength} bytes).`,
        actionKind: UPLOAD_ATTACHMENT,
      };
    case "trash":
      return {
        title: "Move Confluence content to trash",
        description: "Move this content to the trash (reversible).",
        actionKind: TRASH,
      };
    case "restore":
      return {
        title: "Restore Confluence content from trash",
        description: "Restore this content from the trash.",
        actionKind: TRASH,
      };
  }
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ---------------------------------------------------------------------------------------------
// Action execution

/**
 * The status to send when updating a page/blog post. Preserves an existing draft so that editing
 * a draft doesn't publish it: `updateContent` defaults status to "current", and passing "current"
 * for a draft transitions it to published.
 */
function preservedStatus(current: ContentResponse): "draft" | "current" {
  return current.status === "draft" ? "draft" : "current";
}

/**
 * Authorize an action, perform it against Confluence, and record the outcome. Returns the created
 * content's ID for a `createContent` action, and nothing otherwise. Throws when policy forbids the
 * action or Confluence rejects it.
 */
export async function performAction(
  store: ConfluenceStore,
  recorder: RpcStub<ActionRecorder>,
  action: ConfluenceAction,
): Promise<string | undefined> {
  const handle = await recorder.authorizeAction(describeAction(action));
  let createdContentId: string | undefined;
  try {
    createdContentId = await runAction(store, action);
  } catch (err) {
    // The request reached Confluence, so a failure here leaves the outcome unknown.
    await handle.failed(err instanceof Error ? err.message : String(err), true);
    throw err;
  }
  await handle.succeeded();
  return createdContentId;
}

async function runAction(
  store: ConfluenceStore, action: ConfluenceAction,
): Promise<string | undefined> {
  const api = store.api;

  switch (action.type) {
    case "createContent": {
      const spaceKey = action.parent.spaceKey;
      if (!spaceKey) throw new Error("Cannot create content without a space.");
      const spaceId = await store.getSpaceId(spaceKey);
      const storageValue = markdownToStorage(action.content ?? "");
      const created = action.kind === "blogpost"
        ? await api.createBlogPost({ spaceId, title: action.title, status: action.status, storageValue })
        : await api.createPage({
            spaceId,
            title: action.title,
            status: action.status,
            storageValue,
            parentId: action.parent.type === "page" ? action.parent.parentId : undefined,
          });
      return created.id;
    }
    case "setContent": {
      const current = await store.getContentResponse(action.contentId, true);
      await api.updateContent({
        id: action.contentId,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: current.title,
        version: (current.version?.number ?? 1) + 1,
        storageValue: markdownToStorage(action.markdown),
        status: preservedStatus(current),
      });
      store.invalidateContent(action.contentId);
      return;
    }
    case "appendContent": {
      const current = await store.getContentResponse(action.contentId, true);
      await api.updateContent({
        id: action.contentId,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: current.title,
        version: (current.version?.number ?? 1) + 1,
        storageValue: (current.body?.storage?.value ?? "") + markdownToStorage(action.markdown),
        status: preservedStatus(current),
      });
      store.invalidateContent(action.contentId);
      return;
    }
    case "setTitle": {
      const current = await store.getContentResponse(action.contentId, true);
      await api.updateContent({
        id: action.contentId,
        type: current.type === "blogpost" ? "blogpost" : "page",
        title: action.title,
        version: (current.version?.number ?? 1) + 1,
        storageValue: current.body?.storage?.value ?? "",
        status: preservedStatus(current),
      });
      store.invalidateContent(action.contentId);
      return;
    }
    case "addComment": {
      // The comment container type must match the target (blog posts reject a "page" container).
      const target = await store.getContentResponse(action.contentId, true);
      await api.addComment(action.contentId, markdownToStorage(action.text),
        target.type === "blogpost" ? "blogpost" : "page");
      return;
    }
    case "addLabel":
      await api.addLabel(action.contentId, action.name);
      store.invalidateContent(action.contentId);
      return;
    case "removeLabel":
      await api.removeLabel(action.contentId, action.name);
      store.invalidateContent(action.contentId);
      return;
    case "uploadAttachment":
      await api.uploadAttachment(action.contentId, action);
      return;
    case "trash":
      await api.trashContent(action.contentId, await store.getContentKind(action.contentId));
      store.invalidateContent(action.contentId);
      return;
    case "restore":
      await api.restoreContent(action.contentId);
      store.invalidateContent(action.contentId);
      return;
  }
}

// Re-exports used by sessions for base reads.
export { contentBodyMarkdown, contentToSummary, storageToMarkdown };
