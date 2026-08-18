# Threads + Orbs: Replacing Workspaces with Amp-style Threads backed by E2B Sandboxes

Status: DRAFT — planning document. Companion research reports (complete):
- `plans/research-e2b-orbs.md` — E2B REST from Workers (SDK does NOT run in workerd), orb
  lifecycle, Amp orb/thread model, secure capability exposure, DO-per-thread design sketch
- `plans/research-pierre-ui.md` — `@pierre/diffs` + `@pierre/trees` APIs, monaco removal
  migration steps with code samples
- `plans/threads-ui-options.md` — right-panel UI options (A/B/C) and recommendation

## 1. Product model change (what we're building)

Today:
- A **workspace** (one `OverseerDurableObject`) contains many **chats** (conversations), many
  gadgets/workpieces, a shared Yjs code doc, connections (gatekeepers), sharing, actions.
- Sidebar: Favorites / Conversations / **Recent workspaces**. Home page creates a new workspace.
- `GadgetEditor` shows a chat list per workspace; `?chat=N` selects a conversation.

Target (Amp semantics):
- A **thread** = one conversation = one Overseer DO. **No chat list inside a thread.** The DO's
  chat storage keeps exactly one primary conversation (chat 0). "New conversation" = new thread.
- Threads have only a **title** (no workspace name + thread name pair). Title auto-generated from
  the first message, renameable.
- Sidebar: "Threads" section (replaces Recent workspaces), showing status per thread:
  agent running / awaiting input / idle / orb paused. Newly spawned child threads appear live.
- **Every thread is backed by an Orb**: an E2B sandbox owned by the thread's DO. Created lazily on
  first agent turn, auto-paused after idle timeout, resumed when the thread wakes (user message,
  child-thread reply, hook delivery).
- **Thread → thread spawning** (Amp custom-agents semantics): an agent can spawn a child thread
  (`parentThreadID` recorded), optionally wait on it (`waitForResponse`), send messages to it
  (`appendUserMessage`-equivalent), and inspect it (read its transcript). Child threads pop into
  the sidebar in real time.
- Knowledge-work orientation: the primary surface is the conversation + artifacts (files the agent
  produced, rendered read-only), not a code editor. Users cannot edit files; only agents can.
  Monaco is removed; Pierre diff + file-tree components render changes and files.
- Sharing: share a **thread** (same capability mechanics as today's workspace sharing — share
  links, collaborator roles — re-labeled; `shareKey` redemption unchanged).

Mapping table:

| Today | Target |
| --- | --- |
| Workspace (Overseer DO) | Thread (same DO, renamed surface) |
| Chat (many per workspace) | exactly one per thread (chat 0) |
| Agent-spawned chat (AgentSpawnerGatekeeper) | child **thread** (new DO) w/ parent link |
| `?chat=N` search param | gone (thread id in path is enough) |
| Recent workspaces sidebar | Threads sidebar w/ live status |
| Workspace title + per-chat titles | one thread title |
| Monaco CodeEditor/CodeDiffEditor/FileSidebar | Pierre diffs + file tree, read-only |
| (none) | Orb: E2B sandbox per thread, pause/resume |
| Blueprint (`.gadget` archive, /blueprints) | Template (`.template` archive, /templates) |
| Gadget (interactive workpiece) | Artifact |

## 2. Architecture decisions

**D1. Thread = Overseer DO (keep the DO, change the surface).** The Overseer DO already owns chat
history, bindings, sharing, hooks, agent turns, and durable restoration — exactly what a thread
needs. We do NOT introduce a new DO class. We constrain the chat dimension to a single primary
conversation and stop exposing multi-chat surface in the API/UI. Existing internal chat plumbing
(chatId keying of drafts, transient stubs, seed binding layers) is untouched — chatId stays an
internal detail (spawned in-thread subagent turns may still allocate internal chat ids; see D4).

**D2. Orb = E2B sandbox owned by the thread DO.** New backend module `orb.ts` in workshop-backend:
- DO storage singleton `orbState: { sandboxId?: string, template: string, status:
  "none"|"running"|"paused", lastActivity: number }`.
