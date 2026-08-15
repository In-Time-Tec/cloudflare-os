// The Microsoft gatekeeper: sign-in with Microsoft Entra ID.
//
// This vendor currently provides authentication only (`providesAuth`), through the Workshop's
// standard gatekeeper connect flow: connectAccount() returns the OAuth popup URL, the UserAccount
// DO runs the single-tenant Entra OIDC flow (auth code + PKCE + state + OIDC nonce), and
// getAuthenticatedIdentity() returns the validated (tenant issuer, oid) identity. Sign-in grants
// are transient: only the validated identity is kept, briefly, and the DO self-destructs — no
// Microsoft credential (ID token, access token, Graph token) is ever stored or exposed. Graph
// capabilities will be a separate, explicit consent flow with its own token storage.

import { WorkerEntrypoint, DurableObject } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  AuthenticatedIdentity, GatekeeperVendor as GatekeeperVendorIface, Gatekeeper,
  GatekeeperUser as GatekeeperUserIface, GatekeeperUserVerifier, VendorDescription,
  GatekeeperConnectCallback, GatekeeperConnectOptions, AccountDescription,
  SupportedResource, ResourceConfiguratorFrame, stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  getOAuthConfig, buildAuthorizeUrl, generatePkce, exchangeCode, validateIdToken,
  ValidatedEntraIdentity,
} from "./oauth.js";
import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";

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

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
// How long the validated identity stays readable after complete() before self-destruct.
const IDENTITY_LIFETIME_MS = 2 * 60 * 1000;

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

/** Main HTTP entrypoint — used only to initiate and complete the OAuth flow. */
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
          config, `${doId}:${begun.oauthNonce}`, begun.challenge, begun.oidcNonce);
      return Response.redirect(authUrl, 302);
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
      tagline: "Sign in with Microsoft",
      description:
          "Sign in with your organization's Microsoft Entra ID account. Access to Microsoft 365 " +
          "data is granted separately, when you explicitly connect Microsoft capabilities.",
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // Sign-in is the only flow, and its grant is always transient — `options.scopes` cannot widen
    // it. Graph capability scopes will be a separate consent flow with separate storage.
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);
    return { url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}` };
  }

  /** No gadget/agent resource types yet — the Microsoft gatekeeper currently provides auth only. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return "// The Microsoft gatekeeper provides authentication only; no session types yet.\n";
  }
}

export class UserAccount extends DurableObject<Env> {
  #config() {
    const config = getConfig(this.env);
    if (!config) throw new Error("The Microsoft Gatekeeper is not configured.");
    return config;
  }

  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, initiationNonce: string) {
    // Every sign-in account is transient; the alarm guarantees cleanup whether or not the flow
    // completes.
    this.ctx.storage.setAlarm(Date.now() + 3600 * 1000);
    this.ctx.storage.kv.put("callback", callback);
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
      : Promise<{ oauthNonce: string; challenge: string; oidcNonce: string } | null> {
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
    return { oauthNonce, challenge, oidcNonce };
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
    const idToken = await exchangeCode(config, code, stored.verifier);
    if (!idToken) {
      throw new Error("Microsoft OAuth exchange failed or returned no ID token.");
    }

    // Full validation: signature, issuer, audience, expiry (jose) + nonce, tid, oid (extract).
    // Only the validated identity is stored — the ID token itself is dropped here.
    let identity: ValidatedEntraIdentity;
    try {
      identity = await validateIdToken(config, idToken, stored.oidcNonce);
    } catch (err) {
      logger.warn("Entra ID token validation failed", {
        event: "microsoft.idtoken.invalid", error: err,
      });
      return false;
    }
    this.ctx.storage.kv.put<ValidatedEntraIdentity>("identity", identity);

    try {
      await callback.complete(this.ctx.exports.GatekeeperUserImpl(
          { props: { userObjectId: this.ctx.id.toString() } }));
    } finally {
      // Sign-in grants are transient: the caller read the identity via complete(); schedule a
      // prompt self-destruct either way.
      this.ctx.storage.setAlarm(Date.now() + IDENTITY_LIFETIME_MS);
    }
    return true;
  }

  /** The validated identity, readable briefly after the flow completes (see complete()). */
  getIdentity(): ValidatedEntraIdentity | undefined {
    return this.ctx.storage.kv.get<ValidatedEntraIdentity>("identity");
  }

  async alarm(): Promise<void> {
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
    const identity = await this.#account().getIdentity();
    return {
      displayName: identity?.displayName,
      uniqueName: identity?.email,
      avatar: { url: MICROSOFT_LOGO_URL },
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

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    throw new Error("The Microsoft gatekeeper does not provide any resources yet.");
  }

  async startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The Microsoft gatekeeper does not provide any resources yet.");
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    throw new Error(
        "Microsoft sign-in grants are transient; sign in again instead of reconnecting.");
  }

  /**
   * Mint a verifier representing this account. The Microsoft gatekeeper exposes no resource
   * bindings (getGatekeeperClassFor always throws), so this verifier is never consulted by the
   * observer flow — but getVerifier is part of the GatekeeperUser contract. Trivial verifier, no
   * identity.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.MicrosoftVerifier({});
  }
}

// The Microsoft gatekeeper provides no resources, so no observer verification is performed.
@validateRpc()
export class MicrosoftVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}
