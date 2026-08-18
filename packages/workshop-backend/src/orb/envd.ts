// Data-plane access to a running orb: executing commands inside the sandbox via envd
// (the daemon on port 49983 of every E2B sandbox). ConnectRPC-over-HTTP with JSON codec —
// plain fetch, works in workerd. See plans/research-e2b-orbs.md §1.6.

import { Data, Effect, Result, Schema } from "effect";

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

const EnvdEvent = Schema.Struct({
  data: Schema.optional(Schema.Struct({
    stdout: Schema.optional(Schema.String),
    stderr: Schema.optional(Schema.String),
  })),
  end: Schema.optional(Schema.Struct({
    exitCode: Schema.optional(Schema.Number),
  })),
});

const EnvdFrame = Schema.Struct({
  event: Schema.optional(EnvdEvent),
  result: Schema.optional(Schema.Struct({
    event: Schema.optional(EnvdEvent),
  })),
});

function decodeEnvdFrame(value: unknown): typeof EnvdEvent.Type | undefined {
  const decoded = Schema.decodeUnknownResult(EnvdFrame)(value);
  if (!Result.isSuccess(decoded)) return undefined;
  return decoded.success.event ?? decoded.success.result?.event;
}
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

export const runCommandPromise = (
  sandboxId: string,
  envdAccessToken: string | undefined,
  command: string,
  timeoutMs: number,
): Promise<CommandOutput> =>
  Effect.runPromise(runCommand(sandboxId, envdAccessToken, command, timeoutMs));

/**
 * Fold a connect+json server-stream body into collected output. Each frame is a 5-byte
 * envelope (flags + length) followed by JSON; we parse defensively since this is an
 * external system's wire format.
 */
export function parseConnectStream(body: string): CommandOutput {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const candidate of extractJsonObjects(body)) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const event = decodeEnvdFrame(json);
    if (!event) continue;
    const data = event.data;
    if (data?.stdout) stdout += decodeMaybeBase64(data.stdout);
    if (data?.stderr) stderr += decodeMaybeBase64(data.stderr);
    if (event.end?.exitCode !== undefined) exitCode = event.end.exitCode;
  }
  return { stdout, stderr, exitCode };
}

/** Yield each balanced top-level {...} object found in a re-chunked stream body. */
function extractJsonObjects(body: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0 && --depth === 0 && start >= 0) {
        objects.push(body.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
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

export const startDetached = (
  sandboxId: string,
  envdAccessToken: string | undefined,
  command: string,
): Effect.Effect<number, EnvdError> =>
  runCommand(
      sandboxId,
      envdAccessToken,
      `nohup ${command} >/tmp/orb-harness.log 2>&1 & echo $!`,
      15_000).pipe(
    Effect.flatMap((output) => {
      const pid = Number.parseInt(output.stdout.trim().split(/\s+/).pop() ?? "", 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        return Effect.fail(new EnvdApiError({
          operation: "startDetached",
          status: 500,
          body: output.stderr || output.stdout.slice(0, 256) || "could not parse pid",
        }));
      }
      return Effect.succeed(pid);
    }),
  );

export const isProcessAlive = (
  sandboxId: string,
  envdAccessToken: string | undefined,
  pid: number,
): Effect.Effect<boolean, EnvdError> =>
  runCommand(sandboxId, envdAccessToken, `kill -0 ${pid} && echo alive || echo dead`, 10_000).pipe(
    Effect.map((output) => output.stdout.includes("alive")),
  );

export const signalProcess = (
  sandboxId: string,
  envdAccessToken: string | undefined,
  pid: number,
  signal: "TERM" | "KILL",
): Effect.Effect<void, EnvdError> =>
  runCommand(sandboxId, envdAccessToken, `kill -${signal} ${pid} || true`, 10_000).pipe(
    Effect.asVoid,
  );
