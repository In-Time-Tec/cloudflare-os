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
