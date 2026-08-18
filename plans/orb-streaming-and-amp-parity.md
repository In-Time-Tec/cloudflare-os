# Orbs: streaming, background work, and Amp parity

> **Superseded in part by plans/pi-in-orb.md**: the "keep the loop in the Overseer DO" decision
> is reversed — the agent loop moves into the orb behind a credential broker. Phases 1–2 below
> (envd streaming, background processes, envdAccessToken) remain valid prerequisites; Phase 3's
> workspace features land after the executor migration.

Research inputs: web survey of Amp orbs (ampcode.com manual/news/security), industry agent-sandbox
architectures (Codex cloud, Claude Code web, Copilot coding agent, Devin, Cursor, E2B/Modal/LangChain
guidance), and the envd wire protocol read from source (e2b-dev/infra packages/envd). Key findings are
inlined where they justify a decision; protocol facts the implementer needs are in the appendix.

## The architecture question, answered

Two patterns exist in the industry (LangChain's names):

- **Pattern 1, agent IN sandbox**: the harness/tool loop runs inside the isolated compute.
  Shipped by: OpenAI Codex cloud, Claude Code on the web, GitHub Copilot coding agent — and **Amp:
  orb threads run the actual agent inside the orb** (`executor: 'local' | 'orb'`; amp CLI
  preinstalled and authenticated in every orb; "we tell the agent it's running inside an orb").
  Amp's server keeps auth/threads/inference authorization outside, handing the orb
  request-scoped LLM credentials.
- **Pattern 2, sandbox as TOOL**: the loop runs elsewhere; the sandbox executes commands.
  Shipped by: Devin ("Devin's agent loop runs in Devin's cloud, while all command execution,
  file edits, and repository access happen on machines you operate"), Cursor cloud agents
  ("Cursor's agent harness handles inference and planning, then sends tool calls to the worker"),
  Claude Managed Agents, and every framework (LangChain, Pydantic AI, Mastra).

Neither is "the" typical approach — first-party cloud coding agents lean Pattern 1; platforms
whose harness is the product lean Pattern 2. Every Pattern-1 shipper had to build an external
credential broker (Anthropic's git proxy, Codex's network-blocked agent phase, Copilot's egress
firewall) because co-locating secrets with untrusted compute is the pattern's core weakness.

## Decision for this codebase: keep the loop in the Overseer DO (Pattern 2), close the UX gap

We do NOT move the agent into the orb, even though Amp did, because:

1. **The Overseer DO is the kernel.** Capability security — gatekeeper bindings, observation/action
   records, per-capability grants — is enforced at the DO boundary. Moving the loop into the orb
   moves LLM keys and gatekeeper capabilities inside the sandbox, exactly the co-location problem
   Pattern 1 shippers spent infrastructure escaping. Amp affords it by having the server authorize
   each inference call with request-scoped credentials; we'd have to build that broker first.
2. **The harness is workerd-native.** agent.ts's loop, executeCode, Yjs file state, and RPC all live
   in Workers. "Agent in orb" here means porting the harness to Node inside the sandbox — a fork of
   the product, not a feature.
3. **Pattern 2 does not cost the Amp UX.** Devin and Cursor prove the live-terminal, streaming,
   persistent-VM experience is achievable with the loop outside. Amp's *observable* orb behaviors —
   live output, background daemons, a real workspace, terminal, portals — are all data-plane
   features we can build over envd.

What users actually see in Amp, in priority order for parity:
live streaming output → background/long-running work that survives the turn → repo/workspace in
the orb → shared terminal → portals (preview URLs). That ordering is the phase plan.

## Phase 1 — stream executeShell output (the immediate fix)

Today executeShell buffers: envd.ts:66 does `await response.text()` on a server-streaming
ConnectRPC response, and agent.ts:2753 awaits the whole result; the user watches a spinner for up
to 120s. The UI already renders incremental tool output (`toolOutputDelta` →
ChatInterface.tsx:4810); only executeCode emits it (agent.ts:2720). Mirror that path:

- **envd.ts**: add `runCommandStreaming(sandboxId, token, command, timeoutMs, onDelta)`.
  Read `response.body` via ReadableStream reader; maintain a byte buffer; drain complete
  5-byte-envelope frames (see appendix); per frame: data.stdout/stderr → base64-decode → call
  `onDelta`; keepalive → ignore; end → capture exitCode (absent means 0 — protojson elides
  defaults); flags&0x02 → EndStreamResponse, check `.error`. Keep one `TextDecoder({stream:true})`
  per output stream across frames (UTF-8 sequences straddle DataEvents). Send
  `Keepalive-Ping-Interval: 30` (envd default 90s is uncomfortably close to Cloudflare's ~100s
  idle window). Existing `parseConnectStream` stays as the non-streaming fallback shape; the
  frame-scanning heuristic (balanced-JSON scan) is replaced by correct envelope framing.
- **overseer.ts executeShellInOrb**: accept an `onDelta` callback, pass through. Throttle
  storage-touching work: do NOT write DO storage from the stream-read path (a DO restart kills
  storage-touching in-flight requests immediately); touchOrbActivity() once at start and once at
  end, not per delta.
- **agent.ts executeShell**: pass `delta => emitStreamEvent({type: "toolOutputDelta", toolCallId,
  delta})`, exactly as executeCode does. Cap cumulative streamed bytes at the existing 40k with a
  trailing "[output truncated]" — keep emitting nothing after the cap but let the command finish.
- **Frontend**: no change. This is the point of reusing toolOutputDelta.
- **envd auth**: capture `envdAccessToken` from create/connect/resume responses in e2b-api.ts and
  send `X-Access-Token` (today we pass undefined; works on unsecured sandboxes, breaks on secured
  ones and after resume, which mints a fresh token).

Risk note (accepted): a streaming executeShell holds an outbound fetch open from the DO. Outbound
`fetch()` does NOT keep a DO alive; the agent keep-alive alarm (already armed during turns) is
what protects us. 120s command cap fits inside the alarm cadence.

## Phase 2 — background processes that survive the turn (Amp's "nohup, but real")

Amp agents run long work in a shared tmux; our tool description tells agents to `nohup ... &` and
hope. Make it first-class:

- New tool `startBackgroundProcess(command)`: Process/Start with `Connect-Timeout-Ms` omitted
  (omitted = envd never kills the process; the SDK's 60s default is why naive Start dies),
  command wrapped to also `>> ~/.thread/logs/<id>.log 2>&1` (envd discards output with zero
  subscribers — the file is the durable record, the stream is telemetry). On the first frame
  (always the `start` event, ordering guaranteed) persist {pid, logPath, command, startedAt} to
  DO storage, then detach.
- New tool `checkBackgroundProcess(pid)`: Process/Connect by pid for live tail; on
  `not_found` (exit >30s ago — terminated-retention TTL) fall back to reading the log file via
  envd files API. `stopBackgroundProcess(pid)` → SendSignal SIGKILL.
- **Pause/resume interplay**: sleepOrb uses default memory snapshots, so background processes
  survive pause and PIDs stay valid after resume (memory snapshot preserves the process table).
  Two rules: never pause with `keepMemory:false` (cold boot kills processes); re-fetch
  envdAccessToken after every resume. Streams sever at pause — reconnect by stored pid.
- **DO liveness**: while a live-tail stream is open outside an agent turn, arm the alarm at ≤60s
  cadence (eviction window is 70–140s of no *incoming* events; outbound streams don't count).

## Phase 3 — the orb as the thread's workspace (parity decision point)

Amp's deepest difference: the repo lives IN the orb (`/home/user/workspace/repo`), the agent's
file tools edit the orb filesystem, and the Changes pane diffs orb state. Our thread files are
Yjs docs in the DO, and executeCode/file tools never touch the orb. Closing this fully is a
product re-architecture, not a feature. Ship the cheap 80% first:

- **3a (cheap, high value)**: seed thread files into the orb on wake (envd multipart /files write,
  writeFile already exists), under `~/thread/`; default executeShell cwd there. One-way: DO → orb
  on wake, plus an explicit `pullFileFromMachine(path)` tool for the reverse. No continuous sync.
- **3b (Amp-style setup)**: per-deployment setup script + snapshot reuse (Amp runs .agents/setup,
  snapshots, reuses 24h). E2B pause IS a snapshot: run setup once, pause, and let subsequent
  threads resume-from-template. Needs an admin setting for the setup script; defer until 3a proves
  demand.
- **3c (terminal pane)**: envd PTY (Start with `pty:{size}`, SendInput pty bytes, Update resize,
  0x04 for EOF) proxied backend→frontend over the existing WebSocket RPC. Amp's differentiator —
  the user and agent share one tmux session — is worth copying only after 3a.
- **3d (portals)**: authenticated preview URLs to sandbox ports through the router
  (`https://{port}-{sandboxId}.e2b.app` upstream). Needs auth design (thread-scoped signed URLs);
  explicitly out of scope until asked for.

## Non-goals

- Moving the agent loop into the orb (revisit only if we later want BYO-harness threads à la
  Amp's runner targets; that requires the credential-broker work first).
- Multiplayer orbs, webhooks, OIDC workload identity (Amp features with no current product pull).

## Appendix: envd wire facts (from e2b-dev/infra source)

- Endpoint: `POST https://49983-{sandboxId}.e2b.app/process.Process/Start` (also /Connect,
  /SendInput, /SendSignal, /Update, /List). Streaming calls: `content-type:
  application/connect+json`, `connect-protocol-version: 1`. Unary calls: plain
  `application/json`, bare body.
- **Request body is enveloped too**: `[flags:1][len:4 BE][json]` — send `[0x00][len]{...}`.
  Response frames same envelope; `flags & 0x02` marks the EndStreamResponse frame
  (`{}` on success, `{"error":{code,message}}` on failure). HTTP status is 200 even for errors.
- Event JSON (protojson, defaults elided): `{"event":{"start":{"pid":N}}}` first, then
  `{"event":{"data":{"stdout"|"stderr"|"pty":"<base64>"}}}` interleaved with
  `{"event":{"keepalive":{}}}`, then `{"event":{"end":{"exitCode":N,"exited":true,...}}}`
  (exitCode absent = 0), then EOS frame.
- `Connect-Timeout-Ms` header = process kill timeout, detached from the request: dropping the
  HTTP stream does NOT kill the process; omitting the header = no timeout.
- `Keepalive-Ping-Interval` (seconds) — real DATA frames; set 30 to stay inside Cloudflare's
  ~100s idle proxy window. E2B-side idle limits (envd 640s > client-proxy 610s > GCP LB 600s)
  are never the binding constraint; Cloudflare is.
- Reconnect: `/process.Process/Connect` body `{"process":{"pid":N}}`; replays future output
  only (no backfill); after exit, a 30s terminated-retention cache still serves the exit code;
  beyond that, `not_found`.
- Cloudflare: HTTP-triggered Workers have no wall-clock limit while the client stays connected;
  `waitUntil` is 30s (never use it for streams); DO alarms/crons cap at 15min; outbound fetch
  streams do not prevent DO eviction (70–140s idle) — arm alarms.
- Pause/resume: default memory snapshot preserves running processes and PIDs; all network
  connections sever; resume mints a new envdAccessToken; `keepMemory:false` cold-boots and
  kills processes.
