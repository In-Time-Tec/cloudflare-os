import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  GatekeeperUser,
  stripTrailingSlashes,
  GatekeeperUserVerifier,
  GatekeeperVendor as GatekeeperVendorIface,
  Gatekeeper,
  ResourceDescription,
  ActionCapability,
  ActionDescription,
  ActionKind,
  ActionRecorder,
  ObservationDescription,
  VendorDescription,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  AccountDescription,
  SupportedResource,
  ResourceConfiguratorFrame, AuthenticatedIdentity,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  Cursor,
  LinearWorkspace,
  LinearTeam,
  LinearIssue,
  LinearWorkspaceMetadata,
  LinearTeamSummary,
  LinearTeamMetadata,
  LinearProjectSummary,
  LinearProjectRef,
  LinearCycleSummary,
  LinearIssueSummary,
  LinearIssueDetails,
  LinearComment,
  LinearUser,
  LinearLabel,
  LinearWorkflowState,
  LinearPriority,
  LinearStateCategory,
  LinearProjectStatus,
  LinearIssueFilter,
  LinearIssueSearch,
  LinearPageOptions,
  LinearCreateIssueOptions,
  LinearCreateLabelOptions,
} from "./types";
import TYPES_CODE from "./types.txt";
import LINEAR_LOGO_SVG from "./linear-logo.svg";
import {
  LinearApi,
  LinearApiError,
  buildAuthorizeUrl,
  exchangeAuthCode,
  refreshAccessToken,
  revokeToken,
  type LinearOAuthGrant,
  type RawIssue,
  type RawUser,
  type RawLabel,
  type RawWorkflowState,
  type RawTeam,
  type RawProject,
  type RawCycle,
  type RawComment,
  type RawOrganization,
  type RawConnection,
  type IssueCreateInput,
} from "./linear-api";
import {
  LinearWorkspaceConfiguratorUI,
  LinearTeamConfiguratorUI,
  LinearIssueConfiguratorUI,
} from "./linear-configurators";
import LINEAR_WORKSPACE_CONFIGURATOR_HTML from "./generated/linear-workspace-configurator-ui.txt";
import LINEAR_TEAM_CONFIGURATOR_HTML from "./generated/linear-team-configurator-ui.txt";
import LINEAR_ISSUE_CONFIGURATOR_HTML from "./generated/linear-issue-configurator-ui.txt";
import { obsContext } from "./observability.js";

const VENDOR_ID = "linear";

const logger = obsContext.createLogger({
  component: "gatekeeper.linear", vendorId: VENDOR_ID,
});

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 3600 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const METADATA_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

const OAUTH_SCOPES = ["read", "write"];

const WORKSPACE_RESOURCE: SupportedResource = {
  urlPattern: "https://linear.app/:workspace",
  title: "Linear Workspace",
  description:
    "Read and manage every team and issue in a Linear workspace. This is the broadest option — " +
    "connect a single team or issue instead to limit what a Gadget can access.",
};

const TEAM_RESOURCE: SupportedResource = {
  urlPattern: "https://linear.app/:workspace/team/:teamKey{/:rest}*",
  title: "Linear Team",
  description: "Read and manage the issues, labels, states, and cycles of a single Linear team.",
};

const ISSUE_RESOURCE: SupportedResource = {
  urlPattern: "https://linear.app/:workspace/issue/:issueId{/:rest}*",
  title: "Linear Issue",
  description: "Read and manage a single Linear issue and its comments.",
};

const SUPPORTED_RESOURCES: SupportedResource[] = [WORKSPACE_RESOURCE, TEAM_RESOURCE, ISSUE_RESOURCE];

const LINEAR_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(LINEAR_LOGO_SVG)}`;

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.</p>
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #5e6ad2; color: white; border: none; border-radius: 4px; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem;">Linear Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6;">Please configure a Linear OAuth client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// Small helpers

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/linear");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function clampPageSize(size?: number): number {
  if (!size || size <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(size), MAX_PAGE_SIZE);
}

function snippet(text: string | null | undefined, fallback = ""): string {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return fallback;
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

function disposeStub(stub: RpcStub<ActionRecorder>): void {
  (stub as unknown as Disposable)[Symbol.dispose]();
}

// ---- value mapping ----

const PRIORITY_TO_NUM: Record<LinearPriority, number> = {
  none: 0, urgent: 1, high: 2, medium: 3, low: 4,
};
const NUM_TO_PRIORITY: LinearPriority[] = ["none", "urgent", "high", "medium", "low"];

function numToPriority(value: number): LinearPriority {
  return NUM_TO_PRIORITY[value] ?? "none";
}

const STATE_CATEGORIES: LinearStateCategory[] =
  ["triage", "backlog", "unstarted", "started", "completed", "canceled"];

function toStateCategory(type: string | null | undefined): LinearStateCategory {
  return STATE_CATEGORIES.includes(type as LinearStateCategory)
    ? (type as LinearStateCategory)
    : "backlog";
}

const PROJECT_STATUSES: LinearProjectStatus[] =
  ["backlog", "planned", "started", "paused", "completed", "canceled"];

function toProjectStatus(state: string | null | undefined): LinearProjectStatus {
  return PROJECT_STATUSES.includes(state as LinearProjectStatus)
    ? (state as LinearProjectStatus)
    : "backlog";
}

// ---- normalization (raw GraphQL -> public Session shapes) ----

function normUser(user: RawUser | null | undefined): LinearUser | null {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName ?? undefined,
    email: user.email ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    active: user.active ?? true,
  };
}

function normLabel(label: RawLabel): LinearLabel {
  return { id: label.id, name: label.name, color: label.color ?? undefined };
}

function normState(state: RawWorkflowState): LinearWorkflowState {
  return {
    id: state.id,
    name: state.name,
    type: toStateCategory(state.type),
    color: state.color ?? undefined,
    position: state.position ?? undefined,
  };
}

function teamUrl(wsKey: string, key: string): string {
  return `https://linear.app/${wsKey}/team/${key}`;
}

function normTeamSummary(team: RawTeam, wsKey: string): LinearTeamSummary {
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    url: teamUrl(wsKey, team.key),
    description: team.description ?? undefined,
    private: team.private ?? false,
  };
}

function normProjectRef(project: RawProject): LinearProjectRef {
  return { id: project.id, name: project.name, url: project.url };
}

function normProjectSummary(project: RawProject): LinearProjectSummary {
  return {
    ...normProjectRef(project),
    status: toProjectStatus(project.state),
    lead: normUser(project.lead),
    progress: project.progress ?? undefined,
    startDate: project.startDate ?? undefined,
    targetDate: project.targetDate ?? undefined,
  };
}

function isCycleActive(cycle: RawCycle): boolean {
  const now = Date.now();
  const starts = cycle.startsAt ? Date.parse(cycle.startsAt) : NaN;
  const ends = cycle.endsAt ? Date.parse(cycle.endsAt) : NaN;
  return !Number.isNaN(starts) && !Number.isNaN(ends) && now >= starts && now <= ends;
}

function normCycle(cycle: RawCycle): LinearCycleSummary {
  return {
    id: cycle.id,
    number: cycle.number,
    name: cycle.name ?? undefined,
    startsAt: cycle.startsAt ?? undefined,
    endsAt: cycle.endsAt ?? undefined,
    isActive: isCycleActive(cycle),
  };
}

function normIssueSummary(issue: RawIssue, wsKey: string): LinearIssueSummary {
  return {
    id: issue.identifier,
    uuid: issue.id,
    title: issue.title,
    url: issue.url,
    state: {
      name: issue.state?.name ?? "Unknown",
      type: toStateCategory(issue.state?.type),
    },
    priority: numToPriority(issue.priority),
    assignee: normUser(issue.assignee),
    labels: (issue.labels?.nodes ?? []).map(normLabel),
    team: {
      id: issue.team.id,
      key: issue.team.key,
      name: issue.team.name,
      url: teamUrl(wsKey, issue.team.key),
    },
    project: issue.project ? normProjectRef(issue.project) : null,
    createdAt: new Date(issue.createdAt),
    updatedAt: new Date(issue.updatedAt),
    completedAt: issue.completedAt ? new Date(issue.completedAt) : undefined,
    canceledAt: issue.canceledAt ? new Date(issue.canceledAt) : undefined,
    dueDate: issue.dueDate ?? undefined,
  };
}