- **Raw REST API, not the SDK** (verified in research-e2b-orbs.md §1): the E2B JS SDK does not run
  in workerd (@connectrpc/connect-web transport incompatibility; e2b@2.33.0 crashes on
  createRequire). Six REST endpoints on api.e2b.app (X-API-Key) cover the lifecycle:
  `POST /sandboxes` (templateID, timeout, autoPause, envVars, metadata),
  `POST /sandboxes/{id}/connect` (resume-or-touch: 200 running / 201 resumed), `/pause`,
  `/timeout`, `DELETE` (kill), list. Data-plane (envd, port 49983) is plain HTTP POST +
  multipart /files — fetch-able from workerd when the DO needs to read/write sandbox files.
- **Persist the sandboxId returned by every /connect** (community reports of IDs changing across
  auto-resume) and prefer explicit DO-driven pause over relying on auto-pause snapshots (known
  write-back race can lose recent files).
- **Wake**: any user message, child-thread message, or hook delivery resumes a paused sandbox
  (`Sandbox.resume(sandboxId)`) before the agent turn starts.
- **Sleep**: DO alarm (already used for agent restoration) also tracks orb idleness; after N min
  (default 5, matching Amp) with no agent turn and no connected clients, the DO revokes the orb
  token then calls `/pause`. E2B's server-side auto-pause (`autoPause` on create) is the backstop
  if our alarm never fires — but note autoResume can bypass the DO, so the sandbox shim should
  treat a resumed-without-token state as "call home first" (fetch a fresh token via the connect
  handshake).
- Amp-parity hooks (later): `.agents/setup`-style template prep snapshot and a bounded
  resume hook; E2B templates are pre-booted snapshots so a custom template with our shim +
  common knowledge-work tools preinstalled is the fast-boot path.
- Orb identity/keys: `E2B_API_KEY` is a deployment secret on workshop-backend (wrangler secret +
  release manifest `$SECRET(...)` input). Never exposed to gadget/agent code.

**D3. Secure capability exposure into the orb — the proxy pattern, not token injection.**
Long-lived OAuth tokens (Microsoft, Google, ...) stay in gatekeeper workers. The sandbox gets a
single short-lived, thread-scoped bearer token minted by the thread DO at sandbox create/resume:
- New router route `/orb-api/*` → workshop-backend → thread DO, authenticated by that token
  (HMAC over threadId + expiry, verified in the DO; rotated on every resume).
- Inside the sandbox, a small shim (env var `THREAD_API_URL` + `THREAD_API_TOKEN`) exposes the
  same capability surface agents already have (`env.<binding>` calls), proxied over HTTP to the
  DO, which invokes the real gatekeeper capability. Every call still flows through
  `getGatekeeperClassFor()` policy enforcement and the observation/approval queue — the orb adds
  no new authority, it's a new transport to existing capabilities. This mirrors Amp's
  workload-identity design (orb asks control plane; control plane holds credentials — Amp's
  `amp orb id-token` is a ~10-min RS256 JWT with workspace/project/user/thread claims).
- **Token hygiene around snapshots** (research §3): E2B envVars persist across pause/resume, so
  the capability token must NOT live in envVars. Rotate it on every resume by writing a token
  file into the sandbox via envd, and revoke the old token *before* pausing — snapshots then
  never contain a live credential. E2B `metadata` never enters the sandbox (safe for our
  threadId bookkeeping).
- Sharing consequence: a shared thread's collaborators exercise the same capability chokepoints
  as today; the orb token is per-DO, not per-user, and the DO applies the same collaborator-role
  checks before proxying.

**D4. Thread spawning replaces (and subsumes) agent-spawned chats.** Amp semantics:
- New `Overseer` methods (workshop-shared): `spawnThread(title, prompt, opts) → threadId`,
  plus a `ThreadHandle` capability for the spawner: `sendMessage()`, `waitForResponse()`,
  `getTranscript(page)`, `getStatus()`. Implemented DO-to-DO (Overseer → user DO `newGadget` →
  child Overseer), parent thread id recorded in child metadata (`parentThreadId`).
