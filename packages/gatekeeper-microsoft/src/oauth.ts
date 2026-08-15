// Minimal OIDC (authorization-code + PKCE) client for a single-tenant Microsoft Entra ID app.
//
// The tenant is fixed by configuration: authorize/token/JWKS URLs are all built from TENANT_ID, so
// `common`, `consumers`, and arbitrary-tenant sign-ins are structurally impossible. Identity comes
// exclusively from the validated ID token (see validateIdToken) — never from userinfo or Graph.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface EntraOAuthConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
}

/**
 * Build the OAuth config from the gatekeeper's env. Returns null when any credential is missing so
 * the OAuth endpoint can render a "not configured" page instead of throwing.
 */
export function getOAuthConfig(
  clientId: string | undefined, clientSecret: string | undefined,
  tenantId: string | undefined, baseUrl: string,
): EntraOAuthConfig | null {
  if (!clientId || !clientSecret || !tenantId) return null;
  return { clientId, clientSecret, tenantId, redirectUri: `${baseUrl}/oauth` };
}

/** The single-tenant Entra v2.0 issuer — the `issuer` half of every identity this vendor asserts. */
export function entraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

function authorityBase(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}`;
}

/**
 * Sign-in requests only OIDC identity scopes. No Graph scopes: signing in must never mint a Graph
 * grant (connecting Microsoft capabilities is a separate, explicit consent flow).
 */
export const AUTH_SCOPES = ["openid", "profile", "email"];

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a PKCE verifier and its S256 challenge. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64urlEncode(digest) };
}

export function buildAuthorizeUrl(
  config: EntraOAuthConfig, state: string, challenge: string, oidcNonce: string,
): string {
  const url = new URL(`${authorityBase(config.tenantId)}/oauth2/v2.0/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", AUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", oidcNonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Exchange an authorization code (with its PKCE verifier) for the ID token. */
export async function exchangeCode(
  config: EntraOAuthConfig, code: string, verifier: string,
): Promise<string | null> {
  const resp = await fetch(`${authorityBase(config.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) {
    resp.body?.cancel();
    return null;
  }
  const data = await resp.json() as { id_token?: string };
  return data.id_token ?? null;
}

// One remote JWK set per tenant, cached across requests (jose refreshes it on unknown kid).
const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The provider-verified identity extracted from a fully validated Entra ID token. */
export interface ValidatedEntraIdentity {
  /** The verified tenant issuer (entraIssuer(tenantId)). */
  issuer: string;
  /** The immutable directory object id (`oid`) — the identity subject. */
  oid: string;
  email?: string;
  displayName?: string;
  /** Server-validated Entra app-role claims, if any. */
  roles?: string[];
}

/**
 * Fully validate an Entra ID token and extract the structured identity, or throw. Checks (all
 * mandatory): signature against the tenant's JWKS, issuer, audience (this app), expiration (jose),
 * the OIDC nonce minted for this flow, the `tid` claim matching the configured tenant, and a
 * present `oid`. Email and name are copied as mutable profile metadata only.
 */
export async function validateIdToken(
  config: EntraOAuthConfig, idToken: string, expectedNonce: string,
): Promise<ValidatedEntraIdentity> {
  const issuer = entraIssuer(config.tenantId);
  let jwks = remoteJwkSets.get(config.tenantId);
  if (!jwks) {
    jwks = createRemoteJWKSet(
        new URL(`${authorityBase(config.tenantId)}/discovery/v2.0/keys`));
    remoteJwkSets.set(config.tenantId, jwks);
  }
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience: config.clientId,
  });
  return extractIdentity(payload, config.tenantId, issuer, expectedNonce);
}

/**
 * Claim checks beyond what jwtVerify enforces, separated for direct testing. Rejects a missing or
 * mismatched nonce, a wrong-tenant `tid`, and a missing `oid`.
 */
export function extractIdentity(
  payload: JWTPayload, tenantId: string, issuer: string, expectedNonce: string,
): ValidatedEntraIdentity {
  if (typeof payload.nonce !== "string" || payload.nonce !== expectedNonce) {
    throw new Error("ID token nonce mismatch.");
  }
  if (payload.tid !== tenantId) {
    throw new Error("ID token was issued for a different tenant.");
  }
  if (typeof payload.oid !== "string" || !payload.oid) {
    throw new Error("ID token carries no object id (oid).");
  }
  const email = typeof payload.email === "string" && payload.email ? payload.email
      : typeof payload.preferred_username === "string" && payload.preferred_username.includes("@")
        ? payload.preferred_username : undefined;
  const roles = Array.isArray(payload.roles)
      ? payload.roles.filter((r): r is string => typeof r === "string")
      : undefined;
  return {
    issuer,
    oid: payload.oid,
    email,
    displayName: typeof payload.name === "string" && payload.name ? payload.name : undefined,
    roles: roles && roles.length > 0 ? roles : undefined,
  };
}
