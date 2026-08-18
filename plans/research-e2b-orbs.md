# Research: Replicating Amp's Orb + Thread Architecture with E2B on Cloudflare Workers

Date: 2026-02 (research snapshot). Sources cited inline. Target: `workshop-backend`-style
Cloudflare Workers control plane, Durable Object (DO) per thread, each thread backed by an
E2B Firecracker microVM that pauses when idle and resumes on activity.

---

## 1. E2B TypeScript SDK

### 1.1 Does the `e2b` JS SDK run inside workerd?

**Officially: no.** E2B's own troubleshooting docs state:

> "The E2B JavaScript SDK currently lacks support for Vercel Edge Runtime and Cloudflare
> Workers due to transport layer package incompatibility used for Sandbox communication.
> We recommend using supported runtimes like Node, Bun, or Deno instead."
> — https://e2b.dev/docs/troubleshooting/sdks/workers-edge-runtime

Why, concretely (from reading `packages/js-sdk` in https://github.com/e2b-dev/E2B):

- The SDK has **two transport layers**:
  1. **Control plane**: plain `fetch` REST calls to `https://api.e2b.app` (create, list,
     pause, resume, kill, timeout). This part is runtime-agnostic and works in workerd.
  2. **Data plane ("envd")**: each sandbox runs a daemon (`envd`, port **49983**) that the
     SDK talks to via **ConnectRPC** (`createConnectTransport` from
     `@connectrpc/connect-web`, see `packages/js-sdk/src/sandbox/index.ts`) plus a small
     envd HTTP API (`/files` multipart upload/download). `commands.run`, `files.*`, `pty`
     all go through this.
- Historical blockers, and their current status:
  - `process.env` missing in workerd → **fixed**; SDK now tolerates missing `process` and
    accepts `apiKey`/config explicitly (e2b-dev/E2B#315, closed 2025-04).
  - `@connectrpc/connect-web` sets `mode` on `RequestInit`, which workerd's `fetch`
    rejects ("The 'mode' field on 'RequestInitializerDict' is not implemented") —
    connectrpc/connect-es#1274 (filed by an E2B engineer), duplicate of #550/#577. The
    documented workaround is to pass a custom `fetch` to the transport that strips `mode`;
    connect-es v2 improved non-Node runtime support, but E2B has not certified the SDK on
    workerd.
  - `e2b@2.33.0` switched bundling to rolldown, whose runtime shim executes
    `createRequire(import.meta.url)` at module-eval time; in dynamically-loaded Workers
    `import.meta.url` is `undefined` and the workerd `node:module` polyfill throws before
    any code runs. `e2b@2.32.0` is the last version without this (see
    github.com/parall-hq/parel-oss#53, which pins to 2.32.0 exactly).

**Practical conclusion:** the *control plane* (lifecycle) should be done with the raw REST
API from the Worker — it is small and stable. For the *data plane*, either (a) attempt the
SDK under `nodejs_compat` with `e2b` pinned ≤2.32.0 and a `mode`-stripping fetch, and
treat it as unsupported-but-plausible, or (b) write a thin envd client over `fetch` — the
Connect protocol is ordinary HTTP POST with (optionally streamed) response bodies, which
workerd handles fine. Section 1.6 documents the endpoints for both.

### 1.2 SDK API surface (js-sdk v2.28.x, https://e2b.dev/docs/sdk-reference/js-sdk/v2.28.2/sandbox)

```ts
import { Sandbox } from 'e2b'

// Create — template defaults to 'base'
const sbx = await Sandbox.create(template?: string, opts?: SandboxOpts)
const sbx = await Sandbox.create({
  apiKey: '...',                 // else E2B_API_KEY env var
  timeoutMs: 10 * 60 * 1000,     // default 300_000 (5 min)
  envs: { KEY: 'value' },        // sandbox-wide env vars
  metadata: { threadId: '...' }, // control-plane-only key/values, filterable in list
  secure: true,                  // envd requires envdAccessToken (default true in new SDKs)
  allowInternetAccess: true,
  network: { allowOut: [...], denyOut: [...], rules: {...}, egressProxy: {...} },
  lifecycle: {
    onTimeout: 'pause',          // 'kill' (default) | 'pause' | { action: 'pause', keepMemory: false }
    autoResume: false,           // paused sandbox wakes on incoming traffic (default false)
  },
})

// Instance surface
sbx.sandboxId          // string, persist this
sbx.sandboxDomain      // host for public URLs
sbx.trafficAccessToken // only with restricted public traffic
sbx.commands           // Commands module
sbx.files              // Filesystem module
sbx.pty                // pseudo-terminals
sbx.git                // git operations

// Commands (https://e2b.dev/docs/sdk-reference/js-sdk/v2.28.2/sandbox-commands)
const res: CommandResult = await sbx.commands.run(cmd, {
  envs, user, timeoutMs, requestTimeoutMs, stdin,
  onStdout: (d) => {}, onStderr: (d) => {},
})                                              // waits; res.stdout / res.stderr / res.exitCode
const handle: CommandHandle = await sbx.commands.run(cmd, { background: true })
await handle.wait()                             // or handle.kill()
await sbx.commands.connect(pid, opts)           // re-attach to a running command (list via commands.list())

// Filesystem
await sbx.files.write(path, data)               // creates parent dirs; overwrites
await sbx.files.read(path, { format: 'text' | 'bytes' | 'stream' })
await sbx.files.list(path, { depth })
await sbx.files.exists(path)
const unwatch = await sbx.files.watchDir(path, (event) => {})

// Lifecycle
await sbx.pause()                               // Running -> Paused (betaPause() is the deprecated name)
await sbx.setTimeout(timeoutMs)                 // extend/shrink TTL; max 24h Pro, 1h Hobby
await sbx.kill()                                // terminal, unrecoverable
const again = await sbx.connect()               // resumes if paused

// Statics
await Sandbox.connect(sandboxId, opts)          // "Connect to a sandbox. If the sandbox is
                                                //  paused, it will be automatically resumed."
await Sandbox.pause(sandboxId, opts)            // static form
await Sandbox.kill(sandboxId, opts)
await Sandbox.list({ query: { state: ['running','paused'], metadata: {...} } }) // paginator
await Sandbox.getFullInfo(sandboxId)            // { endAt, cpuCount, memoryMB, metadata,
                                                //   lifecycle: { autoResume, onTimeout: 'kill'|'pause' }, ... }

// Ports
const host = sbx.getHost(3000)                  // -> `${port}-${sandboxId}.e2b.app`
// public URL: https://{port}-{sandboxID}.e2b.app  (the old `domain` response field is deprecated)
```

### 1.3 Auth

- One API key authenticates SDK, CLI, and REST: `E2B_API_KEY` env var, or per-client
  `Sandbox.create({ apiKey })`. (https://e2b.dev/docs/api-key)
- REST: `X-API-Key: <api-key>` header on `api.e2b.app` (ApiKeyAuth in the OpenAPI spec).
- Client config knobs (`ConnectionConfig`): `domain` (default `e2b.app` →
  `https://api.{domain}`), `requestTimeoutMs` (default 60 000), `headers`, `debug`.
- envd auth: when a sandbox is created `secure: true`, the create/connect response includes
  an **`envdAccessToken`** that must accompany envd requests; file upload/download URLs are
  HMAC-signed with it. Non-secure sandboxes accept envd requests unauthenticated (the
  sandbox hostname is the only secret). `trafficAccessToken` gates public-traffic proxying
  when `network.allowPublicTraffic: false`.

### 1.4 Persistence: pause / resume (https://e2b.dev/docs/sandbox/persistence)

- States: **Running → Paused → Running**, plus terminal **Killed** and a transient
  **Snapshotting** state.
- `pause()` snapshots **filesystem + memory** — running processes, loaded state, everything.
  Pass `keepMemory: false` (or `onTimeout: { action: 'pause', keepMemory: false }`) for a
  filesystem-only snapshot that **cold-boots** on resume (cannot be auto-resumed by traffic).
- Performance: pause ≈ **4 s per 1 GiB RAM**; resume ≈ **1 s**.
- Retention: paused sandboxes are kept **indefinitely** — no TTL, no auto-delete; you must
  `kill()` explicitly to remove them.
- Continuous runtime limit: 24 h (Pro) / 1 h (Hobby); **pausing resets the window**.
- **Auto-pause**: `lifecycle: { onTimeout: 'pause' }` at create; persistent — every
  resume→idle cycle pauses again. Each resume gets a fresh timeout (≥5 min, or the original
  creation timeout if larger). (https://e2b.dev/docs/sandbox/auto-resume)
- **Auto-resume**: `lifecycle: { autoResume: true }` — any HTTP request to the sandbox's
  public URL (`getHost(port)`) wakes it. This is exactly Amp's portal-wake behavior.
- Cost: E2B bills running sandboxes by compute time (vCPU/RAM per second — see
  https://e2b.dev/docs/billing-and-limits); a paused sandbox consumes no compute. (Amp
  passes this through: "A paused orb does not cost anything.")
- Network caveat: pausing disconnects all clients of services inside the sandbox; on resume
  the service is reachable again but clients must reconnect.
- **Sandbox ID stability — important caveat.** Docs and SDK model the ID as stable ("save
  the sandbox ID in your database to resume later"), and `connect()` normally returns the
  same ID. However, community bug reports against the auto-resume path (e.g. discussion
  around e2b-dev/E2B#884) describe the orchestrator occasionally binding a resume to a
  **new** `sandboxId`, and a snapshot write-back race that lost recently-written files when
  a sandbox was resumed while idle-tracking was in flight. Defensive posture: always
  **persist the `sandboxID` returned by each connect/resume response** (treat it as
  possibly-new), and prefer **explicit pause** (via API, before you consider the thread
  idle) over relying solely on involuntary idle-pause when filesystem consistency matters.

### 1.5 Custom templates

- Legacy flow: `e2b.Dockerfile` + `e2b.toml`, built with `e2b template build`
  (`--cpu-count`, default 2; `--memory-mb`, default 512; `--build-arg`, `--no-cache`,
  `-t/--team`). `e2b template migrate` converts to the new format.
- New **Template SDK** (https://e2b.dev/docs/template/start-ready-command):

```ts
import { Template, waitForPort, waitForURL, waitForTimeout, waitForFile } from 'e2b'
const template = Template()
  .fromUbuntuImage('22.04')          // or .fromImage('...'), .fromDockerfile(...)
  .aptInstall(['curl', 'python3'])
  .runCmd('...')
  .setStartCmd('npm start', waitForPort(3000))  // runs at END of build; snapshot taken
  .setReadyCmd(waitForPort(80))                 // gate the snapshot without a start cmd
```

  The build **executes the start command, waits for the ready command, then snapshots the
  entire sandbox including the running process** — so `Sandbox.create(template)` boots into
  an already-warm process. This is the mechanism to replicate Amp's "snapshot after
  `.agents/setup`" (§2.4): bake repo-independent tooling into the template; run per-repo
  setup once in the live sandbox and rely on pause snapshots thereafter.

### 1.6 Raw REST API (works from workerd today)

Platform endpoints on `https://api.e2b.app`, auth `X-API-Key`
(https://e2b.dev/docs/api-reference):

| Endpoint | Purpose |
|---|---|
| `POST /sandboxes` | Create. Body `NewSandbox`: `templateID` (required), `timeout` (seconds, default 15), `autoPause` (bool), `autoPauseMemory` (bool, default true; false ⇒ filesystem-only snapshot), `autoResume: { enabled }`, `secure`, `allow_internet_access`, `network`, `metadata`, `envVars`, `mcp`, `iam`, `volumeMounts`. → `201` `Sandbox { sandboxID, templateID, envdVersion, envdAccessToken?, trafficAccessToken? }` |
| `GET /v2/sandboxes?state=running,paused&metadata=k%3Dv` | List (v1 `GET /sandboxes` is deprecated). Metadata filter is URL-encoded `k=v&k2=v2`. |
| `GET /sandboxes/{id}` | Info (incl. `state`, `endAt`, `lifecycle`). |
| `POST /sandboxes/{id}/connect` | **The resume-or-touch primitive.** Body `{ "timeout": <seconds> }`. `200` = was already running (TTL only extended), `201` = was paused and resumed. Supersedes the deprecated `POST /sandboxes/{id}/resume`. |
| `POST /sandboxes/{id}/pause` | Explicit pause (snapshot). `409` if already paused. |
| `POST /sandboxes/{id}/timeout` | Set/extend TTL. |
| `DELETE /sandboxes/{id}` | Kill (also deletes a paused snapshot). |
| `GET/POST /templates...` | Template management. |

Data-plane ("envd") endpoints are served per-sandbox at
`https://49983-{sandboxID}.e2b.app` (or the shared host `sandbox.e2b.app` with
`E2b-Sandbox-Id` + `E2b-Sandbox-Port` headers):

- `GET/POST {envd}/files?path=...&username=user` — file download / multipart upload
  (signed URLs available for secure sandboxes).
- ConnectRPC services (`filesystem.Filesystem`: ListDir/Stat/Watch…;
  `process.Process`: Start/Connect/SendInput/Update…): plain HTTP POST,
  `Content-Type: application/connect+json` (or proto), with **server-streamed** response
  frames for process output. workerd can issue these with `fetch` and read the streamed
  body — no WebSocket and no HTTP/2-specific client requirement.
- Exposed user ports: `https://{port}-{sandboxID}.e2b.app` — this is what `getHost(port)`
  returns, and the URL whose traffic can auto-resume a paused sandbox.

---

## 2. Amp's thread + orb model (ampcode.com)

### 2.1 What is an orb, and is every thread an orb?

- "Orbs are remote machines where Amp agents can run without supervision. **Each Amp
  thread started from ampcode.com in an orb gets its own orb.**" … "Every new thread
  spawns its own orb: a fresh machine with your repository cloned, tools installed, and
  the agent already inside." (https://ampcode.com/manual/orbs,
  https://ampcode.com/what-are-orbs)
- Orbs are **per-thread but tied to the executor choice**: a thread runs either locally
  (CLI/TUI on your machine) or in an orb. Web-created threads always get an orb; CLI opts
  in with `amp -ox "prompt"` (`--orb-size a1.small`), TUI `thread: new in orb`, plugins
  `agent.createThread({ executor: 'orb' })`. So the 1:1 thread↔orb mapping applies to
  orb-executed threads; local threads have no orb.
- E2B is the substrate: Amp's security page lists "**e2b** — Sees code data when using
  orbs. e2b provides ephemeral compute instances for Amp orbs."
  (https://ampcode.com/security)
- Orbs run **Debian 12** with preinstalled, pre-authenticated tooling (`gh`, `amp`, git,
  SSH, tmux, Node/Bun/npm/pnpm/Yarn, Python, ripgrep, agent-browser, …). Sizes tiny→xxlarge
  (`a1.small` default for personal projects).

### 2.2 Lifecycle and billing

- **Billed by the minute; a paused orb costs nothing.**
- **Auto-pause: 5 minutes after no activity**, plus pause when the thread is archived.
  "You never need to manually pause them." (https://ampcode.com/manual/orbs)
- Wake triggers: user/agent activity in the thread; **any HTTP request to a portal**
  ("Any HTTP request to a portal wakes a paused orb and resumes billing until the orb
  pauses again (5 minutes after no activity)"); **webhooks** ("An incoming request is
  stored before Amp returns HTTP 202, then Amp wakes a paused orb and calls the
  handler"); scheduled **Automations** ("Wake agents in Orbs at specific times or on
  regular intervals").
- This maps 1:1 onto E2B primitives: 5-min auto-pause ≈ `timeoutMs: 300_000` +
  `lifecycle.onTimeout: 'pause'`; portal wake ≈ `autoResume: true` traffic to
  `getHost(port)`; webhook wake ≈ control-plane store-then-`/connect`.

### 2.3 Repository lifecycle hooks (https://ampcode.com/manual/orbs)

| File | Behavior |
|---|---|
| `.agents/setup` | Shell script run from repo root "while preparing project orb state" — install deps, generate files, check tools. Executable, committed. |
| `.agents/resume` | Run from repo root "whenever an existing orb resumes before the agent continues work. **Amp waits up to 10 seconds**; if still running, Amp stops blocking and lets it continue in the orb." For fast, idempotent repair (restart tunnels etc.). A non-zero exit within the window is surfaced. |
| `.amp/services.yaml` | Declares supervised long-lived services; `amp orb services ensure` runs them (each gets `$PORT`, `$AMP_THREAD_ID`, portaled ones `$PUBLIC_URL`) so they survive CLI updates and **orb pause/resume**. |
| `.amp/portals/*.json` | Portal link manifests. |

Hook stdout/stderr go to `/home/user/.cache/amp/logs/setup.log` / `resume.log`
(replaced each run). Amp sets `AMP_ORB=1` inside every orb. The setup result is part of
"project orb state" — i.e. setup runs when preparing the orb for a project, and
subsequent threads/resumes reuse the snapshot rather than re-running setup; `.agents/resume`
is the per-resume hook.

### 2.4 Thread UI and sharing

- Threads are first-class saved artifacts ("You wouldn't code without version control"),
  addressable by URL `https://ampcode.com/threads/T-<uuid>` or `@T-<uuid>` mention.
- Sidebar thread list (TUI: `Ctrl+\` toggles the thread sidebar), thread statuses surface
  running vs. idle; a thread's changes sidebar carries the Ship/Push-to-Branch workflow.
- Visibility: private / unlisted (link) / workspace-shared (default inside workspaces);
  Enterprise workspaces own their members' threads.
- **Multiplayer**: workspace members join an orb-backed thread via the Multiplayer chip —
  shared messages, orb files, changes, portals, terminal; billing stays with the owner.
- `amp sync <thread>` mirrors an orb thread's changes into a local checkout while the
  agent keeps working remotely.

---

## 3. Secure capability exposure: external-service access from inside the sandbox

Problem: our gatekeeper Workers hold OAuth tokens (Microsoft Graph, Google APIs). Code in
an E2B sandbox must exercise those capabilities **without long-lived tokens entering the
sandbox** (agent-authored code can read anything in its env or filesystem, and pause
snapshots persist memory+disk indefinitely).

### 3.1 Amp's approach: OIDC workload identity (https://ampcode.com/news/secrets-of-the-orb, https://ampcode.com/manual/orbs/oidc)

- Inside an orb, `amp orb id-token --audience <aud>` mints a **short-lived RS256 JWT**
  (observed ~10 min: `iat`→`exp` = 600 s) from issuer
  `https://ampcode.com/api/workload-identity`, with claims:
  `aud`, `email`, `sub` = `workspace:<ws>:project:<proj>:user:<user>:thread:<thread>`,
  plus flat `workspace_id`, `project_id`, `user_id`, `thread_id`, `jti`,
  `token_use: "exchanged"`.
- Relying parties (GCP workload identity federation, AWS
  `AssumeRoleWithWebIdentity`, Tailscale trust credentials) verify the JWT against the
  issuer's JWKS and exchange it for **their own short-lived credential**. AWS trust
  policies match on the structured `sub` with `StringLike` since IAM ignores custom claims.
  For services without OIDC support, Amp suggests an oauth2-proxy that injects credentials
  server-side.
- Net effect: **zero standing secrets in the orb**; every credential is audience-bound,
  thread-attributed (auditable via `thread_id`), and expires in minutes. Amp separately
  supports project-level secrets/env vars for things that must live in the orb, but OIDC is
  the recommended path for cloud/service access.

### 3.2 E2B's native mechanisms and their security properties

- **`envVars` at create** (`Sandbox.create({ envs })`): injected into every process in the
  sandbox; readable by all sandbox code; **persist across pause/resume** (memory+disk
  snapshot, retained indefinitely). Fine for non-secret config and for *short-lived*
  bearer tokens you rotate on every resume — wrong for OAuth refresh tokens or long-lived
  API keys.
- **`metadata`**: control-plane-only key/values for list-filtering (`user=abc&app=prod`);
  **not injected into the sandbox** — safe place for `threadId`/`userId` correlation, but
  it is not a secret store either (readable by anyone with the E2B API key).
- **Egress proxy header injection** (https://e2b.dev/docs/sandbox/internet-access): the
  `network.rules` config can transform matched outbound flows at E2B's proxy — including
  IAM-integrated injection:

  ```ts
  await Sandbox.create({
    network: {
      allowOut: ({ rules }) => [...rules.keys()],
      denyOut: ({ allTraffic }) => [allTraffic],
      rules: {
        'api.internal.example.com': [{
          transform: ({ iam }) => ({ headers: { Authorization: `Bearer ${iam.tokens.aws}` } }),
        }],
      },
    },
  })
  ```

  The credential is attached **outside** the sandbox; sandbox code never sees it. This is
  E2B's closest analogue to Amp's oauth2-proxy recipe, but the `iam` token set is
  E2B-managed (cloud-provider federation) — it does not hold *our* per-user Microsoft/Google
  OAuth grants, so it cannot replace the gatekeepers.
- No E2B-native per-sandbox OIDC identity token exists today (nothing like
  `amp orb id-token`); the `sub`-equivalent has to be built in our control plane.

### 3.3 The proxy pattern (recommended)

Keep every OAuth token in the gatekeeper Workers, and give the sandbox only a **per-thread,
short-lived capability token** for calling back into our control plane:

1. When the thread DO creates or resumes a sandbox, it **mints a bearer token**: random
   256-bit value (or a signed JWT with `{ threadId, sandboxId, userId, exp ≈ now+TTL,
   jti }`), stores the hash + scopes in DO storage, and injects it via `envVars`
   (`WORKSHOP_CAP_TOKEN`, `WORKSHOP_PROXY_URL`) — for resume, since envs are fixed at
   create, deliver the fresh token by writing a mode-0600 file through envd
   (`sbx.files.write('/home/user/.workshop/token', ...)`) before unblocking the agent.
2. Sandbox code calls `https://<router>/sandbox-proxy/<gatekeeper>/<capability>` with that
   token. The route lands on the thread DO (or a stateless verifier that asks the DO),
   which checks: token valid + unexpired, **bound to this thread's current sandboxId**,
   capability within the thread's granted scopes — then invokes the same gatekeeper
   capability interface the Workshop already uses (`getGatekeeperClassFor()` chokepoint
   still enforces admin policy), records the call as an observation, and streams the
   response back.
3. **Rotate on every resume, revoke on pause/kill** (delete the hash from DO storage in the
   same step that calls `/pause`). Then a snapshot never contains a live credential: tokens
   found in a paused image are already revoked.
4. Optionally harden with E2B `network`: `denyOut: allTraffic` + `allowOut: [router
   hostname, package registries…]`, so exfiltration targets are constrained too.

This is strictly better here than raw OIDC federation (§3.1) because Microsoft Graph /
Google user-delegated OAuth grants cannot be obtained by token exchange from a
third-party issuer — the gatekeeper *must* stay in the loop — and it preserves the existing
capability-security model: the sandbox holds a revocable capability handle, never the
authority itself. An Amp-style OIDC issuer (DO-signed JWTs with a JWKS endpoint on the
router) is a natural later addition for cloud-infra access, reusing the same
`sub = user:<u>:thread:<t>:sandbox:<s>` structure.

---

## 4. Recommendation: Durable Object per thread owning an E2B sandbox

### 4.1 Shape

```
Router ── /api/* ──> workshop-backend ──> ThreadDO (one per thread)
                                            │  storage: { sandboxId, sandboxState,
                                            │             capTokenHash, lastActivityAt,
                                            │             templateId, envdAccessToken }
                                            │  alarm(): reconcile / explicit pause
                                            └── fetch ──> api.e2b.app (REST, X-API-Key)
                                                     └──> 49983-{id}.e2b.app (envd)
```

- **Use the REST API directly** (§1.6) from the DO — the whole lifecycle is 6 endpoints,
  avoids the SDK's workerd problems entirely, and keeps the kernel diff small. If richer
  envd features are wanted later, vendor a thin Connect-over-fetch client or re-test the
  SDK (pinned ≤2.32.0, custom fetch) under `nodejs_compat`.
- `E2B_API_KEY` as a Worker secret; never forwarded to sandboxes or the frontend.

### 4.2 Lifecycle protocol

**First use (thread's first tool/execution request):**
```
POST /sandboxes { templateID, timeout: 300, metadata: { threadId, userId },
                  envVars: { WORKSHOP_PROXY_URL, WORKSHOP_CAP_TOKEN },
                  autoPause: true /* or lifecycle onTimeout:'pause' via SDK */,
                  secure: true }
→ store sandboxId, envdAccessToken in DO storage (single-writer: the DO serializes all
  lifecycle transitions, so no create/resume races)
→ run setup (clone repo, .agents/setup equivalent) via envd; template bakes the toolchain
```

**Every activity (message, tool call, portal hit relayed through router):**
```
POST /sandboxes/{id}/connect { timeout: 300 }
→ 200 running (TTL bumped) | 201 resumed
→ persist response.sandboxID (treat as possibly-new, §1.4)
→ on 201: rotate capability token; run the .agents/resume-equivalent hook (bounded wait ~10 s)
→ storage.put(lastActivityAt); setAlarm(now + 6 min)
```

**Alarm (fires only if no activity re-armed it):**
```
if now - lastActivityAt >= 5 min:
  revoke capability token; POST /sandboxes/{id}/pause   // explicit pause: deterministic
  storage.put(sandboxState = 'paused')                  // snapshot boundary, avoids the
else setAlarm(lastActivityAt + 6 min)                   // idle-resume race in §1.4
```
E2B's server-side `onTimeout: 'pause'` (set slightly longer, e.g. 10 min) stays on as the
backstop for DO eviction/crashes — reconcile via `GET /sandboxes/{id}` on next wake.

**Archive/delete thread:** `POST .../pause` (archive, resumable) or `DELETE /sandboxes/{id}`
(destroy). Paused snapshots persist indefinitely and are only freed by an explicit kill —
a periodic sweep (list by `metadata.threadId`, kill orphans) belongs in the admin surface.

### 4.3 Impedance mismatches to design around

1. **Long-running commands vs. Workers limits.** workerd has no hard wall-clock cap while
   a response streams, but DOs can be evicted and CPU-time budgets apply. Never hold one
   `commands.run` await across a long build: start with `background: true`, persist the
   `pid`, and re-attach with `process.Connect` (server-streamed POST) or poll — mirrors
   how Amp lets hooks "continue in the orb".
2. **Streaming stdout to the browser.** envd streams arrive as chunked HTTP frames; bridge
   them onto the existing Cap'n Web WebSocket as ordinary RPC callbacks rather than
   proxying the envd stream end-to-end, so a dropped stream is re-attachable by pid.
3. **Subrequest limits** (1000/request on paid): fine for lifecycle; batch file writes via
   the multipart `/files` endpoint rather than per-file calls.
4. **Env-var immutability across resume**: fresh secrets must go through envd file writes
   (§3.3), not `envVars`.
5. **Sandbox-ID drift + snapshot races** (§1.4): single-writer DO, persist the ID returned
   by every `/connect`, prefer explicit pause, and treat "resumed sandbox missing recent
   files" as a known failure mode — keep durable artifacts (git pushes, exported diffs)
   outside the sandbox as Amp does ("only the diff leaves the orb").
6. **Auto-resume-by-traffic** (`autoResume: true`) bypasses the DO — the sandbox wakes
   without the DO knowing, so `lastActivityAt` goes stale and the capability token is not
   rotated. Either route all portal traffic through the router (wake = a DO-mediated
   `/connect`), or accept E2B-managed wake for public preview ports only and exclude those
   sandboxes from token-bearing work.

### 4.4 Minimal first milestone

1. Template: one `base`-derived template with git + Node + pnpm (Template SDK, §1.5).
2. `ThreadDO` additions: `ensureSandbox()` (create-or-connect + token mint),
   `runCommand()` (background start + re-attach), alarm pause, `destroy()`.
3. Router route `/sandbox-proxy/*` → thread DO → gatekeeper capability (the §3.3 proxy).
4. Frontend: thread sidebar status chip driven by DO state
   (`running | paused | none`), matching Amp's running/inactive presentation.

---

## Sources

- E2B workerd support statement: https://e2b.dev/docs/troubleshooting/sdks/workers-edge-runtime
- E2B JS SDK reference: https://e2b.dev/docs/sdk-reference/js-sdk/v2.28.2/sandbox (and /sandbox-commands, /sandbox-filesystem)
- SDK source: https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/index.ts
- Persistence: https://e2b.dev/docs/sandbox/persistence · Auto-resume: https://e2b.dev/docs/sandbox/auto-resume
- API key: https://e2b.dev/docs/api-key · Billing: https://e2b.dev/docs/billing-and-limits
- REST/OpenAPI: https://e2b.dev/docs/api-reference (create-sandbox, connect-to-sandbox, resume-sandbox, list)
- Internet access / egress rules: https://e2b.dev/docs/sandbox/internet-access
- Templates: https://e2b.dev/docs/template/start-ready-command
- workerd blockers: https://github.com/e2b-dev/E2B/issues/315 · https://github.com/connectrpc/connect-es/issues/1274 (→ #550, #577) · e2b@2.33.0 rolldown pin: https://github.com/parall-hq/parel-oss/pull/53
- Amp: https://ampcode.com/manual · https://ampcode.com/manual/orbs · https://ampcode.com/what-are-orbs · https://ampcode.com/news/agents-in-orbs · https://ampcode.com/news/secrets-of-the-orb · https://ampcode.com/manual/orbs/oidc · https://ampcode.com/security
