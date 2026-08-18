# Pi in the orb: the agent loop moves into the sandbox

Supersedes the "keep the loop in the Overseer DO" decision in
plans/orb-streaming-and-amp-parity.md. That plan's Phase 1–2 protocol work (envd streaming,
background processes, envdAccessToken handling) remains valid — it is prerequisite plumbing here.

Decision: thread turns execute inside the thread's E2B sandbox, in a Node/Bun harness running the
same pi loop (`@earendil-works/pi-agent-core`, which ships a Node entry) with the same tools.
The Overseer DO stays the kernel: it owns state, capabilities, tokens, and money. Nothing secret
enters the sandbox except a revocable thread-scoped session token. New plumbing is Effect v4
(the repo already pins `effect: 4.0.0-rc.109` in the catalog; orb modules are already
Effect-style).

## Why this shape survives the kernel-review bar

The load-bearing insight from reading the seams: **`AgentHooks` is already the boundary.**
The loop in agent.ts touches the DO exclusively through the ~25-method AgentHooks interface, and
the DO already speaks bidirectional capnweb to untrusted clients (AiChatSubscriber /
ActionsSubscriber are client-implemented RpcTargets in production today). Moving the loop means
moving the *caller* of AgentHooks, not redesigning the kernel. Streaming to the UI is free:
`hooks.emitChatStreamEvent` relayed over the wire lands in the exact `AiChatStreamEvent` union
the frontend already renders (textDelta, reasoningDelta, toolCodeDelta, toolOutputDelta,
codeUpdate...). The frontend does not change.

What does NOT move, ever:
- **executeCode** — Worker Loader with `globalOutbound: null` and workerd RPC stubs is the
  capability-security model. It stays DO-side and becomes a *remoted tool* from the harness's
  perspective (hooks.executeCodeMode over the wire, output deltas via capnweb callback — the
  signature already takes `onOutputText`).
- **Gatekeeper capabilities, grants, observation/action recording** — enforced at the DO.
- **Provider keys, cost accounting** — see credential proxy below.

## Target architecture

```
┌────────────────────────── E2B sandbox (per thread) ─────────────────────────┐
│  orb-harness (Bun, Effect v4)                                               │
│    pi runAgentLoopContinue + tools (from new packages/agent-core)           │
│    local tools:   executeShell (child_process, streams free), fs/git later  │
│    remoted tools: executeCode, webFetch → hooks over capnweb                │
│    Yjs file tools: local Y.Doc hydrated from doc-state hook, updates back   │
│    inference:     fetch https://<origin>/orb-api/inference  (SSE passthru)  │
│    hooks:         wss://<origin>/api  → authenticateOrbHarness(jwt)         │
└───────────────┬───────────────────────────────┬─────────────────────────────┘
                │ capnweb WS (hooks + events)   │ HTTPS SSE (model tokens)
┌───────────────▼───────────────┐   ┌───────────▼────────────────────────────┐
│ Overseer DO (kernel)          │   │ backend Worker /orb-api/inference      │
│  chat log, Yjs, capabilities, │   │  validates turn grant JWT, attaches    │
│  turn queue, token mint/gen,  │   │  provider endpoint+auth server-side,   │
│  executeCode, observations,   │   │  streams provider SSE back verbatim,   │
│  emitChatStreamEvent → UI     │   │  forwards usage/log-id headers         │
└───────────────────────────────┘   └────────────────────────────────────────┘
```

## The credential proxy (Cloudflare primitives only)

Two token kinds, both minted by the kernel, both revocable, neither a provider key:

**Orb session token** (long-lived per orb generation)
- JWT (jose — already a backend dep), signed with a backend secret (wrangler secret
  `ORB_SESSION_SIGNING_KEY`). Claims: `sub` = Overseer DO id, `uid` = owner user id,
  `gen` = orb generation counter from DO storage, `exp` = 15 min.
- Injected at harness start via envd (env var on Process/Start — never in the template or
  snapshot), refreshed over the live hooks session (`refreshOrbSession()`); revocation = DO
  bumps `gen` (thread deletion, ownership change, panic button).