- The agent-facing `AgentSpawnerBinding` (`spawn`/`spawnCallable`) is re-implemented on top of
  spawnThread: `spawn` = fire-and-forget child thread; `spawnCallable` = child thread + callable
  stub (existing TransientStub machinery keeps working — the callable stub now targets the child
  DO's chat 0 instead of a sibling chat).
- Child threads push into the **user's thread index** (user DO) on creation. NOTE (verified):
  today the sidebar list is a *polled* react-query over `AuthenticatedApi.listGadgets()` with
  manual invalidations (query/gadgets.ts) — there is no index subscription. Live sidebar updates
  need a new `subscribeThreads(subscriber)` on AuthenticatedApi (user DO pushes add/update
  events; same pattern as `subscribeConnectedAccounts`), which also carries per-thread status
  changes (agent running / awaiting input / orb paused) for the status dots.
- Waiting: `waitForResponse()` uses the existing agent-turn completion signal (the same place
  `chatMeta.activeAgent` is cleared) to resolve cross-DO waiters; resumption of a waiting parent
  reuses the durable agent-restoration path (constructor restore + alarm), so a parent thread
  whose DO was evicted still wakes when the child finishes.

**D5. Files live in the orb; Yjs remains the transcript-of-record for artifacts (transitional).**
Full migration of file state from the Yjs doc into the sandbox filesystem is a later phase. In
phase 1 the agent's file tools keep writing the Yjs doc (unchanged diff/changes machinery), and
the orb is where `executeCode`-style shell/compute happens, with a sync step (DO pushes files
into the sandbox on create/resume; pulls declared outputs back). Pierre components render from
the same data the current editor reads — so UI replacement (monaco → Pierre) is independent of
the storage migration.

**D6. Renaming is a surface rename; storage keys renamed only where free.** DO storage keys,
collection names (`gadgets`, `gatekeepers`, `chatMeta`), and DO namespaces stay as-is purely to
keep the diff small — not for compat (breaking is allowed; see §5). We rename: routes, UI copy,
workshop-shared API names (with doc comments), frontend identifiers, error codes, and archive
formats. `TODO(multi-gadget): rename WorkspaceMetadata` becomes `ThreadMetadata` in the same
pass. Blueprint→Template and Gadget→Artifact renames ride this phase too (see §5).

## 3. Change inventory (files that must change)

### workshop-shared (kernel API — small, reviewed line-by-line; separate commit)
- `api.ts`:
  - Rename user-facing types/methods: `openGadget`→`openThread`, `newGadget`→`newThread`,
    `GadgetMetadata(WithTimestamps)`→`ThreadMetadata(...)`, `WORKSPACE_NOT_FOUND` etc. error
    codes → thread wording (breaking rename — no wire-compat mapping needed, see §5).
  - Blueprint→Template + Gadget→Artifact type/method renames (see §5 for scope).
  - Single-conversation surface: `listChats`/`newChat`/`deleteChat` deleted; new
    `getConversation()` boot shape. `AiChatMetadata` stays as the internal record shape.
  - New: `spawnThread`, `ThreadHandle` capability, `parentThreadId` + `orbStatus` on
    `ThreadMetadata`, thread-status subscription for the sidebar.
  - Every exported member doc-commented (project rule).
- `gatekeeper.ts`: no structural change expected (conversations API is human-to-human, separate).

### workshop-backend (kernel; separate commits per concern)
- `overseer.ts` (9.7k lines — touch minimally):
  - Single-conversation enforcement + `spawnThread`/`ThreadHandle` impl (builds on existing
    `spawnAgent` at ~6871, `AgentSpawnerGatekeeper` at ~9675).
  - New `orb.ts` module + orb lifecycle hooks in the turn loop (wake before turn; idle alarm).
  - Orb proxy endpoint handler (token verify → capability dispatch → observation records).
- `user.ts`: thread index (`listGadgets` ~784 → `listThreads`), live index updates on child spawn,
  `newGadget`/`newThread` (~816), new `subscribeThreads` push channel (the DO already receives
  `setGadgetLastActive`/`updateTitle` writes from overseers — fan those out to subscribers, plus
  new thread-status writes from the orb/turn lifecycle).
- `agent.ts`: system prompt rewrite ("You are working within a thread… backed by a machine (orb)"),
  new tools: `spawnThread`, `sendToThread`, `waitForThread`, `readThread`; orb shell tool.
- `server.ts` + `router`: `/orb-api/*` route; `E2B_API_KEY` secret; release manifest input
  (`deploy-inputs.json` / `NO_DEFAULT_CRED_INPUTS` review).
- `admin-config.ts`: orb settings (orbTemplateId, idle minutes, size tier) as
  admin-configurable soft settings — deployment-wide, no per-thread picker (decision §5).
- Blueprint→Template rename: `blueprint-archive.ts`, `format-blueprints.ts`,
  `format-blueprints/` dir + sidecars, `scripts/build-format-blueprints.mjs`,
  `import:format-blueprint` script, generated module name, `.gadget`→`.template` extension.

### workshop-frontend (bulk of the diff; can land in stages behind the API)
- Routes: `workspace.$id.tsx`→`thread.$id.tsx` (drop `chat` search param; `w`→`a` for
  artifact), `workspaces.tsx`→`threads.tsx`, `blueprints.tsx`→`templates.tsx`,
  `blueprint.$id.tsx`→`template.$id.tsx`. No legacy redirects needed (no users) —
  `legacyRedirects.test.tsx` machinery can be deleted. `routeTree.gen.ts` regenerates.
- Sidebar: `SidebarWorkspaces.tsx`→`SidebarThreads.tsx`; "Recent workspaces"→"Threads" with
  per-thread status dot (running/awaiting/paused — data from the new thread-status subscription);
  child threads appear live (index push). `Sidebar.tsx` nav item Workspaces→Threads.
- `GadgetEditor.tsx` (107 refs): remove chat-list mode, single conversation, thread title only.
  `ChatInterface.tsx` (8k lines): chat-list scope/UI removed; conversation is the thread.
- **Monaco removal** (verified plan in research-pierre-ui.md §5): delete `CodeEditor.tsx`,
  `CodeDiffEditor.tsx`, `CodeDiffEditor.css`, `components/monacoTheme.ts`,
  `y-monaco`/`monaco-editor`/`@monaco-editor/react` deps, `getLanguage.ts` (Shiki infers
  language). Replacements: `@pierre/diffs@1.3.5` (Apache-2.0, React 19-compatible,
  Shiki-highlighted, Shadow DOM, virtualized) — `File` for read-only file view,
  `MultiFileDiff`/`FileDiff` for proposed-changes review (unified/split via
  `options.diffStyle`); `@pierre/trees@1.0.0-beta.6` `<FileTree>` replaces `FileSidebar.tsx`
  (its git-status badges map 1:1 onto our `FileChangeStatus`; pin exact version — beta).
  Create/rename/delete file affordances deleted — agent-only edits. Yjs stays as the data
  source: feed `ytext.toString()` snapshots into Pierre components.
- `diff/diffModel.ts` stays (data), `diff/diffRenderer.ts` (~1400 lines with CodeDiffEditor)
  replaced by Pierre rendering.
- Known losses/risks (accepted): no find-in-file initially, `@pierre/trees` is beta,
  Shadow DOM changes E2E selectors.
- Rename sweeps: `useWorkspaceOpen`, `query/workspace-session.ts`, `WorkspaceOpenErrorPage`,
  `GadgetList`, `RecentApps`, `CommandPalette` ("Search threads"), `ShareModal` copy
  ("Share thread"), `outputs.tsx` (workspaceId/workspaceTitle fields), `homePrompt` flow.
- New: Orb status strip in thread view (running/paused, wake button, cost later).

### Tests / infra
- All `*.test.ts(x)` files touching renamed identifiers (~15 files);
  golden release-manifest test after the new secret/binding (`UPDATE_GOLDEN=1`).
- `pnpm build` + `pnpm lint` + `pnpm test` gates per phase.

## 4. Phasing (each phase shippable)

1. **Rename phase** (mechanical, no behavior): workspace→thread, blueprint→template,
   gadget→artifact across shared/backend/frontend; routes, sidebar labels, agent prompt copy.
   Breaking renames allowed (no users). Kernel diff kept small and separate.
2. **Thread-is-the-conversation phase**: there is NO "conversation" concept nested inside a
   thread at all — the thread IS the conversation. Delete the chat-list surface, the `?chat`
   param, the scope switcher, the back-to-conversations affordance, and any "new conversation"
   affordance (a new conversation is a new thread, started from Home). A fresh thread renders
   as an empty thread (composer ready), not a "new chat" view. Internally chatId 0 remains a
   storage detail of the Overseer DO (draft branches key off it); it never reaches the UI or
   user-facing API vocabulary. No migration for old multi-chat data — drop it.
3. **Pierre UI phase**: monaco out, Pierre diffs + file tree in, read-only files.
4. **Orb phase**: E2B integration (create/pause/resume, alarm, status in sidebar), orb proxy +
   short-lived token, agent shell tool in orb.
5. **Thread-graph phase**: spawnThread/ThreadHandle, agent tools (spawn/send/wait/read),
   live sidebar updates, parent/child navigation (Amp-style "switch to parent").

## 5. Decisions (resolved with product owner)
- **Breaking changes are fine — no one uses this yet.** No back-compat shims anywhere:
  no legacy redirects beyond trivial route aliases, no read-only history mode for old
  multi-chat workspaces, no wire-compat error-code mapping, no lazy migrations. Old data may
  be dropped. This simplifies phase 2 (single conversation) to: new model only, delete the
  multi-chat surface outright, and D6's "keep legacy string values" caveat is void — rename
  error codes and storage-facing names freely where cheap to do so.
- **Orb size is admin-fixed** (AdminConfig soft setting: template + size + idle minutes).
  No per-thread size picker. `provisioning-policy.ts`-style resolution not needed — one
  deployment-wide value.
- **Blueprints → Templates** (full rename, breaking): `BlueprintMetadata`→`TemplateMetadata`,
  `/blueprints` route→`/templates`, `blueprint.$id.tsx`→`template.$id.tsx`, `.gadget` archive
  extension→`.template`, `format-blueprints/`→`format-templates/` +
  `build-format-blueprints.mjs` + `pnpm import:format-blueprint` scripts, `blueprintId` keys
  (breaking is acceptable per above — the AGENTS.md "never rename a blueprintId" rule is
  about live deployments, which don't exist). Release-manifest golden regenerates.
  Naming care: E2B "template" (VM snapshot) enters the codebase in phase 4 — always qualify
  it as `orbTemplateId` in code so product Templates and orb templates never share a bare name.
- **Gadgets → Artifacts** (rename): verified zero `artifact` collisions in the repo. Rationale:
  users "ask for a thing: a doc, a deck, a tracker, a tool" (agent.ts prompt) — Artifact is the
  industry-standard name for exactly this (interactive agent-produced object), fits the
  knowledge-work framing, and reads correctly in the sidebar/outputs surfaces. Rejected: "app"
  (collides with gatekeeper apps + the existing `'app'` tab mode), "widget" (implies UI-only;
  these have server logic), "document"/"tool" (overloaded). Scope: `GadgetMetadata`→
  (already `ThreadMetadata` per D6), `GadgetClient`→`ArtifactClient`, `newGadget`/`openGadget`→
  thread names per D6, agent tools' `gadget` param→`artifact`, `GadgetEditor`/`GadgetList`/
  `GadgetUI`/`GadgetUseView`/`GadgetCodeInterface` components, the exported DO class name
  `Gadget` in user server.js (agent prompt rewrite in agent.ts), `AGENTS.md` + README copy.
  The `Overseer` DO class name itself can stay (internal).

## 5b. Remaining open questions
- Q3 (revised): when file state moves fully into the orb (post-phase-5), Template becomes
  "orb template + seed files"; the Yjs-snapshot format can be dropped entirely at that point.
- `?w=` param: artifacts remain first-class in-thread outputs; param survives as `?a=`.

## 6. Appendix: Amp thread-graph semantics (reference, verified from ampcode.com)

Primitives Amp exposes (Plugin API / product behavior) that we are mirroring:
- `agent.createThread({ parentThreadID, show })` — spawn a thread, optionally focus the UI on it.
- `amp.threads.get(threadID)` — obtain a handle to an existing thread.
- `thread.appendUserMessage({...})` — enqueue a message; returns on acceptance, not completion.
- `thread.waitForResponse()` — resolves with the next assistant message after the turn ends.
- Async-response pattern: child is told "when done, call send_to_thread with threadID <parent>" —
  i.e. parent notification is itself a message into the parent thread, which *wakes the parent*.
- Thread mentions (`@@thread`) and handoff: threads are first-class context stores; a thread can
  read other threads' transcripts ("Amp will read the threads and extract context pertinent to
  your task").
- Navigation: "switch to parent", thread map (tree view of parent/child threads).
- Orb relationship: "When you create a new thread you get a fresh orb that contains your code,
  plugins, and tools" (Agents in Orbs); orbs auto-pause ~5 min idle, wake on thread activity.
- Thread visibility levels: private / workspace / group — maps to our existing sharing roles.

Our equivalents (D4): `spawnThread` (Overseer→user DO→child Overseer), `ThreadHandle.sendMessage`
= appendUserMessage, `ThreadHandle.waitForResponse` = turn-completion signal, child→parent
notification = plain `sendMessage` to parent's conversation (wakes parent's orb + resumes its
agent turn via the durable restoration path), `readThread` tool = paged transcript fetch
(existing `getChatHistoryPage` machinery against the child DO).

## 7. Artifact content model: docs/sheets/slides, and complex artifacts (react apps)

### 7a. Docs / sheets / slides (knowledge-work formats)

These already exist and carry over cleanly. Verified current mechanics:
- `format-blueprints/` ships `workspace-docs`, `workspace-sheets`, `workspace-slides` — each is a
  blueprint (→ **format Template**) whose gadget (→ **Artifact**) renders a rich editor UI in the
  sandboxed iframe. The sidecar's `output` block (`{id: "document", noun: "Doc", icon}`) drives
  presentation (tab noun, Outputs grouping).
- Crucial distinction: for these formats the *user's content* (the doc text, sheet cells, deck
  slides) does NOT live in the artifact's files (client.js/server.js). It lives in the artifact
  DO's own storage (KV/SQLite), edited through the iframe UI by humans and via the `gadget` RPC
  stub / restore methods by agents. The JS files are the *implementation*, which knowledge
  workers never see.

