# threads-orbs implementation progress (worktree: /Users/dallen.pyrah/projects/cloudflare-os-threads-orbs, branch feat/threads-orbs)

DONE:
- commit 1: plan docs
- commit 2: blueprint->template rename (routes, KV TEMPLATES, R2 TEMPLATE_CONTENT, .template ext,
  format-templates/, golden regenerated, deploy.mjs contract, fixed-bid archive rebuilt).
  BlueprintIcon = aliased phosphor icon (name unchanged).
- commit 3: workspace->thread rename (routes /threads + /thread/$id, THREAD_* error codes,
  SidebarThreads label "Threads", useThreadOpen, thread-session, ThreadOpenErrorPage;
  vendor 'Slack workspace' prose in data/chat.ts protected). deployment/workers-dev.jsonc keys
  templatesKvNamespace/templateContentBucket renamed (values still old names - they're live CF
  resource names, keep until deploy step decides).
- Sidebar label "Recent threads" -> "Threads". Build+lint+all tests green after each commit.

PHASE 1 COMPLETE (commits 7751536, 1e6a72f, 3a201d1). PHASE 2 IN PROGRESS: single conversation per thread.

Old phase-1c notes: gadget->artifact. CRITICAL meaning split:
- THREAD-meaning (legacy workspace==gadget): AuthenticatedApi.newGadget->newThread,
  openGadget->openThread, listGadgets->listThreads, GadgetMetadata(WithTimestamps)->ThreadMetadata,
  OPEN_GADGET_ERROR_CODES->OPEN_THREAD_*, createOpenGadgetError, dismissSharedGadget->dismissSharedThread,
  frontend GadgetList->ThreadList, useGadgets->useThreads, gadgetsOptions->threadsOptions,
  GadgetEditor->ThreadEditor, user.ts GadgetRecord->ThreadRecord (storage key `gadgets` STAYS).
- ARTIFACT-meaning (workpiece): GadgetClient->ArtifactClient, createGadget->createArtifact,
  getGadget->getArtifact, setGadgetBinding->setArtifactBinding (+agent tool `gadget` param->`artifact`),
  GadgetBindingInfo->ArtifactBindingInfo, connectToGadget->connectToArtifact, "useGadget" msg type->"useArtifact",
  TemplateGadgetSummary->TemplateArtifactSummary, AgentGadgetInfo->AgentArtifactInfo,
  frontend GadgetUI->ArtifactUI, GadgetUseView->ArtifactUseView, GadgetCodeInterface->ArtifactCodeInterface,
  overseer GadgetRecord->ArtifactRecord (storage key stays).
- CONTRACT COMPAT (verified): format-template archives embed `export class Gadget` + client global `gadget`.
  overseer.ts:2465 getDurableObjectClass("Gadget") -> try "Artifact" fallback "Gadget".
  GadgetUI.tsx INJECTED_CODE_PREFIX defines `let gadget` global -> keep, add `const artifact = gadget` alias.
  Agent prompt (agent.ts) rewritten to teach Artifact/artifact.

REMAINING PHASES: 2 (single conversation), 3 (Pierre UI, monaco removal), 3.5 (drawer),
4 (E2B orb via REST, admin-fixed size, .env E2B_API_KEY -> wrangler secret in scripts/deploy.mjs
getDeploymentSecrets backend section), 5 (thread graph). Then merge to main + deploy (pnpm deploy,
needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN env; deployment/workers-dev.jsonc contract) + verify.
Effect TS v4 (catalog: effect 4.0.0-rc.109, used by gatekeeper-microsoft/microsoft-graph) for NEW code:
orb module, thread-graph services.
GOAL a1a22e27 active. pnpm install done in worktree. Tests: `pnpm test` at root (concurrency 2).