- Grants exactly: `authenticateOrbHarness(jwt)` on the existing public capnweb endpoint,
  returning a **thread-scoped hooks stub** — the same authority the in-DO loop has today, no
  more. A stolen token's blast radius is one thread the attacker's code was already driving.

**Turn inference grant** (short-lived per turn)
- Minted by the DO when it dispatches a turn: JWT with `sub` = thread, `turn` = turn id,
  `model` = the resolved model id + gateway route (resolution stays in ai-models.ts,
  server-side; the orb cannot choose endpoints), `exp` = 30 min, single-model.
- `POST /orb-api/inference` (new backend Worker route, router passes /orb-api/* through):
  validates grant, constructs the provider request server-side (endpoint + auth header from
  Worker secrets / AI Gateway config), forwards the harness's pi-ai payload, and **streams the
  provider SSE body back unmodified with usage/log-id response headers forwarded**. pi-ai's
  stream parsers run in the harness against that passthrough; the harness's ModelHandle is a
  StreamFunction wrapping this fetch. Cost accounting is unchanged: the harness reports
  totalTokens/aiGatewayLogId/estimatedCost through `hooks.addChatMessages` exactly as the
  in-DO loop does today.
- Concurrency guard: DO tracks outstanding grants per thread (≤2) and per user QPS at mint time;
  the proxy checks only signature/expiry/single-use-per-stream, keeping it stateless.

Result: `OPENROUTER_API_TOKEN`, gateway tokens, gatekeeper credentials, and user tokens never
exist in the sandbox. This is the same broker shape Amp uses (server authorizes each inference
with request-scoped credentials) and the mitigation every agent-in-sandbox shipper built.

## Turn lifecycle (queue-and-claim, outbound-only)

1. `startAgent` (unchanged surface): DO prepares the turn exactly as today — replay, compaction
   checkpoint selection, `modelMessages`, binding seed — and enqueues a turn record instead of
   running the loop when the thread's executor is `orb`.
2. DO ensures the orb is awake (existing wakeOrb) and the harness process is running (envd
   Process/Start of the harness with the session JWT env; supervised — see below). It mints the
   turn grant.
3. The harness holds the hooks session and has passed the DO an `OrbHarnessTarget` RpcTarget
   (capnweb bidirectional, same pattern as AiChatSubscriber). The DO calls
   `harness.runTurn(turnRecord)`. If the socket is down, the turn sits queued; the harness
   claims pending turns on reconnect (`claimPendingTurn()`) — at-least-once, deduped by turn id,
   mirroring the thread-graph delivery machinery.
4. The harness runs `runAgentLoopContinue`. Every emit lands as today: stream events via
   `emitChatStreamEvent`, turn_end barriers via `addChatMessages` (which the DO persists with
   modelData snapshots — the chat log format does not change).
5. Turn end: harness reports terminal state; DO clears `activeAgent`, runs the same
   unregister/alarm bookkeeping. Abort: DO calls `harness.abortTurn(turnId)`; a dead-socket
   abort falls back to killing the harness process via envd SendSignal and marking the turn
   failed-restartable — the same crash-recovery semantics the DO loop has now.

DO liveness while a turn runs elsewhere: the keep-alive alarm stays armed exactly as today
(`#registerRunningAgent` path), because the DO must survive to relay streams; the hooks WS is an
*incoming* connection to the DO, which also resets eviction.

## What actually gets refactored (the honest inventory)

**agent.ts splits into portable core + workerd residue.** agent.ts imports
`cloudflare:workers` only for NativeRpcStub in the agent-callback args machinery
(makeStorableArgs), which is executeCodeMode plumbing and stays DO-side. New package
`packages/agent-core` (plain TS, no workerd imports): system prompt, tool definitions, the loop
driver, replay/compaction helpers, diff formatting — consumed by workshop-backend (in-DO
executor, unchanged behavior) and orb-harness. This is a mechanical extraction, but it is the
riskiest diff to review because agent.ts is 3k+ lines of kernel-adjacent code.

**AgentHooks goes on the wire.** Audit result by method class:
- Clean over capnweb as-is: addChatMessages, emitChatStreamEvent, recordAgentObservation,
  consumeCapturedActions, activeAgentCallbackCount, rejectAllAgentCallbacks, getChatModelData,
  getChatAttachmentData (Uint8Array), listAvailableTemplates, describeStandardFormats,
  fetchTemplate, getInstanceInstructions, prepareChatBindings, describeBinding, createArtifact,
  addArtifactBinding, resolveWorkpieceRoot, spawn/send/wait/list/read child-thread methods.
- Callback-carrying, capnweb-native: executeCodeMode(onOutputText) — client-side callback stubs
  are exactly what capnweb does; executeShellInOrb is *deleted from the wire* (local in harness).
- New hooks required:
  - `getWorkpieceDocState(workpieceId): Uint8Array` + updates shipped back through the
    existing captured-changes flow — live Y.Docs cannot cross RPC, so the harness hydrates local
    Y.Docs from update bytes and the "changes" message path (codeUpdate events already carry
    Uint8Array) closes the loop. This needs careful review against flushCapturedYdocChanges
    ordering (the known single-step edit+executeCode caveat in agent.ts applies unchanged).
  - `executeWebFetch(...)`: webFetch stays DO-side (WebFetchEnv wraps a Workers AI binding for
    doc→Markdown, not wire-safe, and server-side fetch keeps SSRF checks + observation recording
    authoritative). The tool remotes like executeCode.
  - `refreshOrbSession()`, `claimPendingTurn()`, turn-terminal reporting.
- The wire contract lives in workshop-shared (plain types, no Effect values across the boundary),
  validated with capnweb-validate like the rest of the API surface.

**Orb harness package** (`packages/orb-harness`, Bun target, Effect v4 from the catalog):
- `BrokerClient` Layer: owns the capnweb WS session (Scope-managed), authenticateOrbHarness,
  reconnect via Effect.Schedule (exponential, jittered), session refresh fiber.
- `Inference` Layer: StreamFunction over fetch to /orb-api/inference; retries surface as pi
  turnFailure exactly as provider errors do today.
- `TurnRunner`: wraps runAgentLoopContinue in Effect.tryPromise at the boundary (pi stays
  Promise-based; we do not rewrite pi), maps abort to fiber interruption.
- `Supervisor` entry: harness main = Layer.launch of the above; crash = process exit = envd
  restart by the DO (Process/Connect finding it dead → Start again), with the turn queue making
  restarts safe.
- Distribution: built as a single-file Bun bundle, uploaded to the orb via envd files API at
  first wake per deploy (hash-checked, cached in the pause snapshot thereafter — no E2B template
  rebuild per release; template just needs Bun).

**Backend-side new code** (Effect style like orb/*.ts): /orb-api/inference route, orb session
JWT mint/verify/gen storage, turn queue records, harness supervision calls. All small,
separately reviewable.

## Phasing (kernel-review-sized)

0. **Prereqs from the prior plan**: envdAccessToken capture; envd streaming module (frame
   envelopes, Keepalive-Ping-Interval: 30). Ships standalone value (streaming executeShell for
   the in-DO loop) and is needed for harness supervision regardless.
1. **agent-core extraction**: mechanical split, zero behavior change, in-DO loop consumes it.
   Largest diff, most mechanical; land before anything interesting so later PRs are small.
2. **Credential proxy**: /orb-api/inference + session/grant JWTs + authenticateOrbHarness
   returning the hooks stub. Testable without any harness (curl a grant, see provider SSE).
3. **Harness + remoted hooks**: orb-harness package, new hooks, turn queue. Behind a per-thread
   `executor: "do" | "orb"` field defaulting to `do`; admin/user toggle later.
4. **Cutover + Amp-parity features**: orb executor default for new threads once e2e-verify
   scripts pass against it (extend e2e-verify/agent-verify.mjs with an orb-executor thread);
   repo-in-orb workspace, shared PTY terminal, portals — per the prior plan's Phase 3, now
   natural since the agent already lives there.

Rollback story at every phase: the in-DO executor never leaves; `executor` flips back per
thread.

## Costs accepted (say them out loud)

- **Latency**: every hook call and every model token crosses orb↔Worker. Token streams add one
  passthrough hop (Worker in the middle); hook calls add ~RTT each — executeCode-heavy turns pay
  the most. Mitigation: hooks are coarse; nothing chatty like per-file-line calls exists.
- **VM wall-clock billing** for the whole loop including model-thinking time, plus idle-pause
  cannot fire mid-turn. (Amp bills the same shape.)
- **Egress**: E2B sandboxes have open internet by default. The DO loop's executeCode remains
  no-egress, but the harness process itself can reach anywhere. Follow-up: E2B egress rules
  allowlisting <origin> + package registries; until then this is a *weaker* network posture than
  today and the plan says so rather than pretending otherwise.
- **Two executors during migration** (do + orb) — bounded by the cutover phase, but real:
  behavior drift between them is a bug class until `do` is retired or frozen.
- **workerd→Bun subtle diffs** in agent-core (Date/crypto/TextDecoder are fine; anything
  importing workerd-only APIs is caught at the package boundary by construction).

## BatonFX (../batonfx): assessed, and the recommendation is not yet

What it is: an Effect-native agent framework over `effect/unstable/ai` — model-turn loop,
Tool/Toolkit from Effect AI, a ToolExecutor with **placement routes (client/remote/mcp/sandbox)**,
typed suspension/approvals, and an optional durable Runtime (addressable Runs, canonical RunEvent
streams, replay cursors, child fan-out) persisted via @effect/sql (sqlite-bun/mysql/pg) with
SSE/WS transport. Every export is `@experimental`; pinned to `effect@4.0.0-beta.98`;
Bun/Node only.

What adoption would take, concretely:
1. **Effect pin alignment.** batonfx: 4.0.0-beta.98; this repo: 4.0.0-rc.109. Pre-1.0 Effect
   moves between snapshots; batonfx's 13 packages must bump first. (It is your repo, so this is
   schedulable — but it is real work before line one here.)
2. **The loop swap is a vocabulary swap.** The chat log persists pi shapes
   (StoredAssistantMessage modelData, CompactionCheckpoint); replay, compaction, the
   AiChatStreamEvent mapping, and all ~20 tools speak pi Messages/AgentContext. Moving to Effect
   AI Prompt/Response/Tool means rewriting agent.ts *and* migrating or dual-reading every
   existing thread's history. That is a kernel rewrite, not a dependency change.
3. **The durable Runtime doubles the kernel.** Overseer DO storage already owns runs, replay,
   children (thread graph), steering, and budgets. @batonfx/runtime owns the same concepts over
   @effect/sql on Bun — not workerd, and not DO storage. Adopting it in the DO means either a
   DO-storage RunStore driver (new, load-bearing) or moving thread state out of DOs entirely
   (a different product architecture).
4. **The tempting middle — @batonfx/core only in the orb harness** — creates two agent
   vocabularies in one product: batonfx events in orb threads, pi messages in DO threads, with a
   conversion layer at the broker and behavioral drift (compaction, turn policy, tool semantics)
   between them. Worse than either pure option.

What batonfx gets right *for this design*: ToolExecutor placement routes are precisely the
remoted-vs-local tool split above; transport's replay cursors are the reconnect story; Runtime
child admission subsumes the hand-rolled thread graph. Which is the argument for the deliberate
path, not the incidental one.

**Recommendation: stay with pi for this refactor.** pi runs on Node today, the loop and log
format move into the orb unchanged, and the whole risk budget goes to the broker — which is the
part that must be right. Design consolation: the broker protocol above is loop-agnostic (hooks
over capnweb + inference passthrough), so a future batonfx migration swaps the harness internals
without touching the credential or transport architecture. Revisit batonfx as its own project
when (a) its Effect pin matches the repo's, (b) you are prepared to migrate the chat-log
vocabulary with a dual-read window, and (c) you want its Runtime to replace the thread-graph
machinery — evaluated then against what pi has become in the meantime.


---

## Appendix A — seam verification and what landed (as-built)

Verified against the tree at `a9ab365` + the working changes, pi-ai 0.83.0 (openai SDK 6.26.0).
These are the answers to the questions the plan left open; they correct two assumptions in the
design (the proxy addressing, and baseUrl not being a stream option).

### A.1 pi-ai endpoint override surface (the critical unknown, resolved)

- `StreamOptions` has **no `baseUrl`**. Every API impl builds its SDK client from
  `model.baseUrl` (openai-completions: `new OpenAI({baseURL: model.baseUrl, ...})`;
  anthropic-messages likewise). The harness therefore shapes a **Model object** — not a stream
  option — with `baseUrl` pointing at the proxy. The turn record's `OrbModelSnapshot` is that
  shape, minus secrets.
- URL composition: the openai SDK builds `new URL(baseURL + path)` (slash-aware join). With
  harness baseUrl = `<origin>/orb-api/inference`, the request hits
  `/orb-api/inference/chat/completions` (path-based suffix; anthropic appends `/v1/messages`).
  **The proxy's suffix therefore comes from the URL pathname — the earlier `?path=` query
  contract could never be produced by pi and was replaced (see A.4).**
- Auth: `options.headers` merge after `model.headers`, and `getClientApiKey` returns `"unused"`
  when an `authorization` header is present — so the harness passes
  `headers: {Authorization: Bearer <grant>}` with no `apiKey` and pi does not complain.
- Compat: `getCompat(model)` auto-detects from `baseUrl`; the proxy URL is unrecognized, so
  provider-specific request shaping (thinkingFormat, maxTokensField, session-affinity headers,
  `prompt_cache_key`) falls back to defaults. The resolved pi `Model` (which carries the
  catalog-derived `compat`) is serialized into the turn record so the harness shapes requests
  exactly as the in-DO loop does; `prompt_cache_key` keying off `api.openai.com` simply won't
  trigger, which is benign.
- Everything else the loop needs from `Model` (`api`, `provider`, `reasoning`, `input`, `cost`,
  `contextWindow`, `maxTokens`, `cost` rates) is plain data and rides in `OrbModelSnapshot`.

### A.2 Seam inventory (exact shapes at the cited lines, verified)

- `runAgent(hooks, handle, chatId, author, chatMessages, abortSignal, initiator,
  callbackInitiated, compaction)` — agent.ts:965 (post-pull-up), signature matches the plan.
- `AgentHooks` (agent.ts) is the boundary. Partition confirmed:
  * wire-safe as-is: getChatAgentContext, listArtifactInfo, resolveWorkpieceRoot, createArtifact,
    describeBinding, addArtifactBinding, prepareChatBindings, spawn/send/wait/list/read child
    thread methods, activeAgentCallbackCount, rejectAllAgentCallbacks, consumeCapturedActions,
    addChatMessages, emitChatStreamEvent, getChatModelData, recordAgentObservation,
    getChatAttachmentData, getInstanceInstructions, listAvailableTemplates,
    describeStandardFormats, fetchTemplate
  * local-to-harness (not on the wire): buildYDoc (replaced by getWorkpieceDocState + a local
    Y.Doc per thread), executeShellInOrb (the point of the move), getWebFetchEnv (remoted as
    executeWebFetch — Workers-AI conversion + SSRF stay server-side)
  * callback-carrying: executeCodeMode(onOutputText) — the signature already takes the callback.
- `ModelHandle` (ai-models.ts): `{model, stream, aiGatewayLogRoute?, lastResponse?}`; the
  proxy ModelHandle satisfies it by wrapping `openaiCompletionsStream` (the same parser
  `makeHandle` uses for in-process inference).
- `emitChatStreamEvent` (overseer.ts:6252): iterates `#chatSubscribers` calling
  `subscriber.stream(chatId, event)` — a capnweb fan-out. The harness's emit arrives over the
  wire and lands in this same method: the browser path below it is byte-identical.
- `executeCodeMode` (overseer.ts:5732): Worker Loader with `globalOutbound: null`, `tails`
  CodeModeTailLoopback, `#codeModeOutputSubscribers` keyed by executionId —
  `deliverCodeModeText(executionId, delta)` is the callback sink the harness's capnweb callback
  stub will drive.
- `executeShellInOrb` (overseer.ts:5859): `wakeOrb` + `runOrbCommand` (envd.ts, buffered
  `await response.text()` — the 120s-blob behavior the move kills). envd.ts keeps only harness
  supervision; `writeFile` (multipart /files) is the harness-bundle upload path.
- Turn entry: `startAgent` → `#runAgentTurn` → `#runAgentTurnWithContext` (overseer.ts:4209).
  All replay/compaction/binding prep happens inside `#runAgentTurnWithContext` *before* the
  `runAgent` call — that whole prefix is what a dispatch path must replicate before enqueuing a
  turn record.
- Subscriber protocol (api.ts): `AiChatSubscriber.stream(chatId, event)` +
  `streamGeneration(n)` — the harness registration mirrors this pattern with
  `OrbHarnessTarget`; the provisional-state generation counter already tolerates harness
  restarts.

### A.3 Type pull-up (Phase 1's wire-type surface, landed)

The wire-crossable agent types moved to `packages/workshop-shared/src/agent-types.ts` with one
canonical definition: `StoredToolCall`, `StoredAssistantMessage`, `AiChatMessageBodyWithModelData`,
`SeedBindingInfo`, `ChatBindingEntry`, `AiChatAgentContext`, `AgentCatalogSnapshot`,
`AgentArtifactInfo`, `CompactionCheckpoint`, `CompactionContext`, `AiGatewayLogRoute`.
Backend modules re-export (ai-gateway.ts, agent-catalog.ts) or import directly (agent.ts,
overseer.ts, agent-compaction.ts, tests). `workshop-shared` now type-imports pi-ai (0.83.0 —
new dep, type-only, erased from bundles). 307 backend tests pass; backend tsc clean; frontend
unaffected (the only frontend tsc error, `route-guards.test.ts` loader typing, pre-exists on
this tree). Oxlint: my files contribute 0 errors (the remaining repo errors — `vi` unused in
message-format-refs.test.ts, `no-shadow` in typed-storage/frontend — pre-exist).

### A.4 The wire contract and the proxy correction (landed)

- `packages/workshop-shared/src/orb-harness.ts` now defines the boundary: `OrbHooks` (the
  full wire subset of AgentHooks + getWorkpieceDocState, executeWebFetch, claimPendingTurn,
  reportTurnTerminal, refreshOrbSession, mintInferenceGrant), `OrbHarnessTarget`
  (runTurn/abortTurn/ping), `OrbTurnRecord` (turnId, chatId, model snapshot, aiGatewayLogRoute,
  grantJwt, chatMessages, author, initiator, callbackInitiated, compaction),
  `OrbTurnOutcome`. The grant rides inside the record (the plan sketch passed it as a second
  argument; the record is what claimPendingTurn returns, and the claim path re-mints a fresh
  grant anyway).
- Proxy addressing fixed: `handleOrbInference` derives the provider API suffix from the URL
  **pathname** (`/orb-api/inference/chat/completions` → suffix `/chat/completions`), appends it
  to the resolved provider base, and forwards the request's query string. `server.ts` matches
  the `/orb-api/inference` subtree; the router already forwards `/orb-api/*`. Tests updated to
  the real calling shape, including origin-escape coverage (a suffix like `/https://...` cannot
  leave the resolved provider's host). No credential ever returns to the caller (17 tests).

### A.5 Remaining phases (unchanged from the plan)

1. Phase 1 extraction: move the loop driver + tools from agent.ts into `packages/agent-core`
   (now unblocked — its wire types live in shared). Nothing below the boundary changes.
2. Phase 2 remainder: orb session JWT (15-min, `gen` claim, DO-bumped revocation) +
   `authenticateOrbHarness(jwt)` on the public capnweb API returning a thread-scoped
   `OrbHooks` RpcTarget; turn queue records (`claimPendingTurn` dedupe); harness supervision
   via envd (protected by the buffered-envd → streaming-envd prereq).
3. Phase 3: `packages/orb-harness` (Bun, Effect v4): BrokerClient (capnweb session + retry),
   Inference layer (`makeProxyHandle` per A.1), TurnRunner, local executeShell.
4. Phase 4: cutover — per-thread `executor: "do" | "orb"`, e2e-verify against orb threads.