Consequences for the thread UI (threads-ui-options.md, Option B):
- The right pane artifact iframe IS the doc/sheet/deck — users read and (for content, not code)
  edit it there. "Users can't edit files" (monaco removal) refers to implementation files only;
  content editing through the artifact's own UI stays. This is the correct knowledge-work
  boundary: content is the user's, implementation is the agent's.
- The Changes drawer therefore has two kinds of evidence, and must label them distinctly:
  1. **Implementation changes** (Pierre diffs of client.js/server.js) — shown when the agent
     builds/modifies the artifact itself. Rare after creation from a Template.
  2. **Content changes** (agent edited the doc/sheet via RPC) — NOT meaningfully expressible as
     a JS diff. Today these surface as tool-call observations in the transcript. Phase 3 keeps
     that (transcript entries like "Edited Q3 Tracker: updated 34 rows"); a per-format content
     history/diff (e.g. doc revision compare) is a format-Template feature, later.
- Publish/Export on the pane header binds to the existing export machinery (`renderGadgetPdf`
  browser export → PDF; format-specific exports like XLSX are Template features).

### 7b. Complex artifacts: react apps, multi-file projects, build steps

Today's constraint (agent.ts prompt): an artifact is client.js + server.js, no index.html, no
npm, no build step — client.js is loaded raw into the sandboxed iframe and must build UI via
DOM/JS. That ceiling is exactly what the orb removes. Trajectory, in three stages that match the
master plan's phases:

**Stage 1 (phases 1–3, no orb): status quo.** Artifacts stay client.js/server.js. Fine for
docs/sheets/trackers — the format Templates already prove this model covers most knowledge work.

**Stage 2 (phase 4+, orb as build environment): "built artifacts".** The agent scaffolds a real
project (Vite + React + Tailwind, or anything) in the orb filesystem, `npm install`s, runs
builds and tests there. Two delivery paths out of the orb:
- **Static build → existing runtime**: `vite build` produces a bundle; the DO pulls
  `dist/` back and serves it through the existing UiBundle path as the artifact's client code
  (the iframe already loads arbitrary JS; a built React bundle is just bigger client.js).
  Server logic still compiles to a DO-compatible server.js (workerd-targeted build). The
  artifact remains fully persistent/shareable with the orb *paused or deleted* — the built
  output is the artifact; the orb is the workshop.
- **Source of truth**: project source lives in the orb (and is what Pierre file tree/diffs show
  in the drawer); the Yjs doc holds only the built outputs + manifest in stage 2 (transitional
  per D5), then retires when file state moves fully orb-side.

**Stage 3 (post-phase-5, orb as runtime): "live artifacts" (Amp Portals).** For artifacts that
need a real server (long-running processes, websockets, arbitrary runtimes — a Next.js app, a
Python notebook server), run them *in* the orb and expose the port via E2B's host URL
(`{port}-{id}.e2b.app`), proxied through the router with our auth (the Portal pattern,
research-e2b-orbs.md §2). The right pane gains the "Portal" tab (already sketched in
threads-ui-options.md). Trade-off to keep explicit: a live artifact sleeps when its orb pauses —
so Portals suit previews and internal tools, while anything meant to outlive the thread should
ship as a built artifact (stage 2) or be promoted to a Template.

Naming/product implication: Templates then span the whole range — from "Doc" (format Template,
content-first) to "React dashboard starter" (project Template: orb seed files + build recipe) —
which is exactly the Q3-revised definition in §5b (Template = orb template + seed files).
