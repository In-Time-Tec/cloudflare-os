// The single place the Workshop talks HTTP to the E2B control plane (api.e2b.app).
//
// Written in Effect style: every operation is an Effect with tagged failures, request/response
// shapes are validated with Schema at the boundary, and the API key is injected by the caller
// (the thread DO) — it never appears in results, sandboxes, or the frontend.
//
// The E2B JS SDK does not run in workerd (connect-web transport incompatibility), so this module
// speaks the raw REST API. Six endpoints cover the whole orb lifecycle; see
// plans/research-e2b-orbs.md §1.6.

import { Data, Effect, Formatter, Result, Schema } from "effect";

const E2B_API_ORIGIN = "https://api.e2b.app";

/** A control-plane request failed at the network layer (fetch rejected). */
export class E2bNetworkError extends Data.TaggedError("E2bNetworkError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** The control plane answered with a non-success status. */
export class E2bApiError extends Data.TaggedError("E2bApiError")<{
  readonly operation: string;
  readonly status: number;
  readonly body: string;
}> {}

/** A response decoded to something other than the documented shape. */
export class E2bDecodeError extends Data.TaggedError("E2bDecodeError")<{
  readonly operation: string;
  readonly detail: string;
}> {}

export type E2bError = E2bNetworkError | E2bApiError | E2bDecodeError;

/** Response of POST /sandboxes and POST /sandboxes/{id}/connect. */
export const SandboxInfo = Schema.Struct({
  sandboxID: Schema.String,
  templateID: Schema.optional(Schema.String),
  envdAccessToken: Schema.optional(Schema.String),
});
export type SandboxInfo = typeof SandboxInfo.Type;

/** Response of GET /sandboxes/{id}. */
export const SandboxDetail = Schema.Struct({
  sandboxID: Schema.String,
  state: Schema.optional(Schema.String),
});
export type SandboxDetail = typeof SandboxDetail.Type;

/** Parameters for creating a sandbox. All values are data; the client does the encoding. */
export type CreateSandboxParams = {
  templateId: string;
  /** TTL in seconds before the lifecycle policy triggers. */
  timeoutSeconds: number;
  /** Snapshot instead of kill when the TTL expires (our server-side backstop). */
  autoPause: boolean;
  /** Opaque control-plane tags (threadId, ...). Never enters the sandbox. */
  metadata?: Record<string, string>;
  /** Initial env vars. NOTE: these persist across pause/resume snapshots — never put
   * short-lived credentials here; write those through envd files instead. */
  envVars?: Record<string, string>;
};

const decode = <A>(schema: Schema.Codec<A, any>, operation: string) =>
  (value: unknown): Effect.Effect<A, E2bDecodeError> => {
    const result = Schema.decodeUnknownResult(schema)(value);
    if (Result.isSuccess(result)) return Effect.succeed(result.success);
    const detail = Formatter.format(result.failure.issue).slice(0, 300);
    return Effect.fail(new E2bDecodeError({ operation, detail }));
  };

/** One JSON request against the control plane. Success statuses are the caller's contract. */
const request = (
  apiKey: string,
  operation: string,
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<{ status: number; json: unknown }, E2bNetworkError | E2bApiError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${E2B_API_ORIGIN}${path}`, {
        method,
        headers: {
          "X-API-Key": apiKey,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        return { error: { status: response.status, body: text.slice(0, 512) } };
      }
      let json: unknown = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      return { ok: { status: response.status, json } };
    },
    catch: (cause) => new E2bNetworkError({ operation, cause }),
  }).pipe(
    Effect.flatMap((outcome) =>
      "ok" in outcome && outcome.ok !== undefined
        ? Effect.succeed(outcome.ok)
        : Effect.fail(new E2bApiError({
            operation,
            status: (outcome as { error: { status: number; body: string } }).error.status,
            body: (outcome as { error: { status: number; body: string } }).error.body,
          }))),
  );

/**
 * Create a fresh sandbox from a template. Returns the sandbox identity; the caller persists
 * `sandboxID` (and re-persists it after every connect — IDs may drift across resumes).
 */
export const createSandbox = (apiKey: string, params: CreateSandboxParams) =>
  request(apiKey, "createSandbox", "POST", "/sandboxes", {
    templateID: params.templateId,
    timeout: params.timeoutSeconds,
    autoPause: params.autoPause,
    ...(params.metadata ? { metadata: params.metadata } : {}),
    ...(params.envVars ? { envVars: params.envVars } : {}),
  }).pipe(Effect.flatMap(({ json }) => decode(SandboxInfo, "createSandbox")(json)));

/**
 * The resume-or-touch primitive: extends the TTL when running (HTTP 200), resumes the paused
 * snapshot when paused (HTTP 201). `resumed` tells the caller whether wake-up work (token
 * rotation, resume hooks) is due.
 */
export const connectSandbox = (apiKey: string, sandboxId: string, timeoutSeconds: number) =>
  request(apiKey, "connectSandbox", "POST",
      `/sandboxes/${encodeURIComponent(sandboxId)}/connect`, { timeout: timeoutSeconds }).pipe(
    Effect.flatMap(({ status, json }) =>
      decode(SandboxInfo, "connectSandbox")(json).pipe(
        Effect.map((info) => ({ ...info, resumed: status === 201 })))),
  );

/** Explicit pause (snapshot). 409 = already paused, which callers treat as success. */
export const pauseSandbox = (apiKey: string, sandboxId: string) =>
  request(apiKey, "pauseSandbox", "POST",
      `/sandboxes/${encodeURIComponent(sandboxId)}/pause`).pipe(
    Effect.asVoid,
    Effect.catchTag("E2bApiError", (error) =>
      error.status === 409 ? Effect.void : Effect.fail(error)),
  );

/** Kill the sandbox (also deletes a paused snapshot). 404 = already gone = success. */
export const killSandbox = (apiKey: string, sandboxId: string) =>
  request(apiKey, "killSandbox", "DELETE",
      `/sandboxes/${encodeURIComponent(sandboxId)}`).pipe(
    Effect.asVoid,
    Effect.catchTag("E2bApiError", (error) =>
      error.status === 404 ? Effect.void : Effect.fail(error)),
  );

/** Current control-plane view of one sandbox (state: running/paused/...). */
export const getSandbox = (apiKey: string, sandboxId: string) =>
  request(apiKey, "getSandbox", "GET",
      `/sandboxes/${encodeURIComponent(sandboxId)}`).pipe(
    Effect.flatMap(({ json }) => decode(SandboxDetail, "getSandbox")(json)));
