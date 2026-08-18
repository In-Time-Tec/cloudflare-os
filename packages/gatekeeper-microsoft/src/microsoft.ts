// The Microsoft gatekeeper: sign-in with Microsoft Entra ID plus delegated Microsoft 365
// capabilities (Outlook Mail, Calendar, OneDrive/SharePoint files, Teams).
//
// Two account modes share one UserAccount Durable Object class:
//
//   - "signin": the Workshop's login flow (connectAccount with scopes:"auth"). Only OIDC identity
//     scopes are requested, only the validated identity is kept (briefly), and the DO
//     self-destructs — no Microsoft credential is ever stored.
//   - "full": a persistent connected account (the Connectors page / scopes:"full"). The DO stores
//     the refresh token and validated (tenant, oid) identity; capability sessions borrow
//     short-lived access tokens from it. The refresh token never leaves the DO.
//
// Every capability session lives behind the Workshop action-recording model (see sessions.ts):
// reads are authorized observations, writes are authorized actions performed inline.
// Graph requests happen in @gadgets/microsoft-graph; Effect stays inside the Worker.

import { WorkerEntrypoint, DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  AuthenticatedIdentity, ConversationMessage, ConversationRef, ConversationsApi,
  ConversationSummary, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper,
  GatekeeperUser as GatekeeperUserIface, GatekeeperUserVerifier, VendorDescription,
  GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription,
  SupportedResource, ResourceConfiguratorFrame, stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  getOAuthConfig, buildAuthorizeUrl, generatePkce, exchangeCode, refreshTokens, validateIdToken,
  ValidatedEntraIdentity, AUTH_SCOPES, CONNECT_BASE_SCOPES, TokenGrant,
} from "./oauth.js";
import {
  MAILBOX_RESOURCE, CALENDAR_RESOURCE, FILES_RESOURCE, TEAMS_RESOURCE, SUPPORTED_RESOURCES,
  scopesForResources, resourceForUrl,
} from "./resources.js";
import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";
import TYPES_CODE from "./types.txt";
import MAILBOX_CONFIGURATOR_HTML from "./generated/mailbox-configurator-ui.txt";
import CALENDAR_CONFIGURATOR_HTML from "./generated/calendar-configurator-ui.txt";
import FILES_CONFIGURATOR_HTML from "./generated/files-configurator-ui.txt";
import TEAMS_CONFIGURATOR_HTML from "./generated/teams-configurator-ui.txt";

export {
  MailboxGatekeeperImpl, CalendarGatekeeperImpl, FilesGatekeeperImpl, TeamsGatekeeperImpl,
} from "./sessions.js";
export { ChatMirror } from "./chat-mirror.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.microsoft", vendorId: VENDOR_ID,
});

// The OAuth-flow nonce stored in UserAccount KV. Only one is active at a time; `stage` tracks
// where we are. For the OAuth stage we also stash the PKCE verifier and the OIDC nonce that must
// come back inside the ID token.
type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
  verifier?: string;
  oidcNonce?: string;
};

/** A cached access token plus its absolute expiry (unix ms). */
type StoredAccessToken = { token: string; expires: number };

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
// How long the validated identity stays readable after a sign-in completes before self-destruct.
const IDENTITY_LIFETIME_MS = 2 * 60 * 1000;
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 60 * 1000;

// Official Microsoft four-square logomark, as a data URI for the vendor/account avatar.
const MICROSOFT_LOGO_URL = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 23 23">` +
  `<rect x="1" y="1" width="10" height="10" fill="#f25022"/>` +
  `<rect x="12" y="1" width="10" height="10" fill="#7fba00"/>` +
  `<rect x="1" y="12" width="10" height="10" fill="#00a4ef"/>` +
  `<rect x="12" y="12" width="10" height="10" fill="#ffb900"/>` +
  `</svg>`,
);

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

// Optional env vars (may be omitted from wrangler.jsonc; secrets come from .dev.vars / dashboard).
type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  TENANT_ID?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL || "http://localhost:8787/gatekeeper/microsoft");
}

