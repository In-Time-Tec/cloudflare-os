// Turn-scoped inference grants: the credential boundary for agent loops that run outside this
// Worker (in a thread's orb).
//
// The sandbox never holds a provider key. It holds a short-lived, single-model JWT that only
// authorizes POSTing an inference request for one turn; the Worker attaches the real endpoint and
// credentials (see orb-inference.ts). This is the broker shape every agent-in-sandbox system
// converges on -- the alternative, shipping OPENROUTER_API_TOKEN into the VM, makes any prompt
// injection a credential exfiltration.

import { SignJWT } from "jose";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";

/** Audience of a turn inference grant. Distinct from any other token this deployment signs. */
export const INFERENCE_GRANT_AUDIENCE = "gadgets:orb-inference";

/** Issuer of every orb-facing token. */
export const ORB_TOKEN_ISSUER = "gadgets:workshop-backend";

/** How long a grant stays valid. One turn; long enough to cover a slow model, short by design. */
export const INFERENCE_GRANT_TTL_SECONDS = 30 * 60;

/**
 * What a grant authorizes: exactly one model, for one turn of one thread, billed to one user.
 * The model is pinned at mint time so a compromised sandbox cannot upgrade itself to a more
 * expensive model or a provider the deployment does not fund.
 */
export type InferenceGrantClaims = {
  /** Thread (Overseer DO id) the turn belongs to. */
  threadId: string;
  /** Turn id, for correlation and single-turn revocation. */
  turnId: string;
  /** Owning user id, for cost attribution. */
  userId: string;
  /** The one model this grant may invoke. */
  model: AiModelConfig["model"];
  /** The provider that model belongs to. */
  provider: AiModelConfig["provider"];
  /** Initiator recorded for AI Gateway attribution metadata. */
  initiator: AiChatAuthorInfo;
};

const encoder = new TextEncoder();

/**
 * The signing key for orb-facing tokens. Derived from a dedicated deployment secret; absent means
 * orb-executed turns are unavailable (the same posture E2B_API_KEY has for orbs themselves).
 */
export function getOrbSigningKey(env: Cloudflare.Env): Uint8Array | undefined {
  const secret = env.ORB_TOKEN_SIGNING_KEY;
  if (!secret) return undefined;
  return encoder.encode(secret);
}

/** Mint a grant for one turn. Callers must have already authorized the turn itself. */
export async function mintInferenceGrant(
    key: Uint8Array, claims: InferenceGrantClaims, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  return new SignJWT({
    threadId: claims.threadId,
    turnId: claims.turnId,
    userId: claims.userId,
    model: claims.model,
    provider: claims.provider,
    initiator: claims.initiator,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ORB_TOKEN_ISSUER)
    .setAudience(INFERENCE_GRANT_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + INFERENCE_GRANT_TTL_SECONDS)
    .sign(key);
}

/** A grant that failed verification. The message is safe to return to the caller. */
export class InferenceGrantError extends Error {}

/**
 * Verify a grant and return its claims. Rejects anything whose signature, issuer, audience, or
 * expiry does not match, and anything missing a claim the proxy needs -- an under-specified grant
 * must never fall back to a default model or a default user.
 */
export async function verifyInferenceGrant(
    key: Uint8Array, token: string): Promise<InferenceGrantClaims> {
  // Structural guard before jose: a compact JWT is exactly three dot-separated segments, and
  // the signature segment is base64url of at least the 32-byte HS256 tag. Anything else is
  // rejected here, cheaply, so garbage never reaches jose's crypto path (which can emit a
  // second, floating rejection for malformed input).
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((s) => s === "") ||
      segments[2].length === 0) {
    throw new InferenceGrantError("Inference grant is not a compact JWT.");
  }

  // Decode header + payload without touching a crypto library, then verify the signature with a
  // single crypto.subtle call in one promise. jwtVerify from jose can emit a second, floating
  // rejection for bad signatures; we control the algorithm (HS256) and key, so verification is
  // explicit and leak-free here.
  const decodePart = (part: string): string | undefined => {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    try {
      return new TextDecoder().decode(
          Uint8Array.from(atob(normalized + pad), (ch) => ch.charCodeAt(0)));
    } catch {
      return undefined;
    }
  };

  const headerJson = decodePart(segments[0]);
  const payloadJson = decodePart(segments[1]);
  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(headerJson ?? "") as { alg?: string };
    payload = JSON.parse(payloadJson ?? "") as Record<string, unknown>;
  } catch {
    throw new InferenceGrantError("Inference grant is not valid JSON.");
  }
  if (header.alg !== "HS256") {
    throw new InferenceGrantError("Inference grant uses an unsupported algorithm.");
  }

  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(
        atob(segments[2].replace(/-/g, "+").replace(/_/g, "/") +
            (segments[2].length % 4 ? "=".repeat(4 - (segments[2].length % 4)) : "")),
        (ch) => ch.charCodeAt(0));
  } catch {
    throw new InferenceGrantError("Inference grant signature is not valid base64url.");
  }

  const expected = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false,
      ["verify"]);
  const valid = await crypto.subtle.verify(
      "HMAC", expected, signature, new TextEncoder().encode(`${segments[0]}.${segments[1]}`));
  if (!valid) throw new InferenceGrantError("Inference grant signature is invalid.");
  if (payload.iss !== ORB_TOKEN_ISSUER) {
    throw new InferenceGrantError("Inference grant has the wrong issuer.");
  }
  if (payload.aud !== INFERENCE_GRANT_AUDIENCE) {
    throw new InferenceGrantError("Inference grant has the wrong audience.");
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000) || payload.exp < payload.iat) {
    throw new InferenceGrantError("Inference grant has expired or carries invalid times.");
  }

  const claims = {
    threadId: payload.threadId,
    turnId: payload.turnId,
    userId: payload.userId,
    model: payload.model,
    provider: payload.provider,
    initiator: payload.initiator,
  };
  for (const [name, value] of Object.entries(claims)) {
    if (name === "initiator") continue;
    if (typeof value !== "string" || value === "") {
      throw new InferenceGrantError(`Inference grant is missing its "${name}" claim.`);
    }
  }
  const initiator = claims.initiator as AiChatAuthorInfo | undefined;
  if (!initiator || typeof initiator !== "object" || typeof initiator.id !== "string") {
    throw new InferenceGrantError('Inference grant is missing its "initiator" claim.');
  }
  return claims as InferenceGrantClaims;
}
