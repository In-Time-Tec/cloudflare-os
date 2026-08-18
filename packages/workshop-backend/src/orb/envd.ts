// Data-plane access to a running orb: executing commands inside the sandbox via envd
// (the daemon on port 49983 of every E2B sandbox). ConnectRPC-over-HTTP with JSON codec —
// plain fetch, works in workerd. See plans/research-e2b-orbs.md §1.6.

import { Data, Effect, Schema } from "effect";

/** envd request failed at the network layer. */
export class EnvdNetworkError extends Data.TaggedError("EnvdNetworkError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** envd answered with a non-success status. */
export class EnvdApiError extends Data.TaggedError("EnvdApiError")<{
  readonly operation: string;
  readonly status: number;
  readonly body: string;
}> {}

export type EnvdError = EnvdNetworkError | EnvdApiError;

const envdOrigin = (sandboxId: string) => `https://49983-${sandboxId}.e2b.app`;

/** One line of command output, in order. */
export const CommandOutput = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number,
});
export type CommandOutput = typeof CommandOutput.Type;

/**
 * Run one command to completion inside the sandbox and collect its output. envd's
 * process.Start is a server-streamed ConnectRPC call; with the JSON codec the response body
 * is a sequence of JSON frames we fold into stdout/stderr/exit.
 *
 * Long-running work should not hold this call open (Workers CPU budgets, DO eviction):
 * callers cap output and pass a bounded timeout, and anything longer belongs in a
 * background process re-attached by pid (later phase).
 */
export const runCommand = (
  sandboxId: string,
  envdAccessToken: string | undefined,
  command: string,
  timeoutMs: number,
): Effect.Effect<CommandOutput, EnvdError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `${envdOrigin(sandboxId)}/process.Process/Start`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/connect+json",
            ...(envdAccessToken ? { "X-Access-Token": envdAccessToken } : {}),
          },
          body: JSON.stringify({
            process: {
              cmd: "/bin/bash",
              args: ["-l", "-c", command],
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      const text = await response.text();
      if (!response.ok) {
        return { error: { status: response.status, body: text.slice(0, 512) } };
      }
      return { ok: text };
    },
    catch: (cause) => new EnvdNetworkError({ operation: "runCommand", cause }),
  }).pipe(
    Effect.flatMap((outcome) =>
      "ok" in outcome && outcome.ok !== undefined
        ? Effect.succeed(parseConnectStream(outcome.ok))
        : Effect.fail(new EnvdApiError({
            operation: "runCommand",
            status: (outcome as { error: { status: number; body: string } }).error.status,
            body: (outcome as { error: { status: number; body: string } }).error.body,
          }))),
  );

/**
 * Fold a connect+json server-stream body into collected output. Each frame is a 5-byte
 * envelope (flags + length) followed by JSON; we parse defensively since this is an
 * external system's wire format.
 */
function parseConnectStream(body: string): CommandOutput {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  // Frames may also arrive newline-separated when proxies re-chunk; accept both by scanning
  // for JSON object boundaries.
  for (const match of body.matchAll(/\{[^\0]*?\}(?=\s*[\x00-\x1f{]|\s*$)/g)) {
    try {
      const frame = JSON.parse(match[0]) as {
        event?: {
          data?: { stdout?: string; stderr?: string };
          end?: { exitCode?: number };
        };
      };
      const data = frame.event?.data;
      if (data?.stdout) stdout += decodeMaybeBase64(data.stdout);
      if (data?.stderr) stderr += decodeMaybeBase64(data.stderr);
      const end = frame.event?.end;
      if (end?.exitCode !== undefined) exitCode = end.exitCode;
    } catch {
      // Not a frame boundary we understood; skip.
    }
  }
  return { stdout, stderr, exitCode };
}

/** envd encodes byte payloads as base64 in JSON frames; pass printable text through as-is. */
function decodeMaybeBase64(value: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0 || value === "") {
    return value;
  }
  try {
    return atob(value);
  } catch {
    return value;
  }
}

/** Write a file into the sandbox via envd's multipart /files endpoint. */
export const writeFile = (
  sandboxId: string,
  envdAccessToken: string | undefined,
  path: string,
  contents: string,
): Effect.Effect<void, EnvdError> =>
  Effect.tryPromise({
    try: async () => {
      const form = new FormData();
      form.append("file", new Blob([contents]), path.split("/").pop() ?? "file");
      const response = await fetch(
        `${envdOrigin(sandboxId)}/files?path=${encodeURIComponent(path)}&username=user`,
        {
          method: "POST",
          headers: envdAccessToken ? { "X-Access-Token": envdAccessToken } : {},
          body: form,
        },
      );
      if (!response.ok) {
        const text = await response.text();
        return { error: { status: response.status, body: text.slice(0, 512) } };
      }
      return { ok: true as const };
    },
    catch: (cause) => new EnvdNetworkError({ operation: "writeFile", cause }),
  }).pipe(
    Effect.flatMap((outcome) =>
      "ok" in outcome && outcome.ok !== undefined
        ? Effect.void
        : Effect.fail(new EnvdApiError({
            operation: "writeFile",
            status: (outcome as { error: { status: number; body: string } }).error.status,
            body: (outcome as { error: { status: number; body: string } }).error.body,
          }))),
  );