function normIssueDetails(issue: RawIssue, wsKey: string): LinearIssueDetails {
  return {
    ...normIssueSummary(issue, wsKey),
    descriptionMarkdown: issue.description ?? "",
    creator: normUser(issue.creator),
    parent: issue.parent
      ? { id: issue.parent.identifier, uuid: issue.parent.id, title: issue.parent.title, url: issue.parent.url }
      : null,
    cycle: issue.cycle ? normCycle(issue.cycle) : null,
    branchName: issue.branchName ?? undefined,
  };
}

function normComment(comment: RawComment): LinearComment {
  return {
    id: comment.id,
    author: normUser(comment.user),
    bodyMarkdown: comment.body,
    createdAt: new Date(comment.createdAt),
    updatedAt: comment.updatedAt ? new Date(comment.updatedAt) : undefined,
    url: comment.url,
  };
}

// ---- GraphQL issue-filter construction (pure) ----

type IssuePageArgs = {
  teamId?: string;
  state?: string;
  assignee?: string;
  labels?: string[];
  priority?: LinearPriority;
  projectId?: string;
  sort?: "created" | "updated" | "priority";
  includeArchived?: boolean;
};

function buildIssueFilter(args: IssuePageArgs): { filter: Record<string, unknown>; orderBy: "createdAt" | "updatedAt" } {
  const and: Record<string, unknown>[] = [];
  if (args.teamId) and.push({ team: { id: { eq: args.teamId } } });
  if (args.state) {
    if (STATE_CATEGORIES.includes(args.state as LinearStateCategory)) {
      and.push({ state: { type: { eq: args.state } } });
    } else {
      and.push({ state: { name: { eqIgnoreCase: args.state } } });
    }
  }
  if (args.assignee) {
    and.push({ assignee: { or: [
      { email: { eqIgnoreCase: args.assignee } },
      { displayName: { eqIgnoreCase: args.assignee } },
      { name: { eqIgnoreCase: args.assignee } },
    ] } });
  }
  for (const label of args.labels ?? []) {
    and.push({ labels: { some: { name: { eqIgnoreCase: label } } } });
  }
  if (args.priority) and.push({ priority: { eq: PRIORITY_TO_NUM[args.priority] } });
  if (args.projectId) and.push({ project: { id: { eq: args.projectId } } });

  const orderBy = args.sort === "created" ? "createdAt" : "updatedAt";
  return { filter: and.length > 0 ? { and } : {}, orderBy };
}