PHASE 2 PLAN (single conversation):
- ThreadEditor.tsx + ChatInterface.tsx: remove chat-list mode; selectedChatId always 0 (or the
  thread's only chat). Drop ?chat search param from thread.$id.tsx route.
- workshop-shared api.ts: remove listChats/newChat/deleteChat from client surface, add
  getConversation() boot; keep AiChatMetadata internally.
- overseer.ts: newChat gates - thread's conversation is chat 0 created on first message.
- Home (index.tsx): unchanged flow (newThread + first message) but title auto-gen from first msg.
- Breaking: no migration of old multi-chat data.

PHASE 2 COMPLETE (commit a3bf0d0): thread IS the conversation. No chat list/scope/rename/delete UI;
?chat param gone; effectiveSelectedChatId=0 pinned in ThreadEditor; ChatInterface -811 lines.
Note: overseer.newChat still used by Home to create conversation 0 on a fresh thread (internal
bootstrap; fine). navigateToChat in ThreadEditor is now only a draft-branch-cleanup callback.

PHASE 3 NEXT: Pierre UI. Read plans/research-pierre-ui.md §5 for migration steps.
- pnpm add @pierre/diffs@1.3.5 @pierre/trees (pin exact) to workshop-frontend
- Replace CodeEditor.tsx (monaco) -> read-only Pierre File view
- Replace CodeDiffEditor.tsx + diff/diffRenderer.ts -> MultiFileDiff
- Replace FileSidebar.tsx -> @pierre/trees FileTree (no create/rename/delete)
- Remove deps: monaco-editor, @monaco-editor/react, y-monaco; delete monacoTheme.ts, getLanguage.ts
- ArtifactCodeInterface.tsx is the integration point

PHASE 3 COMPLETE (commit 093dcce): Pierre UI in, monaco out. New: FileView/FileDiffView/FileTreePanel
+ fileChangeStatus.ts. ArtifactCodeInterface rewired read-only.

PHASE 4 IN PROGRESS: E2B orb per thread.
Design (research-e2b-orbs.md §4 + plan D2/D3):
- workshop-backend/src/orb/ module in Effect TS v4 style (effect@4.0.0-rc.109 via catalog).
  New dep in workshop-backend package.json: "effect": "catalog:".
- orb/e2b-api.ts: raw REST client for api.e2b.app (X-API-Key) — createSandbox, connectSandbox
  (resume-or-touch), pauseSandbox, killSandbox, setTimeout. Effect Services + Schema for responses.
- orb/orb-manager.ts: DO-facing lifecycle: getOrCreate (lazy), wake (connect), sleep (pause),
  destroy. Stores orbState in DO storage singleton (added to overseer typed-storage singletons:
  orbSandboxId, orbStatus, orbLastActivity).
- overseer.ts hooks: wake before agent turn (runAgent), track activity, alarm-driven pause after
  idle (reuse existing alarm infra), destroy on thread delete.
- admin-config.ts: orbSettings { enabled, templateId, idleMinutes } soft setting.
- env: E2B_API_KEY secret. wrangler.jsonc vars note; scripts/deploy.mjs getDeploymentSecrets
  backend section reads process.env.E2B_API_KEY (from .env via dotenv at deploy time — check how
  deploy.mjs loads env; may need explicit dotenv or shell source).
- agent tool (phase 4b): executeShell tool in agent.ts that runs a command in the orb via envd
  (POST https://49983-{sandboxId}.e2b.app/commands ConnectRPC JSON). Records observation.
- Token proxy (D3) deferred to phase 4c/5 (needed before exposing gatekeeper capabilities
  inside sandbox; plain shell exec doesn't need it).

PHASE 4 COMPLETE (commits 05082e3, fae15ba): E2B orb per thread.
- src/orb/{e2b-api,orb-manager,envd}.ts (Effect TS style, effect@catalog dep added to backend)
- Overseer: orbState singleton, ensureOrbAwake on #registerRunningAgent (waitUntil),
  maybePauseIdleOrb in alarm(), destroyThreadOrb in thread delete, orbStatus in
  getMetadata+subscribeToMetadata (only when settings.enabled = E2B_API_KEY present)
- agent.ts: executeShell tool (hooks.executeShellInOrb, 120s/40k bounded)
- env.d.ts E2B_API_KEY; deploy.mjs loads repo .env + backend.E2B_API_KEY secret
- ThreadEditor topbar orb chip (Running/Paused/Machine w/ colored dot)
NOTE: .wrangler/validate/ dir = stale codegen; rm -rf before bare tsc, or trust pnpm build.

PHASE 5 NEXT: thread graph (spawn/send/wait/read + live sidebar).
Existing machinery to reuse: OverseerImpl.spawnAgent (~6900, creates chat in SAME DO — that is
the old model), AgentSpawnerGatekeeper DO (~9700), agent-spawner-binding.d.ts (spawn/spawnCallable),
TransientStub plumbing. Plan D4: spawnThread creates a CHILD THREAD (new Overseer DO via
this.ctx.exports/user DO newThread path server.ts:310), parentThreadId in child metadata,
ThreadHandle capability (sendMessage=newChat/sendChatMessage on child DO, waitForResponse=
agent-turn completion, getTranscript=getChatHistory), child appears in user thread index
(user.newThread registers). Agent tools: spawnThread/sendToThread/waitForThread/readThread.
Sidebar: threads list is react-query polled; live updates = invalidate on navigation (good enough
for v1) — real push channel subscribeThreads deferred.

THEN: merge to main, pnpm deploy (needs CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN env vars —
ASK USER if absent), verify deployed (thread create, orb wake/pause via E2B dashboard or status
chip, executeShell, Pierre diff render, thread spawn).

PHASE 5 COMPLETE (commit 0909dfc): thread graph.
- receiveExternalMessage generalized: callerUserId (DO id) + parentThreadId in input
- ThreadGraphLoopback entrypoint (exported from server.ts) = child->parent response target
- childThreads collection on parent (pendingResponses queue, deliveredKeys dedupe)
- Impl: spawnChildThread/sendToChildThread/waitForChildThreads/listChildThreads/
  readChildThreadTranscript; DO RPC: deliverChildThreadResponse/renderTranscriptForParent
- agent.ts: spawnThread/sendToThread/waitForThreads/listSpawnedThreads/readThread tools
  + system prompt sections "Your Machine" + "Child Threads"
- ThreadMetadata.parentThreadId; user.ts newThread/ensureThreadRegistered accept parent
- SidebarThreads/SidebarGadgetRow: nested rendering (childrenByParent map, DFS flatten)
All gates green (build EXIT:0, test EXIT:0, lint 74 warnings 0 errors).

REMAINING: merge feat/threads-orbs -> main, pnpm deploy, verify deployed system, goal complete.
