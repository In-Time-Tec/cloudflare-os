import { ORB_TOKEN_ISSUER, getOrbSigningKey } from "./inference-grant.js";

export const ORB_SESSION_AUDIENCE = "gadgets:orb-harness";

export const ORB_SESSION_TTL_SECONDS = 15 * 60;

export type OrbSessionClaims = {
  threadId: string;
  userId: string;
  gen: number;
};

export class OrbSessionError extends Error {}

export async function mintOrbSession(
    key: Uint8Array, claims: OrbSessionClaims, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    threadId: claims.threadId,
    uid: claims.userId,
    gen: claims.gen,
    sub: claims.threadId,
    iss: ORB_TOKEN_ISSUER,
    aud: ORB_SESSION_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + ORB_SESSION_TTL_SECONDS,
  }));
  const signature = await signHs256(key, `${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

export async function verifyOrbSession(
    key: Uint8Array, token: string): Promise<OrbSessionClaims> {
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((s) => s === "")) {
    throw new OrbSessionError("Orb session token is not a compact JWT.");
  }

  const headerJson = decodePart(segments[0]);
  const payloadJson = decodePart(segments[1]);
  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(headerJson ?? "") as { alg?: string };
    payload = JSON.parse(payloadJson ?? "") as Record<string, unknown>;
  } catch {
    throw new OrbSessionError("Orb session token is not valid JSON.");
  }
  if (header.alg !== "HS256") {
    throw new OrbSessionError("Orb session token uses an unsupported algorithm.");
  }

  const valid = await verifyHs256(key, `${segments[0]}.${segments[1]}`, segments[2]);
  if (!valid) throw new OrbSessionError("Orb session token signature is invalid.");
  if (payload.iss !== ORB_TOKEN_ISSUER) {
    throw new OrbSessionError("Orb session token has the wrong issuer.");
  }
  if (payload.aud !== ORB_SESSION_AUDIENCE) {
    throw new OrbSessionError("Orb session token has the wrong audience.");
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000) || payload.exp < payload.iat) {
    throw new OrbSessionError("Orb session token has expired or carries invalid times.");
  }

  const threadId = typeof payload.sub === "string" ? payload.sub : payload.threadId;
  const userId = payload.uid;
  const gen = payload.gen;
  if (typeof threadId !== "string" || threadId === "" ||
      typeof userId !== "string" || userId === "" ||
      typeof gen !== "number" || !Number.isInteger(gen) || gen < 1) {
    throw new OrbSessionError("Orb session token is missing required claims.");
  }
  return { threadId, userId, gen };
}

export { getOrbSigningKey };

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodePart(part: string): string | undefined {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  try {
    return new TextDecoder().decode(
        Uint8Array.from(atob(normalized + pad), (ch) => ch.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

async function signHs256(key: Uint8Array, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifyHs256(key: Uint8Array, data: string, signaturePart: string): Promise<boolean> {
  let signature: Uint8Array;
  try {
    const normalized = signaturePart.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    signature = Uint8Array.from(atob(normalized + pad), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  const cryptoKey = await crypto.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", cryptoKey, signature, new TextEncoder().encode(data));
}