// ---------------------------------------------------------------------------
// HTTP handler — the browser OAuth flow.

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Step 1: user opens the connect link (<doId>/<nonce>) -> redirect to Linear's consent screen.
    // Validate the DO id is 64 hex chars (not just 64 chars) so idFromString() can't throw a 500.
    if (path.length === 2 && /^[0-9a-f]{64}$/.test(path[0]) && /^[0-9a-f]{64}$/.test(path[1])) {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const redirectUrl = buildAuthorizeUrl({
        clientId: env.CLIENT_ID,
        redirectUri: `${getBaseUrl(env)}/oauth`,
        state: `${doId}:${begun.oauthNonce}`,
        scopes: begun.scopes,
      });
      return Response.redirect(redirectUrl, 302);
    }

    // Step 2: Linear redirects back here with code + state.
    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response("Linear authorization failed. Please restart the connection flow from Cloudflare OS.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      const state = url.searchParams.get("state");
      if (!state) return badRequest("Error: no 'state' provided");
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return badRequest("Error: malformed state");

      const doId = state.slice(0, colonIndex);
      const oauthNonce = state.slice(colonIndex + 1);
      const code = url.searchParams.get("code");
      if (!code) return badRequest("Error: no 'code' provided");

      // Validate the DO id shape before idFromString(), which throws (→ unhandled 500) on garbage.
      if (!/^[0-9a-f]{64}$/.test(doId)) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const accepted = await stub.acceptAuthCode(code, oauthNonce);
      if (!accepted) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Vendor

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Linear",
      url: "https://linear.app",
      logo: { url: LINEAR_LOGO_URL },
      color: "#f4f5f8",
      tagline: "Triage, create, and update issues",
      description:
        "Connect your Linear account so Cloudflare OS can read and manage issues, projects, and " +
        "comments across the teams you choose.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getCapabilities() {
    // No separately grantable operations: the resource grant is the whole of this connection's
    // access.
    return {capabilities: [], groups: []};
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores OAuth credentials and handles token refresh.

type StoredNonce = { value: string; expiresAt: number; stage: "initiation" | "oauth" };

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<LinearOAuthGrant>("grant")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async prepareReconnect(initiationNonce: string): Promise<void> {
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put("expiredNotified", false);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  async beginOAuthFlow(initiationNonce: string): Promise<{ oauthNonce: string; scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    return { oauthNonce, scopes: OAUTH_SCOPES };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt ||
        !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    if (!this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      throw new Error("Linear OAuth is not configured.");
    }

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete authorization. Please try again.");
    }

    const grant = await exchangeAuthCode({
      code,
      clientId: this.env.CLIENT_ID,
      clientSecret: this.env.CLIENT_SECRET,
      redirectUri: `${getBaseUrl(this.env)}/oauth`,
    });

    this.ctx.storage.kv.put<LinearOAuthGrant>("grant", grant);
    this.ctx.storage.kv.put("expiredNotified", false);

    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");
    if (reconnecting) {
      this.ctx.storage.kv.delete("reconnecting");
      await callback.credentialsRestored();
    } else {
      try {
        const props: GatekeeperUserImplProps = { userObjectId: this.ctx.id.toString() };
        await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
      } catch (err) {
        this.ctx.storage.kv.delete("grant");
        throw err;
      }
    }

    await this.ctx.storage.deleteAlarm();
    return true;
  }

  /** Returns a currently-valid access token, refreshing it first if it is about to expire. */
  async getAccessToken(): Promise<string> {
    const grant = this.ctx.storage.kv.get<LinearOAuthGrant>("grant");
    if (!grant) throw new Error("Linear credentials have not been configured for this account.");

    if (Date.now() < grant.expiresAt - TOKEN_REFRESH_SKEW_MS) {
      return grant.accessToken;
    }
    if (!grant.refreshToken || !this.env.CLIENT_ID || !this.env.CLIENT_SECRET) {
      return grant.accessToken;
    }

    try {
      const refreshed = await refreshAccessToken({
        refreshToken: grant.refreshToken,
        clientId: this.env.CLIENT_ID,
        clientSecret: this.env.CLIENT_SECRET,
      });
      this.ctx.storage.kv.put<LinearOAuthGrant>("grant", refreshed);
      return refreshed.accessToken;
    } catch (err) {
      // A revoked/expired refresh token (invalid_grant) means the connection is dead. Notify the
      // Workshop here, since the error type is lost when it crosses the RPC boundary to the caller.
      if (err instanceof LinearApiError && err.isAuthError) {
        await this.noteCredentialsExpired();
        throw new Error("Linear credentials have expired or been revoked. Please reconnect the account.", { cause: err });
      }
      throw err;
    }
  }

  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return;
    // Best-effort: never let a failed/disposed callback RPC mask the real error the caller is about
    // to throw (e.g. the auth error that triggered this notification).
    try {
      await callback.credentialsExpired();
    } catch (err) {
      logger.warn("failed to notify credential expiry", {
        event: "credentials.expiry.notify.failed", error: err,
      });
    }
  }

  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<LinearOAuthGrant>("grant")) {
      await this.ctx.storage.deleteAll();
    }
  }

  async revoke(): Promise<void> {
    const grant = this.ctx.storage.kv.get<LinearOAuthGrant>("grant");
    if (grant) {
      try {
        await revokeToken(grant.accessToken);
        if (grant.refreshToken) await revokeToken(grant.refreshToken);
      } catch (err) {
        logger.error("failed to revoke Linear token", {
          event: "oauth.token.revoke.failed", error: err,
        });
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// UserImpl — maps resource URLs to gatekeeper DO classes and serves configurators.

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
    implements GatekeeperUser {
  #account() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #withApi<T>(fn: (api: LinearApi) => Promise<T>): Promise<T> {
    const account = this.#account();
    const api = new LinearApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof LinearApiError && error.isAuthError) {
        try { await account.noteCredentialsExpired(); } catch (notifyErr) {
          logger.warn("failed to note credential expiry", {
            event: "credentials.expiry.note.failed", error: notifyErr,
          });
        }
        throw new Error("Linear credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  async describe(): Promise<AccountDescription> {
    return await this.#withApi(async api => {
      const { user } = await api.getViewer();
      return {
        displayName: user.displayName ?? user.name,
        uniqueName: user.email ?? user.name,
        avatar: { url: user.avatarUrl ?? "" },
      };
    });
  }

  async getAuthenticatedIdentity(): Promise<AuthenticatedIdentity | null> {
    // This vendor does not advertise providesAuth, so this is never used for sign-in.
    return null;
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const parsed = new URL(url);
    if (parsed.hostname !== "linear.app") {
      throw new Error(`Unsupported Linear URL: ${url}`);
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const workspaceUrlKey = segments[0];
    if (!workspaceUrlKey) {
      throw new Error(`Unsupported Linear URL: ${url}`);
    }

    const props: LinearGatekeeperImplProps = {
      userObjectId: this.ctx.props.userObjectId,
      workspaceUrlKey,
      resourceKind: "workspace",
    };
    let resource = WORKSPACE_RESOURCE;

    if (segments[1] === "team" && segments[2]) {
      props.resourceKind = "team";
      props.teamKeyOrId = decodeURIComponent(segments[2]);
      resource = TEAM_RESOURCE;
    } else if (segments[1] === "issue" && segments[2]) {
      props.resourceKind = "issue";
      props.issueRef = decodeURIComponent(segments[2]);
      resource = ISSUE_RESOURCE;
    }

    return { class: this.ctx.exports.LinearGatekeeperImpl({ props }), resource };
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    const account = this.#account();
    const getToken = () => account.getAccessToken();

    if (resourceUrlPattern === WORKSPACE_RESOURCE.urlPattern) {
      return {
        iframeHtml: LINEAR_WORKSPACE_CONFIGURATOR_HTML,
        ui: new RpcStub(new LinearWorkspaceConfiguratorUI(getToken)),
      };
    }
    if (resourceUrlPattern === TEAM_RESOURCE.urlPattern) {
      return {
        iframeHtml: LINEAR_TEAM_CONFIGURATOR_HTML,
        ui: new RpcStub(new LinearTeamConfiguratorUI(getToken)),
      };
    }
    if (resourceUrlPattern === ISSUE_RESOURCE.urlPattern) {
      return {
        iframeHtml: LINEAR_ISSUE_CONFIGURATOR_HTML,
        ui: new RpcStub(new LinearIssueConfiguratorUI(getToken)),
      };
    }
    throw new Error(`Unsupported Linear resource configurator type: ${resourceUrlPattern}`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /**
   * Mint a verifier representing this account, used by LinearGatekeeperImpl.addObserver to confirm a
   * prospective observer may read a bound team/issue (and, for workspace bindings, the workspace and
   * each accessed team). The verifier carries this user's own account id, so the access checks run
   * against the observer's *own* Linear token.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    const props: LinearVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.LinearVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier
//
// Linear uses the "ACL check (single unit)" strategy for team and issue bindings, and "data-set
// tracking (by team)" for workspace bindings (see LinearGatekeeperImpl observer methods). All three
// reduce to per-observer access questions answered against the observer's *own* token:
//   - hasWorkspaceAccess(urlKey): the observer belongs to the workspace (their viewer's organization
//     urlKey matches). Gates workspace-level metadata/member-directory reads, which any member sees.
//   - hasTeamAccess(urlKey, teamKeyOrId): the observer is in the workspace AND can see the team.
//     Linear's `teams` query only returns teams visible to the token's user, so a private team the
//     observer isn't a member of resolves to null — honoring team privacy. Public teams resolve for
//     any member. Team UUIDs are global, so this also rejects a same-key team in another workspace.
//   - hasIssueAccess(urlKey, issueRef): the observer is in the workspace AND can see the issue
//     (issues inherit their team's ACL, so getIssue returns null when the team is hidden).
// The overseer only ever hands this verifier back to a Linear gatekeeper, which may therefore trust
// the boolean results.

type LinearVerifierProps = {
  userObjectId: string;
};

/**
 * The non-standard methods the Linear gatekeeper calls on its own verifier (see addObserver). Not
 * part of the generic GatekeeperUserVerifier contract.
 */
export interface LinearVerifierApi extends GatekeeperUserVerifier {
  hasWorkspaceAccess(workspaceUrlKey: string): Promise<boolean>;
  hasTeamAccess(workspaceUrlKey: string, teamKeyOrId: string): Promise<boolean>;
  hasIssueAccess(workspaceUrlKey: string, issueRef: string): Promise<boolean>;
}

type TeamObservationCheck = {
  excludeObservers?: string[];
  pendingTeams: string[];
  commit(): void;
};

type ObservedTeamState = true | "pending" | "observed";

@validateRpc()
export class LinearVerifier extends WorkerEntrypoint<Env, LinearVerifierProps>
    implements LinearVerifierApi {
  #orgUrlKey?: Promise<string | null>;

  #api(): LinearApi {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return new LinearApi(() => account.getAccessToken());
  }

  // Memoized within this instance: the urlKey of the workspace the observer's token belongs to, or
  // null if the token is broken/expired (a token that can't demonstrate access is treated as "no
  // access" rather than failing the whole open; the observer is re-checked on their next open).
  #workspaceUrlKey(): Promise<string | null> {
    if (!this.#orgUrlKey) {
      this.#orgUrlKey = (async () => {
        try {
          return (await this.#api().getOrganization()).urlKey;
        } catch (error) {
          if (error instanceof LinearApiError && error.isAuthError) return null;
          throw error;
        }
      })();
    }
    return this.#orgUrlKey;
  }

  async hasWorkspaceAccess(workspaceUrlKey: string): Promise<boolean> {
    return (await this.#workspaceUrlKey()) === workspaceUrlKey;
  }

  async hasTeamAccess(workspaceUrlKey: string, teamKeyOrId: string): Promise<boolean> {
    if (!(await this.hasWorkspaceAccess(workspaceUrlKey))) return false;
    try {
      return (await this.#api().findTeam(teamKeyOrId)) !== null;
    } catch (error) {
      if (error instanceof LinearApiError && error.isAuthError) return false;
      throw error;
    }
  }

  async hasIssueAccess(workspaceUrlKey: string, issueRef: string): Promise<boolean> {
    if (!(await this.hasWorkspaceAccess(workspaceUrlKey))) return false;
    try {
      return (await this.#api().getIssue(issueRef)) !== null;
    } catch (error) {
      if (error instanceof LinearApiError && error.isAuthError) return false;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Actions. Every write this gatekeeper performs lands in a Linear workspace, which its members and
// any of their integrations can see, so nothing here is private.

const ISSUE_CREATE: ActionKind = { tag: "linear.issue.create", label: "Create an issue" };
const ISSUE_EDIT: ActionKind = { tag: "linear.issue.edit", label: "Edit an issue's text" };
const ISSUE_TRIAGE: ActionKind = {
  tag: "linear.issue.triage", label: "Change an issue's state, assignee, priority, or scheduling",
};
const ISSUE_LABEL: ActionKind = { tag: "linear.issue.label", label: "Change an issue's labels" };
const ISSUE_ARCHIVE: ActionKind = { tag: "linear.issue.archive", label: "Archive or restore an issue" };
const ISSUE_COMMENT: ActionKind = { tag: "linear.issue.comment", label: "Comment on an issue" };
const LABEL_CREATE: ActionKind = { tag: "linear.label.create", label: "Create a team label" };

const ACTION_CATALOG: ActionCapability[] = [
  {
    kind: ISSUE_CREATE,
    summary: "Create issues in the workspace",
    risk: {
      // Linear issues are archived rather than deleted, which is a human decision.
      reversible: "manual", reach: "creates-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: ISSUE_EDIT,
    summary: "Rewrite the title or description of an existing issue",
    risk: {
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: ISSUE_TRIAGE,
    summary: "Move an issue between states, reassign it, or change its priority, project, parent, or due date",
    risk: {
      // A state change notifies the assignee and can trip Linear automations.
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: false,
    },
  },
  {
    kind: ISSUE_LABEL,
    summary: "Add or remove labels on an issue",
    risk: {
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: false,
    },
  },
  {
    kind: ISSUE_ARCHIVE,
    summary: "Archive an issue, or restore an archived one",
    risk: {
      reversible: "manual", reach: "modifies-content", audience: "shared", freeform: false,
    },
  },
  {
    kind: ISSUE_COMMENT,
    summary: "Post a comment on an issue, notifying its subscribers",
    risk: {
      reversible: "manual", reach: "creates-content", audience: "shared", freeform: true,
    },
  },
  {
    kind: LABEL_CREATE,
    summary: "Create a label in a team's shared label set",
    risk: {
      reversible: "manual", reach: "creates-content", audience: "shared", freeform: true,
    },
  },
];

type LinearGatekeeperImplProps = {
  userObjectId: string;
  workspaceUrlKey: string;
  resourceKind: "workspace" | "team" | "issue";
  teamKeyOrId?: string;
  issueRef?: string;
};

@validateRpc()
export class LinearGatekeeperImpl extends DurableObject<Env, LinearGatekeeperImplProps>
    implements Gatekeeper<LinearWorkspace | LinearTeam | LinearIssue> {

  // ---- private API access (token never leaves the DO) ----

  #account() {
    return this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #run<T>(fn: (api: LinearApi) => Promise<T>): Promise<T> {
    const account = this.#account();
    const api = new LinearApi(() => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof LinearApiError && error.isAuthError) {
        try { await account.noteCredentialsExpired(); } catch (notifyErr) {
          logger.warn("failed to note credential expiry", {
            event: "credentials.expiry.note.failed", error: notifyErr,
          });
        }
        throw new Error("Linear credentials have expired or been revoked. Please reconnect the account.", { cause: error });
      }
      throw error;
    }
  }

  // ---- helpers used by session impls (local, same-DO calls; non-generic, no token) ----

  /** The workspace url key (first path segment of linear.app URLs), used to build canonical URLs. */
  workspaceKey(): string {
    return this.ctx.props.workspaceUrlKey;
  }

  // -------------------------------------------------------------------------
  // Observer tracking (see addObserver/removeObserver). Only workspace bindings track state; team
  // and issue bindings are single ACL units verified up front, with nothing to log or exclude.

  #observerKey(id: string): string { return `observer:${id}`; }
  #observedTeamKey(teamId: string): string { return `observedTeam:${teamId}`; }

  #isTeamObserved(teamId: string): boolean {
    const state = this.ctx.storage.kv.get<ObservedTeamState>(this.#observedTeamKey(teamId));
    return state === true || state === "observed";
  }

  #listTrackedTeams(): string[] {
    const prefix = "observedTeam:";
    return [...this.ctx.storage.kv.list<ObservedTeamState>({ prefix })]
      .map(([key]) => key.slice(prefix.length));
  }

  *#listObservers(): IterableIterator<[string, Fetcher<LinearVerifierApi>]> {
    const prefix = "observer:";
    for (const [key, verifier] of this.ctx.storage.kv.list<Fetcher<LinearVerifierApi>>({ prefix })) {
      yield [key.slice(prefix.length), verifier];
    }
  }

  // Workspace bindings only. Marks unknown teams pending and returns current observers who cannot
  // access any pending team in this attempt. Authorization promotes them; failed attempts remain
  // pending and are rechecked on retry.
  async #prepareTeamObservation(teamIds: string[]): Promise<TeamObservationCheck> {
    const pendingTeams = [...new Set(teamIds)].filter(id => !this.#isTeamObserved(id));
    if (pendingTeams.length === 0) return {pendingTeams, commit() {}};
    for (const teamId of pendingTeams) {
      const key = this.#observedTeamKey(teamId);
      if (this.ctx.storage.kv.get<ObservedTeamState>(key) === undefined) {
        this.ctx.storage.kv.put(key, "pending");
      }
    }
    const observerAccess = await Promise.all([...this.#listObservers()].map(async ([id, verifier]) => {
      const access = await Promise.all(pendingTeams.map(
        teamId => verifier.hasTeamAccess(this.ctx.props.workspaceUrlKey, teamId),
      ));
      return [id, access.every(hasAccess => hasAccess)] as const;
    }));
    const excluded = observerAccess.filter(([, hasAccess]) => !hasAccess).map(([id]) => id);
    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      pendingTeams,
      commit: () => {
        for (const teamId of pendingTeams) {
          this.ctx.storage.kv.put(this.#observedTeamKey(teamId), "observed");
        }
      },
    };
  }

  /**
   * Authorize an observation that reveals data belonging to specific team(s). For workspace bindings
   * this also tracks those teams as observed data sets and excludes any observers lacking access to a
   * newly-seen one; for team/issue bindings it is a plain authorizeObservation (the bound resource is
   * a single ACL unit verified up front). Every team-scoped read should go through this rather than
   * calling recorder.authorizeObservation directly. `teamIds` may be empty for workspace-level
   * reads (org metadata, member directory) that any workspace member may see.
   */
  async authorizeTeamObservation(
    recorder: RpcStub<ActionRecorder>,
    teamIds: string[],
    description: ObservationDescription,
  ): Promise<void> {
    const check = this.ctx.props.resourceKind === "workspace" && teamIds.length > 0
      ? await this.#prepareTeamObservation(teamIds)
      : {pendingTeams: [], commit() {}};
    await recorder.authorizeObservation({
      ...description, excludeObservers: check.excludeObservers,
    });
    check.commit();
  }

  /**
   * Authorize an action, run it against Linear, and record its outcome. A failure after the request
   * was sent leaves the outcome unknown, so it is reported as possibly having taken effect.
   */
  @skipRpcValidation()
  async performAction<T>(
    recorder: RpcStub<ActionRecorder>,
    description: ActionDescription,
    perform: (api: LinearApi) => Promise<T>,
  ): Promise<T> {
    const handle = await recorder.authorizeAction(description);
    try {
      const result = await this.#run(perform);
      await handle.succeeded();
      return result;
    } catch (error) {
      await handle.failed(error instanceof Error ? error.message : String(error), true);
      throw error;
    }
  }

  // ---- concrete observation methods (return raw data; sessions normalize + authorize) ----

  async orgRaw(): Promise<RawOrganization> {
    return await this.#run(api => api.getOrganization());
  }

  async teamsPage(after: string | undefined, first: number, includeArchived: boolean): Promise<RawConnection<RawTeam>> {
    return await this.#run(api => api.listTeams({ first, after, includeArchived }));
  }

  async findTeamRaw(keyOrId: string): Promise<RawTeam> {
    const team = await this.#run(api => api.findTeam(keyOrId));
    if (!team) throw new Error(`Linear team not found: ${keyOrId}`);
    return team;
  }

  async projectsPage(teamId: string | null, after: string | undefined, first: number, includeArchived: boolean): Promise<RawConnection<RawProject>> {
    return await this.#run(api => api.listProjects(teamId ? { teamId } : {}, { first, after, includeArchived }));
  }

  async issuesPage(args: IssuePageArgs, after: string | undefined, first: number): Promise<RawConnection<RawIssue>> {
    const { filter, orderBy } = buildIssueFilter(args);
    return await this.#run(api => api.listIssues({ first, after, filter, orderBy, includeArchived: args.includeArchived }));
  }

  async searchPage(term: string, args: IssuePageArgs, after: string | undefined, first: number): Promise<RawConnection<RawIssue>> {
    const { filter } = buildIssueFilter(args);
    return await this.#run(api => api.searchIssues({ term, first, after, filter, includeArchived: args.includeArchived }));
  }

  async issueRaw(ref: string): Promise<RawIssue> {
    const issue = await this.#run(api => api.getIssue(ref));
    if (!issue) throw new Error(`Linear issue not found: ${ref}`);
    return issue;
  }

  async commentsPage(ref: string, after: string | undefined, first: number): Promise<RawConnection<RawComment>> {
    return await this.#run(api => api.listComments(ref, { first, after }));
  }

  // Short-TTL cache in DO storage for rarely-changing team metadata that sits on hot paths
  // (setState/addLabels/createIssue each resolve these). Avoids redundant GraphQL calls.
  async #cachedFetch<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const hit = this.ctx.storage.kv.get<{ data: T; expiresAt: number }>(key);
    if (hit && Date.now() < hit.expiresAt) return hit.data;
    const data = await fetcher();
    this.ctx.storage.kv.put(key, { data, expiresAt: Date.now() + ttlMs });
    return data;
  }

  async workflowStatesRaw(teamId: string): Promise<RawWorkflowState[]> {
    return await this.#cachedFetch(`cache:states:${teamId}`, METADATA_CACHE_TTL_MS,
      () => this.#run(api => api.listWorkflowStates(teamId)));
  }

  async labelsRaw(teamId: string): Promise<RawLabel[]> {
    return await this.#cachedFetch(`cache:labels:${teamId}`, METADATA_CACHE_TTL_MS,
      () => this.#run(api => api.listLabels(teamId)));
  }

  /** Drops the cached label set for a team, after a create changed it. */
  invalidateLabels(teamId: string): void {
    this.ctx.storage.kv.delete(`cache:labels:${teamId}`);
  }

  async cyclesPage(teamId: string, after: string | undefined, first: number): Promise<RawConnection<RawCycle>> {
    return await this.#run(api => api.listCycles(teamId, { first, after }));
  }

  async getProjectRaw(projectId: string): Promise<RawProject | null> {
    return await this.#run(api => api.getProject(projectId));
  }

  async teamMembersRaw(teamId: string): Promise<RawUser[]> {
    return await this.#cachedFetch(`cache:members:${teamId}`, METADATA_CACHE_TTL_MS,
      () => this.#run(api => api.listTeamMembers(teamId)));
  }

  async findMembersRaw(query: string | undefined): Promise<RawUser[]> {
    const filter = query
      ? { or: [
          { email: { containsIgnoreCase: query } },
          { displayName: { containsIgnoreCase: query } },
          { name: { containsIgnoreCase: query } },
        ] }
      : undefined;
    return await this.#run(api => api.listUsers({ first: 50, filter }));
  }

  /** Resolve an assignee string (email / display name / UUID) to a single member. */
  async resolveMemberRaw(query: string): Promise<RawUser> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query)) {
      const byId = await this.#run(api => api.listUsers({ first: 1, filter: { id: { eq: query } } }));
      if (byId[0]) return byId[0];
    }
    const users = await this.#run(api => api.listUsers({
      first: 10,
      filter: { or: [
        { email: { eqIgnoreCase: query } },
        { displayName: { eqIgnoreCase: query } },
        { name: { eqIgnoreCase: query } },
      ] },
    }));
    if (users.length === 0) throw new Error(`No workspace member matches "${query}".`);
    if (users.length > 1) {
      throw new Error(`"${query}" matches multiple members; use an email or UUID to disambiguate.`);
    }
    return users[0];
  }

  // ---- Gatekeeper interface ----

  async describe(): Promise<ResourceDescription> {
    const kind = this.ctx.props.resourceKind;
    const workspace = this.ctx.props.workspaceUrlKey;

    if (kind === "team") {
      const teamKeyOrId = this.ctx.props.teamKeyOrId!;
      const team = await this.#run(api => api.findTeam(teamKeyOrId));
      return {
        url: `https://linear.app/${workspace}/team/${team?.key ?? teamKeyOrId}`,
        title: team ? `${team.key} · ${team.name}` : `Linear team ${teamKeyOrId}`,
        snippet: snippet(team?.description, "Linear team"),
        suggestedBindingName: "LINEAR_TEAM",
        tsType: "LinearTeam",
      };
    }

    if (kind === "issue") {
      const issueRef = this.ctx.props.issueRef!;
      const issue = await this.#run(api => api.getIssue(issueRef));
      return {
        url: issue?.url ?? `https://linear.app/${workspace}/issue/${issueRef}`,
        title: issue ? `${issue.identifier} ${issue.title}` : `Linear issue ${issueRef}`,
        snippet: snippet(issue?.description, "Linear issue"),
        suggestedBindingName: "LINEAR_ISSUE",
        tsType: "LinearIssue",
      };
    }

    const org = await this.#run(api => api.getOrganization());
    return {
      url: `https://linear.app/${org.urlKey}`,
      title: `${org.name} (Linear)`,
      snippet: "Linear workspace",
      suggestedBindingName: "LINEAR_WORKSPACE",
      tsType: "LinearWorkspace",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getActionCatalog(): Promise<ActionCapability[]> {
    return ACTION_CATALOG;
  }

  async startSession(recorder: RpcStub<ActionRecorder>): Promise<LinearWorkspace | LinearTeam | LinearIssue> {
    switch (this.ctx.props.resourceKind) {
      case "team":
        return new LinearTeamSessionImpl(this, recorder.dup(), this.ctx.props.teamKeyOrId!);
      case "issue":
        return new LinearIssueImpl(this, recorder.dup(), this.ctx.props.issueRef!);
      default:
        return new LinearWorkspaceSessionImpl(this, recorder.dup());
    }
  }

  /**
   * Observer tracking. Strategy depends on the binding's granularity:
   *
   * - Team / Issue binding — "ACL check (single unit)". The binding is one team (or one issue, which
   *   inherits its team's ACL), so we just confirm the observer can see it (hasTeamAccess /
   *   hasIssueAccess, against their own token, honoring team privacy). Nothing read later could be
   *   outside that unit, so no observers are tracked and removeObserver is a no-op.
   *
   * - Workspace binding — "data-set tracking (by team)". Workspace members may belong to different
   *   teams, so we track which teams' data the Gadget has actually observed and verify each observer
   *   against them. addObserver requires workspace membership (so workspace-level metadata and the
   *   member directory are fine to show) plus access to every already-observed team; later, the first
   *   observation of a *new* team excludes any observer lacking it (see #prepareTeamObservation). Verified
   *   observers are remembered (their verifier stored) so that forward-exclusion check can run.
   *
   * The overseer re-runs addObserver on every open, catching loss of access promptly.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const verifier = user as unknown as Fetcher<LinearVerifierApi>;
    const ws = this.ctx.props.workspaceUrlKey;

    if (this.ctx.props.resourceKind === "team") {
      const teamKeyOrId = this.ctx.props.teamKeyOrId!;
      if (!(await verifier.hasTeamAccess(ws, teamKeyOrId))) {
        throw new Error(
          `This collaborator does not have access to the Linear team \`${teamKeyOrId}\`, so they ` +
          `cannot be allowed to observe data this workspace read from it.`);
      }
      return;
    }

    if (this.ctx.props.resourceKind === "issue") {
      const issueRef = this.ctx.props.issueRef!;
      if (!(await verifier.hasIssueAccess(ws, issueRef))) {
        throw new Error(
          `This collaborator does not have access to the Linear issue \`${issueRef}\`, so they ` +
          `cannot be allowed to observe data this workspace read from it.`);
      }
      return;
    }

    // Workspace binding.
    if (!(await verifier.hasWorkspaceAccess(ws))) {
      throw new Error(
        `This collaborator is not a member of the Linear workspace \`${ws}\`, so they cannot be ` +
        `allowed to observe it.`);
    }
    const checked = new Set<string>();
    while (true) {
      const teamIds = this.#listTrackedTeams().filter(teamId => !checked.has(teamId));
      if (teamIds.length === 0) {
        this.ctx.storage.kv.put(this.#observerKey(id), verifier);
        return;
      }
      const teamAccess = await Promise.all(
        teamIds.map(teamId => verifier.hasTeamAccess(ws, teamId)));
      if (teamAccess.some(hasAccess => !hasAccess)) {
        throw new Error(
          `This collaborator does not have access to a Linear team whose data this workspace has read, ` +
          `so they cannot be allowed to observe it.`);
      }
      for (const teamId of teamIds) checked.add(teamId);
    }
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(this.#observerKey(id));
  }
}

// ---------------------------------------------------------------------------
// Cursor: lazily pages through a Linear connection, authorizing each page.

class StreamingCursor<TRaw, TOut> extends RpcTarget implements Cursor<TOut> {
  #gk: LinearGatekeeperImpl;
  #fetchPage: (after: string | undefined) => Promise<RawConnection<TRaw>>;
  #normalize: (raw: TRaw) => TOut;
  #recorder: RpcStub<ActionRecorder>;
  #describe: (items: TOut[]) => ObservationDescription;
  // The team(s) whose data a given raw page reveals, for workspace-binding observer tracking (see
  // LinearGatekeeperImpl.authorizeTeamObservation). Empty for workspace-level pages any member sees.
  #teamIdsOf: (rawItems: TRaw[]) => string[];
  #after: string | undefined = undefined;
  #done = false;

  constructor(
    gk: LinearGatekeeperImpl,
    recorder: RpcStub<ActionRecorder>,
    fetchPage: (after: string | undefined) => Promise<RawConnection<TRaw>>,
    normalize: (raw: TRaw) => TOut,
    describe: (items: TOut[]) => ObservationDescription,
    teamIdsOf: (rawItems: TRaw[]) => string[],
  ) {
    super();
    this.#gk = gk;
    this.#recorder = recorder;
    this.#fetchPage = fetchPage;
    this.#normalize = normalize;
    this.#describe = describe;
    this.#teamIdsOf = teamIdsOf;
  }

  async next(): Promise<TOut[] | null> {
    if (this.#done) return null;
    const conn = await this.#fetchPage(this.#after);
    const items = conn.nodes.map(this.#normalize);
    // Authorize before advancing pagination state, so a denied page can be retried.
    await this.#gk.authorizeTeamObservation(this.#recorder, this.#teamIdsOf(conn.nodes), this.#describe(items));
    this.#after = conn.pageInfo.endCursor ?? undefined;
    if (!conn.pageInfo.hasNextPage) this.#done = true;
    return items;
  }

  [Symbol.dispose](): void {
    disposeStub(this.#recorder);
  }
}

// ---------------------------------------------------------------------------
// Session: Workspace

@validateRpc()
class LinearWorkspaceSessionImpl extends RpcTarget implements LinearWorkspace {
  #gk: LinearGatekeeperImpl;
  #recorder: RpcStub<ActionRecorder>;
  #wsKey: string;

  constructor(gk: LinearGatekeeperImpl, recorder: RpcStub<ActionRecorder>) {
    super();
    this.#gk = gk;
    this.#recorder = recorder;
    this.#wsKey = gk.workspaceKey();
  }

  [Symbol.dispose](): void {
    disposeStub(this.#recorder);
  }

  async getMetadata(): Promise<LinearWorkspaceMetadata> {
    const org = await this.#gk.orgRaw();
    // Workspace-level metadata is visible to any workspace member, so no team attribution is needed.
    await this.#gk.authorizeTeamObservation(this.#recorder, [], {
      title: "Read workspace info",
      description: `Read metadata for the Linear workspace **${org.name}**.`,
    });
    return { id: org.id, name: org.name, urlKey: org.urlKey, url: `https://linear.app/${org.urlKey}` };
  }

  async listTeams(options?: LinearPageOptions): Promise<Cursor<LinearTeamSummary>> {
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawTeam, LinearTeamSummary>(
      this.#gk,
      this.#recorder.dup(),
      after => this.#gk.teamsPage(after, first, options?.includeArchived ?? false),
      raw => normTeamSummary(raw, this.#wsKey),
      items => ({ title: "List teams", description: `Listed ${items.length} team(s) in the workspace.` }),
      // Each listed team is itself a data set whose existence/metadata (incl. private teams) the
      // observer must be allowed to see.
      teams => teams.map(t => t.id),
    );
  }

  async getTeam(teamKeyOrId: string): Promise<LinearTeam> {
    return new LinearTeamSessionImpl(this.#gk, this.#recorder.dup(), teamKeyOrId);
  }

  async listProjects(options?: LinearPageOptions): Promise<Cursor<LinearProjectSummary>> {
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawProject, LinearProjectSummary>(
      this.#gk,
      this.#recorder.dup(),
      after => this.#gk.projectsPage(null, after, first, options?.includeArchived ?? false),
      normProjectSummary,
      items => ({ title: "List projects", description: `Listed ${items.length} project(s) in the workspace.` }),
      // A project's access is gated by the team(s) it belongs to (populated by the workspace-wide
      // query via PROJECT_LIST_FIELDS), so attribute the listing to all of them.
      projects => projects.flatMap(p => (p.teams?.nodes ?? []).map(t => t.id)),
    );
  }

  async listIssues(filter?: LinearIssueFilter): Promise<Cursor<LinearIssueSummary>> {
    const first = clampPageSize(filter?.resultsPerPage);
    const args = issueArgs(filter);
    return new StreamingCursor<RawIssue, LinearIssueSummary>(
      this.#gk,
      this.#recorder.dup(),
      after => this.#gk.issuesPage(args, after, first),
      raw => normIssueSummary(raw, this.#wsKey),
      items => ({ title: "List issues", description: `Listed ${items.length} issue(s) across the workspace.` }),
      issues => issues.map(i => i.team.id),
    );
  }

  async searchIssues(query: LinearIssueSearch): Promise<Cursor<LinearIssueSummary>> {
    const first = clampPageSize(query.resultsPerPage);
    const args = issueArgs(query);
    return new StreamingCursor<RawIssue, LinearIssueSummary>(
      this.#gk,
      this.#recorder.dup(),
      after => this.#gk.searchPage(query.text, args, after, first),
      raw => normIssueSummary(raw, this.#wsKey),
      items => ({ title: "Search issues", description: `Searched workspace issues for "${query.text}" (${items.length} result(s)).` }),
      issues => issues.map(i => i.team.id),
    );
  }

  async getIssue(id: string): Promise<LinearIssue> {
    return new LinearIssueImpl(this.#gk, this.#recorder.dup(), id);
  }

  async createIssue(options: LinearCreateIssueOptions): Promise<LinearIssue> {
    return await createIssue(this.#gk, this.#recorder, options, { requireTeam: true });
  }

  async findMembers(query?: string): Promise<LinearUser[]> {
    const users = await this.#gk.findMembersRaw(query);
    // The workspace member directory is visible to any workspace member, so no team attribution.
    await this.#gk.authorizeTeamObservation(this.#recorder, [], {
      title: "Find members",
      description: `Looked up ${users.length} workspace member(s)${query ? ` matching "${query}"` : ""}.`,
    });
    return users.map(u => normUser(u)!).filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// Session: Team

@validateRpc()
class LinearTeamSessionImpl extends RpcTarget implements LinearTeam {
  #gk: LinearGatekeeperImpl;
  #recorder: RpcStub<ActionRecorder>;
  #teamKeyOrId: string;
  #wsKey: string;
  #teamPromise?: Promise<RawTeam>;

  constructor(gk: LinearGatekeeperImpl, recorder: RpcStub<ActionRecorder>, teamKeyOrId: string) {
    super();
    this.#gk = gk;
    this.#recorder = recorder;
    this.#teamKeyOrId = teamKeyOrId;
    this.#wsKey = gk.workspaceKey();
  }

  [Symbol.dispose](): void {
    disposeStub(this.#recorder);
  }

  #team(): Promise<RawTeam> {
    if (!this.#teamPromise) {
      this.#teamPromise = this.#gk.findTeamRaw(this.#teamKeyOrId).catch(err => {
        this.#teamPromise = undefined;
        throw err;
      });
    }
    return this.#teamPromise;
  }

  async getMetadata(): Promise<LinearTeamMetadata> {
    const team = await this.#team();
    await this.#gk.authorizeTeamObservation(this.#recorder, [team.id], {
      title: "Read team info",
      description: `Read metadata for team **${team.key} · ${team.name}**.`,
    });
    return normTeamSummary(team, this.#wsKey);
  }

  async listIssues(filter?: LinearIssueFilter): Promise<Cursor<LinearIssueSummary>> {
    const team = await this.#team();
    const first = clampPageSize(filter?.resultsPerPage);
    const args = { ...issueArgs(filter), teamId: team.id };
    return new StreamingCursor<RawIssue, LinearIssueSummary>(
      this.#gk,
      this.#recorder.dup(),
      after => this.#gk.issuesPage(args, after, first),
      raw => normIssueSummary(raw, this.#wsKey),
      items => ({ title: "List team issues", description: `Listed ${items.length} issue(s) in team ${team.key}.` }),
      () => [team.id],
    );
  }

  async searchIssues(query: LinearIssueSearch): Promise<Cursor<LinearIssueSummary>> {
    const team = await this.#team();
    const first = clampPageSize(query.resultsPerPage);
    const args = { ...issueArgs(query), teamId: team.id };
    return new StreamingCursor<RawIssue, LinearIssueSummary>(
      this.#gk,
      this.#recorder.dup(),
      after => this.#gk.searchPage(query.text, args, after, first),
      raw => normIssueSummary(raw, this.#wsKey),
      items => ({ title: "Search team issues", description: `Searched team ${team.key} for "${query.text}" (${items.length} result(s)).` }),
      () => [team.id],
    );
  }

  async getIssue(id: string): Promise<LinearIssue> {
    const team = await this.#team();
    return new LinearIssueImpl(this.#gk, this.#recorder.dup(), id, team.id);
  }

  async createIssue(options: LinearCreateIssueOptions): Promise<LinearIssue> {
    const team = await this.#team();
    return await createIssue(this.#gk, this.#recorder, { ...options, teamId: team.id }, { requireTeam: false }, team.id);
  }

  async listWorkflowStates(): Promise<LinearWorkflowState[]> {
    const team = await this.#team();
    const states = await this.#gk.workflowStatesRaw(team.id);
    await this.#gk.authorizeTeamObservation(this.#recorder, [team.id], {
      title: "List workflow states",
      description: `Listed ${states.length} workflow state(s) for team ${team.key}.`,
    });
    return states.map(normState).toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  async listLabels(): Promise<LinearLabel[]> {
    const team = await this.#team();
    const labels = await this.#gk.labelsRaw(team.id);
    await this.#gk.authorizeTeamObservation(this.#recorder, [team.id], {
      title: "List labels",
      description: `Listed ${labels.length} label(s) for team ${team.key}.`,
    });
    return labels.map(normLabel);
  }

  async createLabel(name: string, options?: LinearCreateLabelOptions): Promise<LinearLabel> {
    const team = await this.#team();
    const existing = await this.#gk.labelsRaw(team.id);
    if (existing.some(l => l.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A label named "${name}" already exists in team ${team.key}.`);
    }
    const label = await this.#gk.performAction(
      this.#recorder,
      {
        title: `Create label "${name}" in ${team.key}`,
        description: `Create a new label named **${name}**${options?.color ? ` (color ${options.color})` : ""} in team ${team.key}.`,
        actionKind: LABEL_CREATE,
      },
      api => api.createLabel({
        teamId: team.id, name, color: options?.color, description: options?.description,
      }),
    );
    this.#gk.invalidateLabels(team.id);
    return normLabel(label);
  }

  async listProjects(options?: LinearPageOptions): Promise<Cursor<LinearProjectSummary>> {
    const team = await this.#team();
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawProject, LinearProjectSummary>(
      this.#gk,
      this.#recorder.dup(),
      after => this.#gk.projectsPage(team.id, after, first, options?.includeArchived ?? false),
      normProjectSummary,
      items => ({ title: "List team projects", description: `Listed ${items.length} project(s) for team ${team.key}.` }),
      // Team-scoped listing: the projects are reached through this team, so attribute to it.
      () => [team.id],
    );
  }

  async listCycles(options?: LinearPageOptions): Promise<Cursor<LinearCycleSummary>> {
    const team = await this.#team();
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawCycle, LinearCycleSummary>(
      this.#gk,
      this.#recorder.dup(),
      after => this.#gk.cyclesPage(team.id, after, first),
      normCycle,
      items => ({ title: "List cycles", description: `Listed ${items.length} cycle(s) for team ${team.key}.` }),
      () => [team.id],
    );
  }

  async listMembers(): Promise<LinearUser[]> {
    const team = await this.#team();
    const members = await this.#gk.teamMembersRaw(team.id);
    await this.#gk.authorizeTeamObservation(this.#recorder, [team.id], {
      title: "List team members",
      description: `Listed ${members.length} member(s) of team ${team.key}.`,
    });
    return members.map(m => normUser(m)!).filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// Session: Issue

@validateRpc()
class LinearIssueImpl extends RpcTarget implements LinearIssue {
  #gk: LinearGatekeeperImpl;
  #recorder: RpcStub<ActionRecorder>;
  #ref: string;
  #wsKey: string;
  // When set, this handle is limited to issues in this team (a team-scoped grant). Prevents a
  // team grant from reaching issues in other teams via getIssue / setParent.
  #teamScope?: string;

  constructor(gk: LinearGatekeeperImpl, recorder: RpcStub<ActionRecorder>, ref: string, teamScope?: string) {
    super();
    this.#gk = gk;
    this.#recorder = recorder;
    this.#ref = ref;
    this.#wsKey = gk.workspaceKey();
    this.#teamScope = teamScope;
  }

  [Symbol.dispose](): void {
    disposeStub(this.#recorder);
  }

  // Fetch this issue, enforcing the team scope (if any) so a team grant can't reach other teams.
  async #requireIssue(): Promise<RawIssue> {
    const issue = await this.#gk.issueRaw(this.#ref);
    if (this.#teamScope && issue.team.id !== this.#teamScope) {
      throw new Error(`Issue ${issue.identifier} is not in the team this connection is limited to.`);
    }
    return issue;
  }

  async getDetails(): Promise<LinearIssueDetails> {
    const issue = await this.#requireIssue();
    await this.#gk.authorizeTeamObservation(this.#recorder, [issue.team.id], {
      title: `Read issue ${issue.identifier}`,
      description: `Read details of issue **${issue.identifier} ${issue.title}**.`,
    });
    return normIssueDetails(issue, this.#wsKey);
  }

  async setTitle(title: string): Promise<void> {
    const issue = await this.#requireIssue();
    await this.#gk.performAction(
      this.#recorder,
      { title: `Rename ${issue.identifier}`,
        description: `Change the title of **${issue.identifier}** from "${issue.title}" to "${title}".`,
        actionKind: ISSUE_EDIT },
      api => api.updateIssue(issue.id, { title }),
    );
  }

  async setDescription(descriptionMarkdown: string): Promise<void> {
    const issue = await this.#requireIssue();
    await this.#gk.performAction(
      this.#recorder,
      { title: `Edit description of ${issue.identifier}`,
        description: `Replace the description of **${issue.identifier} ${issue.title}**.`,
        actionKind: ISSUE_EDIT },
      api => api.updateIssue(issue.id, { description: descriptionMarkdown }),
    );
  }

  async setState(state: string): Promise<void> {
    const issue = await this.#requireIssue();
    const states = await this.#gk.workflowStatesRaw(issue.team.id);
    const target = states.find(s => s.name.toLowerCase() === state.toLowerCase());
    if (!target) {
      throw new Error(`No workflow state named "${state}" in team ${issue.team.key}.`);
    }
    await this.#gk.performAction(
      this.#recorder,
      { title: `Move ${issue.identifier} to ${target.name}`,
        description: `Change the state of **${issue.identifier} ${issue.title}** from "${issue.state?.name ?? "Unknown"}" to "${target.name}".`,
        actionKind: ISSUE_TRIAGE },
      api => api.updateIssue(issue.id, { stateId: target.id }),
    );
  }

  async setAssignee(assignee: string | null): Promise<void> {
    const issue = await this.#requireIssue();
    let assigneeId: string | null = null;
    let label = "Unassign";
    if (assignee !== null) {
      const assigneeUser = await this.#gk.resolveMemberRaw(assignee);
      assigneeId = assigneeUser.id;
      label = `Assign to ${assigneeUser.displayName ?? assigneeUser.name}`;
    }
    await this.#gk.performAction(
      this.#recorder,
      { title: `${label}: ${issue.identifier}`,
        description: `${label} for issue **${issue.identifier} ${issue.title}**.`,
        actionKind: ISSUE_TRIAGE },
      api => api.updateIssue(issue.id, { assigneeId }),
    );
  }

  async setPriority(priority: LinearPriority): Promise<void> {
    const issue = await this.#requireIssue();
    await this.#gk.performAction(
      this.#recorder,
      { title: `Set priority of ${issue.identifier} to ${priority}`,
        description: `Change the priority of **${issue.identifier} ${issue.title}** to "${priority}".`,
        actionKind: ISSUE_TRIAGE },
      api => api.updateIssue(issue.id, { priority: PRIORITY_TO_NUM[priority] }),
    );
  }

  async addLabels(labels: string[]): Promise<void> {
    const issue = await this.#requireIssue();
    // Resolve against real labels *and* labels created earlier in this session that haven't been
    // applied yet — those are attachable too (their ids resolve to the real label at apply time).
    const teamLabels = await this.#gk.labelsRaw(issue.team.id);
    const byName = new Map(teamLabels.map(l => [l.name.toLowerCase(), l]));
    const resolved: RawLabel[] = [];
    for (const name of labels) {
      const found = byName.get(name.toLowerCase());
      if (!found) {
        throw new Error(
          `No label named "${name}" exists in team ${issue.team.key}. ` +
          `Create it with createLabel() first.`);
      }
      resolved.push(found);
    }
    const current = (issue.labels?.nodes ?? []).map(l => l.id);
    await this.#gk.performAction(
      this.#recorder,
      { title: `Add labels to ${issue.identifier}`,
        description: `Add label(s) ${labels.map(l => `"${l}"`).join(", ")} to **${issue.identifier} ${issue.title}**.`,
        actionKind: ISSUE_LABEL },
      api => api.updateIssue(
        issue.id, { labelIds: [...new Set([...current, ...resolved.map(l => l.id)])] }),
    );
  }

  async removeLabels(labels: string[]): Promise<void> {
    const issue = await this.#requireIssue();
    const removeNames = new Set(labels.map(l => l.toLowerCase()));
    // Map the requested names to the label ids currently on the issue; ignore names not present.
    const remaining = (issue.labels?.nodes ?? [])
      .filter(l => !removeNames.has(l.name.toLowerCase()))
      .map(l => l.id);
    await this.#gk.performAction(
      this.#recorder,
      { title: `Remove labels from ${issue.identifier}`,
        description: `Remove label(s) ${labels.map(l => `"${l}"`).join(", ")} from **${issue.identifier} ${issue.title}**.`,
        actionKind: ISSUE_LABEL },
      api => api.updateIssue(issue.id, { labelIds: remaining }),
    );
  }

  async setProject(projectId: string | null): Promise<void> {
    const issue = await this.#requireIssue();
    if (projectId && !(await this.#gk.getProjectRaw(projectId))) {
      throw new Error(`Project not found: ${projectId}`);
    }
    await this.#gk.performAction(
      this.#recorder,
      { title: `${projectId ? "Move" : "Remove"} ${issue.identifier} ${projectId ? "into a project" : "from its project"}`,
        description: projectId
          ? `Move **${issue.identifier} ${issue.title}** into project ${projectId}.`
          : `Remove **${issue.identifier} ${issue.title}** from its project.`,
        actionKind: ISSUE_TRIAGE },
      api => api.updateIssue(issue.id, { projectId }),
    );
  }

  async setDueDate(date: string | null): Promise<void> {
    const issue = await this.#requireIssue();
    await this.#gk.performAction(
      this.#recorder,
      { title: `Set due date of ${issue.identifier}`,
        description: date
          ? `Set the due date of **${issue.identifier} ${issue.title}** to ${date}.`
          : `Clear the due date of **${issue.identifier} ${issue.title}**.`,
        actionKind: ISSUE_TRIAGE },
      api => api.updateIssue(issue.id, { dueDate: date }),
    );
  }

  async setParent(parentId: string | null): Promise<void> {
    const issue = await this.#requireIssue();
    let resolvedParentId: string | null = null;
    if (parentId !== null) {
      const parent = await this.#gk.issueRaw(parentId);
      if (this.#teamScope && parent.team.id !== this.#teamScope) {
        throw new Error(`Parent issue ${parent.identifier} is not in the team this connection is limited to.`);
      }
      resolvedParentId = parent.id;
    }
    await this.#gk.performAction(
      this.#recorder,
      { title: `${parentId ? "Set" : "Clear"} parent of ${issue.identifier}`,
        description: parentId
          ? `Make **${issue.identifier} ${issue.title}** a sub-issue of ${parentId}.`
          : `Detach **${issue.identifier} ${issue.title}** from its parent.`,
        actionKind: ISSUE_TRIAGE },
      api => api.updateIssue(issue.id, { parentId: resolvedParentId }),
    );
  }

  async readComments(options?: LinearPageOptions): Promise<Cursor<LinearComment>> {
    // Resolve the issue (also enforcing team scope, if any) so the comment thread can be attributed
    // to the issue's team for observer tracking.
    const teamId = (await this.#requireIssue()).team.id;
    const ref = this.#ref;
    const first = clampPageSize(options?.resultsPerPage);
    return new StreamingCursor<RawComment, LinearComment>(
      this.#gk,
      this.#recorder.dup(),
      after => this.#gk.commentsPage(ref, after, first),
      normComment,
      items => ({ title: `Read comments on ${ref}`, description: `Read ${items.length} comment(s) on issue ${ref}.` }),
      () => [teamId],
    );
  }

  async postComment(bodyMarkdown: string): Promise<void> {
    const issue = await this.#requireIssue();
    await this.#gk.performAction(
      this.#recorder,
      { title: `Comment on ${issue.identifier}`,
        description: `Post a comment on **${issue.identifier} ${issue.title}**:\n\n${bodyMarkdown}`,
        actionKind: ISSUE_COMMENT },
      api => api.createComment(issue.id, bodyMarkdown),
    );
  }

  async createSubIssue(options: LinearCreateIssueOptions): Promise<LinearIssue> {
    const issue = await this.#requireIssue();
    // Always scope the sub-issue handle to the parent issue's team, so an issue-scoped grant (which
    // has no #teamScope of its own) can't use the returned handle to queue cross-team mutations.
    return await createIssue(
      this.#gk, this.#recorder,
      { ...options, teamId: issue.team.id, parentId: issue.id },
      { requireTeam: false },
      issue.team.id);
  }

  async archive(): Promise<void> {
    const issue = await this.#requireIssue();
    await this.#gk.performAction(
      this.#recorder,
      { title: `Archive ${issue.identifier}`,
        description: `Archive issue **${issue.identifier} ${issue.title}**.`,
        actionKind: ISSUE_ARCHIVE },
      api => api.setIssueArchived(issue.id, true),
    );
  }

  async unarchive(): Promise<void> {
    const issue = await this.#requireIssue();
    await this.#gk.performAction(
      this.#recorder,
      { title: `Unarchive ${issue.identifier}`,
        description: `Restore archived issue **${issue.identifier} ${issue.title}**.`,
        actionKind: ISSUE_ARCHIVE },
      api => api.setIssueArchived(issue.id, false),
    );
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

function issueArgs(filter: LinearIssueFilter | undefined): IssuePageArgs {
  return {
    state: filter?.state,
    assignee: filter?.assignee,
    labels: filter?.labels,
    priority: filter?.priority,
    projectId: filter?.projectId,
    sort: filter?.sort,
    includeArchived: filter?.includeArchived,
  };
}

async function createIssue(
  gk: LinearGatekeeperImpl,
  recorder: RpcStub<ActionRecorder>,
  options: LinearCreateIssueOptions,
  opts: { requireTeam: boolean },
  teamScope?: string,
): Promise<LinearIssue> {
  if (!options.teamId && !options.teamKey && opts.requireTeam) {
    throw new Error("createIssue requires a teamKey (or teamId) at this granularity.");
  }
  const teamKeyOrId = options.teamId ?? options.teamKey;
  if (!teamKeyOrId) throw new Error("Could not determine which team to create the issue in.");
  const team = await gk.findTeamRaw(teamKeyOrId);
  const teamId = team.id;

  const input: IssueCreateInput = {
    teamId,
    title: options.title,
    description: options.descriptionMarkdown,
    priority: options.priority ? PRIORITY_TO_NUM[options.priority] : undefined,
    projectId: options.projectId,
    dueDate: options.dueDate,
  };

  if (options.state) {
    const states = await gk.workflowStatesRaw(teamId);
    const target = states.find(s => s.name.toLowerCase() === options.state!.toLowerCase());
    if (!target) throw new Error(`No workflow state named "${options.state}" in this team.`);
    input.stateId = target.id;
  }
  if (options.assignee) {
    input.assigneeId = (await gk.resolveMemberRaw(options.assignee)).id;
  }
  if (options.labels && options.labels.length > 0) {
    const teamLabels = await gk.labelsRaw(teamId);
    const byName = new Map(teamLabels.map(l => [l.name.toLowerCase(), l]));
    input.labelIds = options.labels.map(name => {
      const found = byName.get(name.toLowerCase());
      if (!found) throw new Error(`No label named "${name}" in the team. Create it with createLabel() first.`);
      return found.id;
    });
  }
  if (options.parentId) {
    input.parentId = (await gk.issueRaw(options.parentId)).id;
  }

  const created = await gk.performAction(
    recorder,
    { title: `Create issue "${options.title}"`,
      description: `Create a new issue titled **${options.title}**${options.assignee ? `, assigned to ${options.assignee}` : ""}.`,
      actionKind: ISSUE_CREATE },
    api => api.createIssue(input),
  );

  return new LinearIssueImpl(gk, recorder.dup(), created.id, teamScope);
}