function getBasePath(env: Env) {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function getConfig(env: Env) {
  return getOAuthConfig(env.CLIENT_ID, env.CLIENT_SECRET, env.TENANT_ID, getBaseUrl(env));
}

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en"><body>
<script type="text/javascript">window.close();</script>
<p>Authorization complete. You may close this tab and return to Cloudflare OS.
</body></html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
<h1 style="color:#d97706;">Authorization Link Expired</h1>
<p>This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
<button onclick="window.close()">Close</button></body></html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Configuration Required</title></head>
<body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
<h1 style="color:#d97706;">Microsoft Gatekeeper Not Configured</h1>
<p>Please see the README.md for instructions on configuring the Entra app registration.</p>
</body></html>`;

/** Main HTTP entrypoint — used only to initiate and complete OAuth flows. */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const config = getConfig(env);
      if (!config) {
        return new Response(NOT_CONFIGURED_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const doId = path[0];
      const initiationNonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      const authUrl = buildAuthorizeUrl(
          config, `${doId}:${begun.oauthNonce}`, begun.challenge, begun.oidcNonce, begun.scopes);
      return Response.redirect(authUrl, 302);
    } else if (relPath === "/notifications") {
      // Graph webhook. Validation handshake first: echo validationToken as text/plain.
      const validationToken = url.searchParams.get("validationToken");
      if (validationToken !== null) {
        return new Response(validationToken, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      let body: {
        value?: {
          subscriptionId?: string; clientState?: string; resource?: string;
          lifecycleEvent?: string; changeType?: string;
        }[];
      };
      try {
        body = await req.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      // Ack fast; process each notification against its mirror (clientState carries the DO id).
      ctx.waitUntil((async () => {
        for (const notification of body.value ?? []) {
          const clientState = notification.clientState ?? "";
          const dotIdx = clientState.indexOf(".");
          if (dotIdx <= 0) continue;
          const mirrorId = clientState.slice(0, dotIdx);
          let mirror;
          try {
            mirror = ctx.exports.ChatMirror.get(ctx.exports.ChatMirror.idFromString(mirrorId));
          } catch {
            continue;
          }
          if (!await mirror.verifyClientState(clientState)) continue;
          if (notification.lifecycleEvent) {
            if (notification.lifecycleEvent === "subscriptionRemoved"
                || notification.lifecycleEvent === "reauthorizationRequired") {
              await mirror.dropSubscription(notification.subscriptionId ?? "");
            }
            continue;
          }
          if (notification.resource) {
            await mirror.ingest(notification.resource);
          }
        }
      })());
      return new Response("Accepted", { status: 202 });
    } else if (relPath === "/ws") {
      // Live conversations socket: ?mirror=<id>&token=<one-time token from getLiveEndpoint()>.
      const mirrorId = url.searchParams.get("mirror");
      const token = url.searchParams.get("token");
      if (!mirrorId || !token) return new Response("Bad Request", { status: 400 });
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      let mirror;
      try {
        mirror = ctx.exports.ChatMirror.get(ctx.exports.ChatMirror.idFromString(mirrorId));
      } catch {
        return new Response("Not Found", { status: 404 });
      }
      // Forward the raw upgrade request: WebSocket responses only survive the fetch path.
      return mirror.fetch(req);
    } else if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(`${error}: ${url.searchParams.get("error_description")}`);
      }
      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      const colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      const doId = state.slice(0, colonIdx);
      const oauthNonce = state.slice(colonIdx + 1);
      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404 });
  },
};

// =======================================================================================

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Microsoft",
      url: "https://microsoft.com",
      logo: { url: MICROSOFT_LOGO_URL },
      color: "#f3f2f1",
      tagline: "Mail, calendar, files, and Teams",
      description:
          "Connect your organization's Microsoft 365 account to give gadgets access to Outlook " +
          "mail and calendar, OneDrive and SharePoint files, and Teams. Build agents that triage " +
          "email, schedule meetings, find documents, or post updates to a channel.",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    const authOnly = options?.scopes === "auth";
    const scopes = authOnly
        ? [...AUTH_SCOPES]
        : [...new Set([...CONNECT_BASE_SCOPES,
            ...scopesForResources(options?.resourceUrlPatterns)])];
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, authOnly ? "signin" : "full", scopes);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  // Dedupes concurrent refreshes within one isolate lifetime.
  #refreshing: Promise<string | null> | undefined;

  #config() {
    const config = getConfig(this.env);
    if (!config) throw new Error("The Microsoft Gatekeeper is not configured.");
    return config;
  }

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string,
                    mode: "signin" | "full", scopes: string[]) {
    // The alarm guarantees cleanup when a flow never completes; a completed full-mode flow
    // cancels it (see acceptAuthCode), a sign-in re-arms it for prompt self-destruct.
    this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("mode", mode);
    this.ctx.storage.kv.put("requestedScopes", scopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  /** Re-arm the flow to refresh credentials or expand scopes on an existing full account. */
  async prepareReconnect(initiationNonce: string, scopes?: string[]) {
    this.ctx.storage.kv.put("reconnecting", true);
    if (scopes) this.ctx.storage.kv.put("requestedScopes", scopes);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  /**
   * Verify+consume the initiation nonce; mint the OAuth state nonce, the PKCE pair, and the OIDC
   * nonce that must return inside the ID token. Returns null if invalid.
   */
  async beginOAuthFlow(initiationNonce: string)
      : Promise<{ oauthNonce: string; challenge: string; oidcNonce: string;
                  scopes: string[] } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }
    const oauthNonce = generateNonce();
    const oidcNonce = generateNonce();
    const { verifier, challenge } = await generatePkce();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
      verifier,
      oidcNonce,
    });
    return {
      oauthNonce, challenge, oidcNonce,
      scopes: this.ctx.storage.kv.get<string[]>("requestedScopes") ?? [...AUTH_SCOPES],
    };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || !stored.verifier || !stored.oidcNonce ||
        Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Took too long to complete the authorization. Please try again.");
    }

    const config = this.#config();
    const grant = await exchangeCode(config, code, stored.verifier);
    if (!grant || !grant.idToken) {
      throw new Error("Microsoft OAuth exchange failed or returned no ID token.");
    }

    // Full validation: signature, issuer, audience, expiry (jose) + nonce, tid, oid (extract).
    // The identity binds the account; the raw ID token is dropped here.
    let identity: ValidatedEntraIdentity;
    try {
      identity = await validateIdToken(config, grant.idToken, stored.oidcNonce);
    } catch (err) {
      logger.warn("Entra ID token validation failed", {
        event: "microsoft.idtoken.invalid", error: err,
      });
      return false;
    }
    this.ctx.storage.kv.put<ValidatedEntraIdentity>("identity", identity);

    const mode = this.ctx.storage.kv.get<"signin" | "full">("mode") ?? "signin";
    const reconnecting = this.ctx.storage.kv.get<boolean>("reconnecting");

    if (mode === "full") {
      if (!grant.refreshToken) {
        throw new Error("Microsoft OAuth exchange returned no refresh token.");
      }
      this.#storeGrant(grant);
      this.ctx.storage.deleteAlarm();
      if (reconnecting) {
        this.ctx.storage.kv.delete("reconnecting");
        await callback.credentialsRestored();
        return true;
      }
      try {
        await callback.complete(this.ctx.exports.GatekeeperUserImpl(
            { props: { userObjectId: this.ctx.id.toString() } }));
      } catch (err) {
        this.ctx.storage.kv.delete("refreshToken");
        throw err;
      }
      return true;
    }

    // Sign-in: transient. The caller reads the identity via complete(); self-destruct after.
    try {
      await callback.complete(this.ctx.exports.GatekeeperUserImpl(
          { props: { userObjectId: this.ctx.id.toString() } }));
    } finally {
      this.ctx.storage.setAlarm(Date.now() + IDENTITY_LIFETIME_MS);
    }
    return true;
  }

  #storeGrant(grant: TokenGrant): void {
    if (grant.refreshToken) this.ctx.storage.kv.put("refreshToken", grant.refreshToken);
    this.ctx.storage.kv.put<StoredAccessToken>("accessToken", {
      token: grant.accessToken,
      expires: Date.now() + grant.expiresIn * 1000,
    });
    if (grant.scopes.length > 0) this.ctx.storage.kv.put("grantedScopes", grant.scopes);
  }

  /** The validated identity (sign-in reads it briefly; full accounts keep it). */
  getIdentity(): ValidatedEntraIdentity | undefined {
    return this.ctx.storage.kv.get<ValidatedEntraIdentity>("identity");
  }

  /** The delegated scopes the token endpoint reported for this grant. */
  getGrantedScopes(): string[] {
    return this.ctx.storage.kv.get<string[]>("grantedScopes") ?? [];
  }

  /**
   * A usable delegated access token (refreshing if needed), or null when the credentials are gone
   * or can no longer be refreshed — in which case the Workshop is notified via
   * credentialsExpired() and the account needs a reconnect.
   */
  async getAccessToken(): Promise<string | null> {
    const cached = this.ctx.storage.kv.get<StoredAccessToken>("accessToken");
    if (cached && cached.expires > Date.now() + ACCESS_TOKEN_EXPIRY_SAFETY_MS) {
      return cached.token;
    }
    if (!this.#refreshing) {
      this.#refreshing = this.#refresh().finally(() => { this.#refreshing = undefined; });
    }
    return this.#refreshing;
  }

  async #refresh(): Promise<string | null> {
    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) return null;

    const grant = await refreshTokens(this.#config(), refreshToken);
    if (!grant) {
      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      callback?.credentialsExpired().catch(err =>
        logger.warn("failed to notify credential expiry", {
          event: "credentials.expiry.notify.failed", error: err,
        }));
      return null;
    }
    this.#storeGrant(grant);
    return grant.accessToken;
  }

  async alarm(): Promise<void> {
    // Fires only for sign-in accounts and abandoned flows; completed full accounts cancel it.
    this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = { userObjectId: string };

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
                                implements GatekeeperUserIface {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async describe(): Promise<AccountDescription> {
    const account = this.#account();
    const [identity, scopes] = await Promise.all([
      account.getIdentity(), account.getGrantedScopes(),
    ]);
    return {
      displayName: identity?.displayName,
      uniqueName: identity?.email,
      avatar: { url: MICROSOFT_LOGO_URL },
      grantedResourceUrlPatterns: SUPPORTED_RESOURCES
          .filter(resource => scopesForResources([resource.urlPattern])
              .every(scope => scopes.includes(scope)))
          .map(resource => resource.urlPattern),
    };
  }

  async getAuthenticatedIdentity(): Promise<AuthenticatedIdentity | null> {
    const identity = await this.#account().getIdentity();
    if (!identity) return null;
    return {
      issuer: identity.issuer,
      subject: identity.oid,
      email: identity.email,
      displayName: identity.displayName,
      roles: identity.roles,
    };
  }

  async ensureResources(resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    const granted = await this.#account().getGrantedScopes();
    const needed = scopesForResources(resourceUrlPatterns);
    if (needed.every(scope => granted.includes(scope))) return {};
    // Expand the grant: re-run the flow with the union of scopes (incremental consent).
    const scopes = [...new Set([...CONNECT_BASE_SCOPES, ...granted, ...needed])];
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce, scopes);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const resource = resourceForUrl(url);
    const props = { userObjectId: this.ctx.props.userObjectId };
    switch (resource) {
      case MAILBOX_RESOURCE:
        return { class: this.ctx.exports.MailboxGatekeeperImpl({ props }), resource };
      case CALENDAR_RESOURCE:
        return { class: this.ctx.exports.CalendarGatekeeperImpl({ props }), resource };
      case FILES_RESOURCE:
        return { class: this.ctx.exports.FilesGatekeeperImpl({ props }), resource };
      case TEAMS_RESOURCE:
        return { class: this.ctx.exports.TeamsGatekeeperImpl({ props }), resource };
      default:
        throw new Error(`Not a supported Microsoft resource URL: ${url}`);
    }
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    // Whole-capability resources: each configurator is a single fixed choice that resolves to the
    // capability's canonical resource URL.
    const html = {
      [MAILBOX_RESOURCE.urlPattern]: MAILBOX_CONFIGURATOR_HTML,
      [CALENDAR_RESOURCE.urlPattern]: CALENDAR_CONFIGURATOR_HTML,
      [FILES_RESOURCE.urlPattern]: FILES_CONFIGURATOR_HTML,
      [TEAMS_RESOURCE.urlPattern]: TEAMS_CONFIGURATOR_HTML,
    }[resourceUrlPattern];
    if (!html) {
      throw new Error(`Not a supported Microsoft resource type: ${resourceUrlPattern}`);
    }
    return { iframeHtml: html, ui: new RpcStub(new MicrosoftConfiguratorUI()) };
  }

  async revoke(): Promise<void> {
    try {
      const mirror = this.ctx.exports.ChatMirror.get(
          this.ctx.exports.ChatMirror.idFromName(this.ctx.props.userObjectId));
      await mirror.destroy();
    } catch {
      // best-effort; the mirror is rebuildable state
    }
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const initiationNonce = generateNonce();
    await this.#account().prepareReconnect(initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${this.ctx.props.userObjectId}/${initiationNonce}` };
  }

  /**
   * The human conversations capability. Available once the account has a Teams grant; the mirror
   * DO is named by this account's UserAccount id so reconnects find the same mirror.
   */
  @skipRpcValidation()
  async getConversationsApi(): Promise<RpcStub<ConversationsApi> | null> {
    const account = this.#account();
    const [identity, scopes] = await Promise.all([
      account.getIdentity(), account.getGrantedScopes(),
    ]);
    if (!identity || !scopes.includes("Chat.ReadWrite")) return null;
    const mirrorDoId = this.ctx.exports.ChatMirror.idFromName(this.ctx.props.userObjectId);
    const mirror = this.ctx.exports.ChatMirror.get(mirrorDoId);
    await mirror.configure(this.ctx.props.userObjectId, identity.oid);
    // @ts-expect-error Cap'n Web RPC stubs and native RPC targets are compatible but the type
    //     system doesn't know this.
    return new ConversationsApiImpl(mirror, mirrorDoId.toString(), getBaseUrl(this.env),
        (this.env as Env).VAPID_PUBLIC_KEY);
  }

  /**
   * Mint a verifier representing this account. All four Microsoft capabilities expose broad
   * personal data, so their gatekeepers use the private-only observer policy (addObserver always
   * throws) and the verifier is never consulted — but getVerifier is part of the contract.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.MicrosoftVerifier({});
  }
}

/** The configurator UIs need no gatekeeper RPCs; this empty capability satisfies the frame contract. */
class MicrosoftConfiguratorUI extends RpcTarget {}

