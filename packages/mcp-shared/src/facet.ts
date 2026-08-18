// Shared mechanics of an MCP gatekeeper facet. Connector-owned subclasses retain their Wrangler
// identity, props, labels, and account lookup.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import type {
  ActionCapability,
  ActionKind,
  ActionRecorder,
  Gatekeeper,
  GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";

import { CATALOG_TTL_MS, scopedTools } from "./catalog.js";
import type { McpClient } from "./client.js";
import {
  withClient,
  type ConnectionAccount,
  type ConnectionEnv,
  type WithClientOptions,
} from "./connection.js";
import type { McpLog } from "./log.js";
import { formatToolScope, type ToolScope } from "./scope.js";
import { McpSessionBase, type McpSessionHost } from "./session.js";
import { installToolMethods } from "./session-methods.js";
import { observerRefusalMessage } from "./sharing-policy.js";
import { actionKindFor, type ClassifiedTool } from "./tools.js";

type FacetProps = {
  endpoint: string;
  scope: ToolScope;
};

type SessionConstructor<Session extends McpSessionBase> = new (
  host: McpSessionHost,
  recorder: RpcStub<ActionRecorder>,
) => Session;

/** Common session, catalog, action, and sharing behavior for connector-owned MCP facets. */
export abstract class McpFacetBase<
  Env extends ConnectionEnv,
  Props extends FacetProps,
  Session extends McpSessionBase,
> extends DurableObject<Env, Props> implements Gatekeeper<Session>, McpSessionHost {
  #toolsPromise: Promise<ClassifiedTool[]> | undefined;
  #toolsFetchedAt = 0;

  /** Connector-owned logger carrying the facet's safe identifying fields. */
  protected abstract get log(): McpLog;

  /** Connector-decorated session class exposed through RPC. */
  protected abstract get sessionClass(): SessionConstructor<Session>;

  /** Namespace preventing action policy from crossing resource boundaries. */
  protected abstract get actionScopeTag(): string;

  /** Human-readable resource named when refusing an observer. */
  protected abstract get observerName(): string;

  /** Connector-owned account capability used for endpoint calls. */
  protected abstract account(): ConnectionAccount;

  /** Human-readable server label used in observations and action prompts. */
  abstract get serverName(): string;

  /** Describes the connector-specific resource represented by this facet. */
  abstract describe(): Promise<ResourceDescription>;

  /** Generates the connector-specific TypeScript API for this facet. */
  abstract getTypeScriptTypes(): Promise<string>;

  /** The endpoint this facet is authorized to call. */
  get endpoint(): string {
    return this.ctx.props.endpoint;
  }

  /** The tool scope this facet is authorized to expose. */
  get scope(): ToolScope {
    return this.ctx.props.scope;
  }

  /** Canonical resource URL for this facet's endpoint and scope. */
  protected get resourceUrl(): string {
    return formatToolScope(this.endpoint, this.scope);
  }

  /** Returns this facet's scoped and classified tool catalog. */
  tools(): Promise<ClassifiedTool[]> {
    if (!this.#toolsPromise || Date.now() - this.#toolsFetchedAt > CATALOG_TTL_MS) {
      this.#toolsFetchedAt = Date.now();
      this.#toolsPromise = scopedTools({
        store: this.ctx.storage.kv,
        log: this.log,
        env: this.env,
        account: this.account(),
        endpoint: this.endpoint,
        scope: this.scope,
      }).catch(err => {
        this.#toolsPromise = undefined;
        throw err;
      });
    }
    return this.#toolsPromise;
  }

  /**
   * One capability per non-read tool in the current catalog. The server's own tool description is
   * the only summary available, so it is the summary; the risk profile is the honest floor for an
   * arbitrary tool on a server this deployment does not model.
   */
  async getActionCatalog(): Promise<ActionCapability[]> {
    return (await this.tools())
      .filter(entry => entry.mode === "action")
      .map(entry => ({
        kind: actionKindFor(this.actionScopeTag, entry.tool.name),
        summary: entry.tool.title ?? entry.tool.description ?? entry.tool.name,
        risk: {
          // MCP describes no inverse operation for a tool call, gives no way to check what one
          // did, and says nothing about who can see the result. The arguments are whatever the
          // agent composed.
          reversible: "no",
          reach: "acts-on-world",
          audience: "external",
          freeform: true,
        },
      }));
  }

  /** Starts a session with generated per-tool methods when the catalog is available. */
  async startSession(recorder: RpcStub<ActionRecorder>): Promise<Session> {
    let SessionClass = this.sessionClass;
    try {
      SessionClass = installToolMethods(SessionClass, await this.tools());
    } catch (err) {
      this.log.warn("starting session without per-tool methods", {
        event: "session.tool-methods.unavailable", error: err,
      });
    }
    return new SessionClass(this, recorder.dup());
  }

  /** Refuses observers so MCP bindings can only be opened by their owner. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(observerRefusalMessage(this.observerName));
  }

  /** Removes no observer state because observers are never admitted. */
  async removeObserver(_id: string): Promise<void> {}

  /** Runs a call against this facet's endpoint and account. */
  call<T>(fn: (client: McpClient) => Promise<T>, options?: WithClientOptions): Promise<T> {
    return withClient(this.env, this.account(), this.endpoint, fn, options);
  }

  /** Namespaces one tool's action kind to this facet. */
  actionKindFor(toolName: string): ActionKind {
    return actionKindFor(this.actionScopeTag, toolName);
  }
}
