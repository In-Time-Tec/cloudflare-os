// Runtime-supported (workerd) Uint8Array base64/hex helpers that TypeScript's lib doesn't
// declare yet. Mirrors packages/workshop-backend/src/uint8array.es2024.d.ts.

interface Uint8Array {
  toHex(): string;
  toBase64(options?: { alphabet?: 'base64' | 'base64url' }): string;
}

interface Uint8ArrayConstructor {
  fromHex(hex: string): Uint8Array;
  fromBase64(base64: string, options?: { alphabet?: 'base64' | 'base64url'; lastChunkHandling?: 'loose' | 'strict' | 'stop-before-partial' }): Uint8Array;
}
