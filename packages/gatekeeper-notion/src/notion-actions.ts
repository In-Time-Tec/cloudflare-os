// Action machinery for the Notion gatekeeper: the action model, its action kinds and descriptions,
// response caching, and the code that performs each action against Notion.
//
// Reads are served from a short-TTL cache of what Notion returned; an action invalidates the cache
// entries it affects, so the next read reflects it.

import {
  NotionApi,
  blocksToMarkdown,
  iconInputToNotion,
  markdownToBlocks,
  databaseSchema,
  pageToMetadata,
  pageToSummary,
  plainToRichText,
  primaryDataSourceId,
  propertiesToValues,
  propertyInputsToNotion,
  type NotionDataSourceResponse,
  type NotionDatabaseResponse,
  type NotionPageResponse,
} from "./notion-api";
import type { RpcStub } from "cloudflare:workers";
import type {
  ActionCapability,
  ActionDescription,
  ActionKind,
  ActionRecorder,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  NotionDatabaseSchema,
  NotionIconInput,
  NotionPropertyInput,
  NotionUser,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Action model

export type NotionActionParent =
  | { kind: "page"; pageId: string }
  | { kind: "database"; databaseId: string }
  | { kind: "workspace" };

export type NotionAction =
  | { type: "appendContent"; pageId: string; markdown: string }
  | { type: "setTitle"; pageId: string; title: string }
  | { type: "setProperties"; pageId: string; properties: Record<string, NotionPropertyInput> }
  | { type: "setIcon"; pageId: string; icon: NotionIconInput | null }
  | { type: "archive"; pageId: string }
  | { type: "restore"; pageId: string }
  | { type: "addComment"; pageId: string; text: string }
  | {
      type: "createPage";
      parent: NotionActionParent;
      title?: string;
      properties?: Record<string, NotionPropertyInput>;
      content?: string;
      icon?: NotionIconInput;
      /** The parent data source's title column name (e.g. "Name"), when the parent is a database. */
      titlePropertyName?: string;
    };

// ---------------------------------------------------------------------------------------------
// Action kinds
//
// Notion content is shared with everyone the page is shared with — inside the workspace and, for a
// published page, beyond it. Notion keeps no undo history reachable through the API, so undoing an
// edit means a person editing it back.

const PAGE_CREATE: ActionKind = { tag: "notion.page.create", label: "Create a page" };
const PAGE_EDIT: ActionKind = { tag: "notion.page.edit", label: "Edit a page's content or title" };
const PAGE_PROPERTIES: ActionKind = {
  tag: "notion.page.properties", label: "Change a page's properties or icon",
};
const PAGE_TRASH: ActionKind = {
  tag: "notion.page.trash", label: "Move a page to the trash, or restore it",
};
const PAGE_COMMENT: ActionKind = { tag: "notion.page.comment", label: "Comment on a page" };

/** Every side-effecting operation this gatekeeper performs, for consent and deployment policy. */
export const ACTION_CATALOG: ActionCapability[] = [
  {
    kind: PAGE_CREATE,
    summary: "Create pages and database rows",
    risk: {
      reversible: "manual", reach: "creates-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: PAGE_EDIT,
    summary: "Rename a page or append to its body",
    risk: {
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: PAGE_PROPERTIES,
    summary: "Set a page's database properties or its icon",
    risk: {
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: PAGE_TRASH,
    summary: "Move a page to the Notion trash, or restore one from it",
    risk: {
      // Trashing is undone by restoring, but that is a person's decision, not an automatic rollback.
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: false,
    },
  },
  {
    kind: PAGE_COMMENT,
    summary: "Post a comment on a page, notifying whoever follows it",
    risk: {
      // The Notion API cannot delete a comment; only a person in the UI can.
      reversible: "manual", reach: "creates-content", audience: "shared", freeform: true,
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Response cache (backed by the gatekeeper DO's KV storage)

type Kv = DurableObjectStorage["kv"];

const PAGE_TTL_MS = 30_000;
const CONTENT_TTL_MS = 30_000;
const DB_TTL_MS = 60_000;
const USER_TTL_MS = 60 * 60_000;

type PageCache = { fetchedAt: number; page: NotionPageResponse };
type ContentCache = { fetchedAt: number; markdown: string };
type DbCache = { fetchedAt: number; db: NotionDatabaseResponse };
type DataSourceCache = { fetchedAt: number; dataSource: NotionDataSourceResponse };

export class NotionStore {
  #kv: Kv;
  #api: NotionApi;

  constructor(kv: Kv, api: NotionApi) {
    this.#kv = kv;
    this.#api = api;
  }

  get api(): NotionApi {
    return this.#api;
  }

  async getPageResponse(id: string, bypassCache = false): Promise<NotionPageResponse> {
    if (!bypassCache) {
      const cached = this.#kv.get<PageCache>(`cache:page:${id}`);
      if (cached && Date.now() - cached.fetchedAt < PAGE_TTL_MS) return cached.page;
    }
    const page = await this.#api.retrievePage(id);
    this.#kv.put<PageCache>(`cache:page:${id}`, { fetchedAt: Date.now(), page });
    return page;
  }

  async getPageContent(id: string): Promise<string> {
    const cached = this.#kv.get<ContentCache>(`cache:content:${id}`);
    if (cached && Date.now() - cached.fetchedAt < CONTENT_TTL_MS) return cached.markdown;
    const tree = await this.#api.fetchBlockTree(id);
    const markdown = blocksToMarkdown(tree);
    this.#kv.put<ContentCache>(`cache:content:${id}`, { fetchedAt: Date.now(), markdown });
    return markdown;
  }

  /**
   * Resolve a user to its full form (name/avatar/email), cached — page metadata only includes
   * partial `{id}` users, unlike property values.
   */
  async getUser(id: string): Promise<NotionUser> {
    const cached = this.#kv.get<{ fetchedAt: number; user: NotionUser }>(`cache:user:${id}`);
    if (cached && Date.now() - cached.fetchedAt < USER_TTL_MS) return cached.user;
    const user = await this.#api.retrieveUser(id);
    this.#kv.put(`cache:user:${id}`, { fetchedAt: Date.now(), user });
    return user;
  }

  async getDatabaseResponse(id: string): Promise<NotionDatabaseResponse> {
    const cached = this.#kv.get<DbCache>(`cache:db:${id}`);
    if (cached && Date.now() - cached.fetchedAt < DB_TTL_MS) return cached.db;
    const db = await this.#api.retrieveDatabase(id);
    this.#kv.put<DbCache>(`cache:db:${id}`, { fetchedAt: Date.now(), db });
    return db;
  }

  /** The primary data source ID for a database (cached via the database response). */
  async getDataSourceId(databaseId: string): Promise<string> {
    return primaryDataSourceId(await this.getDatabaseResponse(databaseId));
  }

  async getDataSourceResponse(dataSourceId: string): Promise<NotionDataSourceResponse> {
    const cached = this.#kv.get<DataSourceCache>(`cache:ds:${dataSourceId}`);
    if (cached && Date.now() - cached.fetchedAt < DB_TTL_MS) return cached.dataSource;
    const dataSource = await this.#api.retrieveDataSource(dataSourceId);
    this.#kv.put<DataSourceCache>(`cache:ds:${dataSourceId}`, { fetchedAt: Date.now(), dataSource });
    return dataSource;
  }

  /** The row schema for a database, read from its primary data source. */
  async getDatabaseSchema(databaseId: string): Promise<NotionDatabaseSchema> {
    const dataSourceId = await this.getDataSourceId(databaseId);
    return databaseSchema(await this.getDataSourceResponse(dataSourceId));
  }

  invalidatePage(id: string): void {
    this.#kv.delete(`cache:page:${id}`);
  }

  invalidateContent(id: string): void {
    this.#kv.delete(`cache:content:${id}`);
  }

  invalidateDatabase(id: string): void {
    this.#kv.delete(`cache:db:${id}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Observation descriptions

export function observation(title: string, description: string): ObservationDescription {
  return { title, description };
}

// ---------------------------------------------------------------------------------------------
// Action descriptions

export function describeAction(action: NotionAction): ActionDescription {
  switch (action.type) {
    case "appendContent":
      return {
        title: "Append content to Notion page",
        description: `Append the following Markdown to the page body:\n\n${truncate(action.markdown)}`,
        actionKind: PAGE_EDIT,
      };
    case "setTitle":
      return {
        title: "Rename Notion page",
        description: `Change the page title to **${action.title}**.`,
        actionKind: PAGE_EDIT,
      };
    case "setProperties":
      return {
        title: "Update Notion page properties",
        description: `Update properties: ${Object.keys(action.properties).join(", ") || "(none)"}.`,
        actionKind: PAGE_PROPERTIES,
      };
    case "setIcon":
      return {
        title: "Change Notion page icon",
        description: action.icon
          ? `Set the page icon to ${iconInputDisplay(action.icon)}.`
          : "Remove the page icon.",
        actionKind: PAGE_PROPERTIES,
      };
    case "archive":
      return {
        title: "Move Notion page to trash",
        description: "Move the page to the Notion trash (reversible).",
        actionKind: PAGE_TRASH,
      };
    case "restore":
      return {
        title: "Restore Notion page from trash",
        description: "Restore the page from the Notion trash.",
        actionKind: PAGE_TRASH,
      };
    case "addComment":
      return {
        title: "Comment on Notion page",
        description: `Post a comment:\n\n${truncate(action.text)}`,
        actionKind: PAGE_COMMENT,
      };
    case "createPage": {
      const where =
        action.parent.kind === "page" ? "as a sub-page"
        : action.parent.kind === "database" ? "as a database row"
        // Workspace-level: the API needs a concrete parent, so the page lands under the most
        // recently edited shared page.
        : "under the most recently edited shared page (Notion has no true top-level page)";
      return {
        title: "Create Notion page",
        description: `Create a new page ${where} titled **${action.title ?? "Untitled"}**.`,
        actionKind: PAGE_CREATE,
      };
    }
  }
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function iconInputDisplay(icon: NotionIconInput): string {
  return "emoji" in icon ? icon.emoji : icon.imageUrl;
}

// ---------------------------------------------------------------------------------------------
// Action execution

/**
 * Authorize an action, perform it against Notion, and record the outcome. Returns the created
 * page's ID for a `createPage` action, and nothing otherwise. Throws when policy forbids the
 * action or Notion rejects it.
 */
export async function performAction(
  store: NotionStore,
  recorder: RpcStub<ActionRecorder>,
  action: NotionAction,
): Promise<string | undefined> {
  const handle = await recorder.authorizeAction(describeAction(action));
  let createdPageId: string | undefined;
  try {
    createdPageId = await runAction(store, action);
  } catch (err) {
    // The request reached Notion, so a failure here leaves the outcome unknown.
    await handle.failed(err instanceof Error ? err.message : String(err), true);
    throw err;
  }
  await handle.succeeded();
  return createdPageId;
}

async function runAction(store: NotionStore, action: NotionAction): Promise<string | undefined> {
  const api = store.api;
  switch (action.type) {
    case "appendContent": {
      await api.appendBlockChildren(action.pageId, markdownToBlocks(action.markdown));
      store.invalidateContent(action.pageId);
      return;
    }
    case "setTitle": {
      await api.updatePage(action.pageId, {
        properties: {
          [await titlePropName(store, action.pageId)]: { title: plainToRichText(action.title) },
        },
      });
      store.invalidatePage(action.pageId);
      return;
    }
    case "setProperties": {
      await api.updatePage(action.pageId, { properties: propertyInputsToNotion(action.properties) });
      store.invalidatePage(action.pageId);
      return;
    }
    case "setIcon": {
      await api.updatePage(action.pageId, {
        icon: action.icon ? iconInputToNotion(action.icon) : null,
      });
      store.invalidatePage(action.pageId);
      return;
    }
    case "archive": {
      await api.updatePage(action.pageId, { archived: true });
      store.invalidatePage(action.pageId);
      return;
    }
    case "restore": {
      await api.updatePage(action.pageId, { archived: false });
      store.invalidatePage(action.pageId);
      return;
    }
    case "addComment": {
      await api.createComment({
        parent: { page_id: action.pageId }, rich_text: plainToRichText(action.text),
      });
      return;
    }
    case "createPage": {
      const parent = await resolveCreateParent(store, action.parent);
      const body = buildCreateBody(
        parent, action.title, action.properties, action.content, action.icon,
        action.titlePropertyName);
      return (await api.createPage(body)).id;
    }
  }
}

type NotionCreateParent =
  | { type: "page_id"; page_id: string }
  | { type: "data_source_id"; data_source_id: string };

async function resolveCreateParent(
  store: NotionStore,
  parent: NotionActionParent,
): Promise<NotionCreateParent> {
  if (parent.kind === "page") {
    return { type: "page_id", page_id: parent.pageId };
  }
  if (parent.kind === "database") {
    // A database row's parent is its data source (works on any API version).
    return { type: "data_source_id", data_source_id: await store.getDataSourceId(parent.databaseId) };
  }
  // Workspace-level: the Notion API needs a concrete parent, so pick the most recently edited
  // shared page to create under.
  const search = await store.api.search({
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 1,
  });
  const parentPage = search.results[0];
  if (!parentPage) {
    throw new Error(
      "No writable Notion page is shared with this connection to create the page under.",
    );
  }
  return { type: "page_id", page_id: parentPage.id };
}

async function titlePropName(store: NotionStore, pageId: string): Promise<string> {
  const page = await store.getPageResponse(pageId, true);
  const entry = Object.entries(page.properties ?? {}).find(([, p]) => p.type === "title");
  return entry ? entry[0] : "title";
}

export function buildCreateBody(
  parent: NotionCreateParent,
  title: string | undefined,
  properties: Record<string, NotionPropertyInput> | undefined,
  content: string | undefined,
  icon: NotionIconInput | undefined,
  titlePropertyName?: string,
): Record<string, unknown> {
  const notionProperties: Record<string, unknown> = properties
    ? propertyInputsToNotion(properties)
    : {};

  if (title !== undefined) {
    if (parent.type === "page_id") {
      notionProperties["title"] = { title: plainToRichText(title) };
    } else {
      const hasTitle = properties ? Object.values(properties).some(p => p.type === "title") : false;
      // Use the data source's actual title column name when known, else fall back to "Name".
      if (!hasTitle) notionProperties[titlePropertyName ?? "Name"] = { title: plainToRichText(title) };
    }
  }

  const body: Record<string, unknown> = { parent, properties: notionProperties };
  if (icon) body["icon"] = iconInputToNotion(icon);
  if (content) body["children"] = markdownToBlocks(content);
  return body;
}

// Re-exports used by sessions for base reads.
export { pageToMetadata, pageToSummary, propertiesToValues };
