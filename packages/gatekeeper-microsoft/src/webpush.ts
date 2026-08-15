// Minimal Web Push sender: RFC 8291 (aes128gcm message encryption) + RFC 8292 (VAPID), written
// against Web Crypto only so it runs on Workers with no dependencies. Payloads are small JSON
// notification hints; the service worker fetches nothing else.

export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function b64urlDecode(input: string): Uint8Array {
  return Uint8Array.fromBase64(input, { alphabet: "base64url", lastChunkHandling: "loose" });
}

function b64urlEncode(bytes: Uint8Array): string {
  return bytes.toBase64({ alphabet: "base64url" }).replaceAll("=", "");
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number)
    : Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false,
      ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
      key, length * 8);
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const TEXT = new TextEncoder();

/** Encrypt `payload` for one subscription per RFC 8291 (aes128gcm). */
async function encryptPayload(subscription: PushSubscriptionInfo, payload: string)
    : Promise<Uint8Array> {
  const clientPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);

  const localKeys = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const localPublic = new Uint8Array(
      await crypto.subtle.exportKey("raw", localKeys.publicKey) as ArrayBuffer);
  const clientKey = await crypto.subtle.importKey("raw", clientPublic as BufferSource,
      { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Workers' generated types spell the standard `public` member `$public` (jsg reserved-word
  // escape); the runtime reads `public`. Set both so the object satisfies each layer.
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey, $public: clientKey } as never,
      localKeys.privateKey, 256));

  // RFC 8291 key derivation.
  const prkInfo = concat(TEXT.encode("WebPush: info\0"), clientPublic, localPublic);
  const ikm = await hkdf(authSecret, sharedSecret, prkInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, ikm, TEXT.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, TEXT.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", contentKey as BufferSource,
      "AES-GCM", false, ["encrypt"]);
  // Single record: payload + 0x02 terminal delimiter.
  const plaintext = concat(TEXT.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource }, aesKey, plaintext as BufferSource));

  // aes128gcm header: salt(16) | recordSize(4) | keyIdLen(1) | keyId(localPublic 65).
  const header = new Uint8Array(16 + 4 + 1 + localPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = localPublic.length;
  header.set(localPublic, 21);
  return concat(header, ciphertext);
}

/** Build the VAPID Authorization header for one push-service origin. */
async function vapidAuth(endpoint: string, publicKeyB64url: string, privateKeyB64url: string,
                         subject: string): Promise<string> {
  const origin = new URL(endpoint).origin;
  const header = b64urlEncode(TEXT.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64urlEncode(TEXT.encode(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const publicBytes = b64urlDecode(publicKeyB64url);   // 65-byte uncompressed point
  const privateBytes = b64urlDecode(privateKeyB64url); // 32-byte d
  const jwk = {
    kty: "EC", crv: "P-256",
    x: b64urlEncode(publicBytes.slice(1, 33)),
    y: b64urlEncode(publicBytes.slice(33, 65)),
    d: b64urlEncode(privateBytes),
  };
  const key = await crypto.subtle.importKey("jwk", jwk,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, key,
      TEXT.encode(`${header}.${body}`) as BufferSource));
  return `vapid t=${header}.${body}.${b64urlEncode(signature)}, k=${publicKeyB64url}`;
}

/**
 * Send one encrypted push. Returns "ok", "gone" (subscription dead — delete it), or "failed".
 */
export async function sendWebPush(subscription: PushSubscriptionInfo, payload: string,
                                  vapidPublicKey: string, vapidPrivateKey: string,
                                  subject: string): Promise<"ok" | "gone" | "failed"> {
  const body = await encryptPayload(subscription, payload);
  const auth = await vapidAuth(subscription.endpoint, vapidPublicKey, vapidPrivateKey, subject);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "high",
    },
    body: body as BodyInit,
  });
  response.body?.cancel();
  if (response.status === 404 || response.status === 410) return "gone";
  return response.ok ? "ok" : "failed";
}