/**
 * The human conversations capability for one connected account: a thin RpcTarget over the
 * account's ChatMirror DO. All operations act as the signed-in user; nothing here is recorded
 * as an agent action.
 */
class ConversationsApiImpl extends RpcTarget implements ConversationsApi {
  constructor(private mirror: DurableObjectStub<import("./chat-mirror.js").ChatMirror>,
              private mirrorId: string,
              private baseUrl: string,
              private pushPublicKey: string | undefined) {
    super();
  }

  listConversations(): Promise<ConversationSummary[]> {
    return this.mirror.listConversations();
  }

  listChannels(): Promise<ConversationSummary[]> {
    return this.mirror.listChannels();
  }

  getMessages(ref: ConversationRef, options?: { before?: string })
      : Promise<{ messages: ConversationMessage[]; hasMore: boolean }> {
    return this.mirror.getMessages(ref, options);
  }

  sendMessage(ref: ConversationRef, text: string): Promise<{ id: string }> {
    return this.mirror.sendMessage(ref, text);
  }

  replyToMessage(ref: ConversationRef & { kind: "channel" }, messageId: string, text: string)
      : Promise<{ id: string }> {
    return this.mirror.replyToMessage(ref, messageId, text);
  }

  getAvatar(userId: string): Promise<Uint8Array | null> {
    return this.mirror.getAvatar(userId);
  }

  async getLiveEndpoint(): Promise<{ webSocketUrl: string; pushPublicKey?: string }> {
    const token = await this.mirror.mintSocketToken();
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    return {
      webSocketUrl: `${wsBase}/ws?mirror=${this.mirrorId}&token=${token}`,
      pushPublicKey: this.pushPublicKey,
    };
  }

  registerPush(subscription: { endpoint: string; keys: { p256dh: string; auth: string } })
      : Promise<void> {
    return this.mirror.registerPush(subscription);
  }

  unregisterPush(endpoint: string): Promise<void> {
    return this.mirror.unregisterPush(endpoint);
  }

  listEmails() {
    return this.mirror.listEmails();
  }

  getEmail(id: string) {
    return this.mirror.getEmail(id);
  }

  listAgenda(from: Date, to: Date) {
    return this.mirror.listAgenda(from, to);
  }
}

// Personal Microsoft data is never shared with observers, so no verification is ever performed.
@validateRpc()
export class MicrosoftVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}
