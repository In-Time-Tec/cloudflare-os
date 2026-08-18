# Plan: delete the approval model; consent lives in the profile, audit lives in the log

**Branch:** `plan/no-approvals` (worktree `../cloudflare-os-no-approvals`, off `origin/main` @ `f8a4f68`)

## Thesis

Cloudflare OS already has the security primitive most coding agents lack: **a gatekeeper capability
is the authority**. It is minted by explicit user and admin configuration, at
`user.ts:1735-1760` (`getGatekeeperClassFor`), on a path no gadget or agent code can reach. An agent
reaches nothing else.

The per-action approval queue is a second, weaker gate stacked on top of that boundary. It is the
one that scales badly, and it is the one to delete.

The resulting model has exactly three moving parts:

1. **Admin decides what may exist** on the deployment.
2. **User decides what to grant**, once, in their profile. If they haven't granted it,
   **the agent does not know it exists.**
3. **The agent acts.** Every action is recorded with its outcome. Nothing is ever pending.

There is no approval, no decision queue, no "always approve", no accept/deny card, no approval
history — because there are no approvals to have a history of. The action log is an **activity log**:
what happened, under which grant, with what result.

## Why (evidence)

### What Amp concluded

Amp flipped its default in *Amp, Rebuilt* (ampcode.com/news/neo, 6 May 2026):
*"Amp will no longer ask for permission before running tools. What was once the
`--dangerously-allow-all` flag is now the default behavior."* The argument is **not** UX, it is
static analysis: *"It's near-impossible to determine statically whether a tool invocation will be
destructive or not… checking whether a tool call contains `rm -rf` gives you a false sense of
security."*

And on gates an agent can route around — Amp refuses to ship `.ampignore` because restrictions
*"can be trivially circumvented with the Bash tool, and thus give only a false sense of security."*
Confirmed against Amp itself: Rehberger's Aug 2025 finding (embracethered.com) was an agent editing
its own allowlist to add `*`.

**We are better positioned than Amp was.** Amp removed prompts and *then* had to build isolation
(orbs), because its agent runs shell commands on your laptop with your ambient authority. Our agent
has no ambient authority at all. The prompts here were never the boundary.

What Amp still gates after the change is instructive: installing a workspace MCP server, running a
workspace plugin the first time, an admin viewing a private thread. **Connection-time and
identity-crossing decisions — never per-action ones.** That is precisely the shape this plan lands.

### What the approval queue actually buys today

Surveying every gatekeeper (`packages/gatekeeper-*/src/*.ts`):

- Only **three** codebases ever set `autoApprovable: true` — Microsoft (all actions), Google Docs
  (edits only), MCP (annotation-derived).
- Only **3.5** declare `actionKind` at all. Confluence declares kinds but returns `[]` from
  `getAutoApprovableActions()` and never sets `autoApprovable` — its kinds are display labels that
  can never auto-apply.
- **Nine** gatekeepers submit actions with no kind and no auto-approvability: GitHub, Linear,
  Spotify, Home Assistant, Supabase, ZoomInfo, Notion, and more. Every action they take is an
  unconditional manual prompt, forever.
- **Six** gatekeepers submit no actions at all yet still implement
  `applyAction`/`rejectAction`/`revertAction`/`getAutoApprovableActions` as pure boilerplate.

The auto-approval feature — `AutoApproveTagRecord`, the drainer, the ordering invariant, the
"Always approve" dialog, the Connections rule panel — serves a small minority of actions. For the
majority, the product's answer is "prompt every time, forever."

### Dead and near-dead machinery

- `revertAction` (`gatekeeper.ts:1005-1026`) is implemented by every gatekeeper and **called by
  nothing**. `ActionDescription.implementsRevert` is populated everywhere, read nowhere.
- `Gatekeeper.rejectAction`'s `{restart?: boolean}` return is discarded at `overseer.ts:7903`.
- `Overseer.listActions()` has no frontend caller.
- `components/chat/PermissionToast.tsx` (169 lines) has zero importers.
- **The approval UI has zero test coverage.** No frontend test asserts on Approve, Deny,
  Always-approve, or the blocked composer.

### Load-bearing pieces that must survive

- `prohibitAllSharing` lockdown, currently enforced *inside* `submitAction`
  (`overseer.ts:2960-2964`) — a security control sitting in a function on the deletion path.
- `excludeObservers` enforcement in `authorizeObservation` (`overseer.ts:2762-2764`).
- The admin disable chokepoint at `user.ts:1735-1760`.
- The prompt-injection hardening in `mcp-shared/src/tools.ts:157-259`.
- The entire observation path. Observations are already `state: "approved"` and never touch
  approve/reject.

## Where the risk moves, and what pays for it

Removing the queue concentrates all authorization at grant time. Today grant time is **illegible**:

- Connecting Microsoft grants mail-send + calendar-write + file-delete + Teams-post in one
  undifferentiated act. Nothing in `ConnectConnectorModal` says so.
- `ConnectedAccountRecord` (`user.ts:23-34`) holds an opaque stub. There is **no Workshop-side
  enumeration of what an account may do** — `gatekeeper.ts:844` marks it TODO.
- The only operation-class granularity that exists today is `ActionDescription.actionKind` +
  `autoApprovable` — i.e. *inside the machinery being deleted*.
- Admin enforcement is soft: `api.ts:973` and `:980` both say it *"doesn't revoke a capability a
  gadget already holds."*
- Per-resource grants can be added (`ensureAccountResources`) but the toggle is disabled once
  granted (`ConnectConnectorModal.tsx:266`) — **there is no per-resource ungrant**.

**So `ActionKind` is promoted, not deleted** — from an auto-approval rule key to the grant-time
capability vocabulary. That is the central design move of this plan, and it is what makes
profile-level consent mean something.

## The target model

### Layer 1 — Admin defines what may exist

Today: `AdminConfig.disabledGatekeepers` / `disabledResources` / `ambientGatekeeperModes`,
enforced at `user.ts:1735-1760`. Keep, plus one addition:

```ts
/** Action kinds an administrator has disabled deployment-wide: vendorId -> actionKind tags. */
disabledActionKinds: Record<string, string[]>;
```

This is the "it did something we don't like — make the correct change" lever. Checked server-side
at record time; the gatekeeper call is refused. No prompt, no per-user setting, a deployment
decision. Reuses the `disabledResources` shape and the same admin panel idiom.

### Layer 2 — User grants in their profile, once

**This is the only consent moment in the product.** It happens on the Connectors page
(`routes/_authenticated/gatekeepers.tsx` + `components/ConnectConnectorModal.tsx`) — never in chat.

Replace `getAutoApprovableActions(): Promise<ActionKind[]>` with a full catalog:

```ts
/**
 * The complete set of side-effecting operations this gatekeeper may perform on the granted
 * resource. Shown to the user at connect time as the scope of their consent, and to an
 * administrator as the set of kinds they may disable deployment-wide. This is a contract: a
 * gatekeeper must not submit an action whose kind is not in this catalog.
 */
getActionCatalog(): Promise<ActionCapability[]>;

export type ActionCapability = {
  kind: ActionKind;
  /** One line, user-facing: "Send mail as you", "Delete files in the granted folder". */
  summary: string;
  /** Structured risk, replacing the policy-hints TODO at gatekeeper.ts:1358-1376. */
  risk: {
    reversible: "automatic" | "manual" | "no";
    reach: "creates-content" | "modifies-content" | "acts-on-world";
    audience: "private" | "shared" | "external";
    freeform: boolean;
  };
};
```

The `risk` block is the policy-hints TODO, finally landed — in the place it is actually useful
(grant-time disclosure and admin policy) rather than as a per-action prompt input.

**Every gatekeeper must declare a kind for every action it submits.** Nine declare none today; this
is the bulk of the per-gatekeeper work, and it is what makes consent meaningful.

Also landing here: **per-resource ungrant.** A user who granted "Calendar" must be able to withdraw
it without disconnecting the whole account.

### Layer 3 — Ungranted means invisible

**Your requirement, stated precisely: if the user has not granted it, the agent does not know it
exists.** Today the opposite is true — `agent.ts:2262-2278` injects a
`Connectable vendors:` section listing **every** vendor on the deployment into the system prompt,
and instructs the agent to go ask for them.

Everything in that path is deleted:

| Symbol | Location | Action |
|---|---|---|
| `Connectable vendors:` prompt section | `agent.ts:2261-2278` | **delete** |
| `requestConnection` tool | `agent.ts:2841-2895`, prompt `:707` | **delete** |
| `listConnectableResources` tool | `agent.ts:2821-2839`, prompt `:703` | **delete** |
| `listConnectableVendors` hook | `agent.ts:388`, `overseer.ts:5647-5657` | **delete** |
| `listConnectableResources` hook | `agent.ts:394`, `overseer.ts:5659-5677` | **delete** |
| `requestConnection` hook | `agent.ts:404`, `overseer.ts:5684+` | **delete** |
| `consumeCapturedConnectionRequests` | `agent.ts:415`, `overseer.ts:5741-5745` | **delete** |
| `#capturedConnectionRequests` | `overseer.ts:2707-2710` | **delete** |
| `connectionRequested` turn-stop flag | `agent.ts:2099`, `:3142` | **delete** |
| `connectionRequest` chat message type | `api.ts:2416-2418` | **delete** |
| `acceptConnectionRequest` / `denyConnectionRequest` | `api.ts:1829-1842`, `overseer.ts:8041-8074` | **delete** |
| `#findConnectionRequest` | `overseer.ts:7985-7996` | **delete** |
| `connectionRequest` history/compaction cases | `overseer.ts:4553`, `:4765`, `:4831`, `:8274`; `agent-compaction.ts` | **delete** |
| Connection-request card | `ChatInterface.tsx:6311-6378` | **delete** |
| Accept/deny handlers + modal | `ChatInterface.tsx:5975-6032`, `:7977-7987`, `:4567-4580` | **delete** |
| `hasPendingConnectionRequest` composer block | `ChatInterface.tsx:4834-4841` | **delete** |

Roughly 32 references in `overseer.ts`, 32 in `agent.ts`, 19 in `ChatInterface.tsx`, 11 in `api.ts`.

The agent's system prompt lists **only the bindings it actually holds**. It cannot enumerate,
request, or reason about what it lacks. A capability it was not granted is not a locked door — it
is not a door.

### Layer 4 — The agent acts; everything is recorded

Actions become one-phase. The two-phase submit/apply exists *only* because a human might intervene
between the phases.

```ts
// packages/workshop-shared/src/gatekeeper.ts — replaces ApprovalQueue.submitAction
interface ActionRecorder {
  /**
   * Record that the gatekeeper is about to perform a side-effecting action, and obtain
   * authorization. Throws if deployment policy forbids the kind, or if the workspace is in
   * sharing lockdown. The gatekeeper performs the action only if this returns, then reports
   * the outcome via the returned handle.
   */
  authorizeAction(description: ActionDescription): Promise<ActionHandle>;
}

interface ActionHandle extends RpcTarget {
  succeeded(result?: ActionResult): void;
  failed(error: string, mayHaveTakenEffect: boolean): void;
}
```

This mirrors `authorizeObservation` — a synchronous gate before the effect — the existing,
well-understood shape in this contract. The handle exists because an action has an outcome worth
recording. (Audit gap today: `applyPendingAction` awaits `gatekeeper.applyAction()` and records
**nothing** about what came back; a failed apply leaves a record stuck at `pending` forever with no
error field.)

Consequences:

- `ActionState` becomes `"succeeded" | "failed" | "blocked"`. `"pending"` and `"rejected"` are
  unreachable and deleted.
- `awaitDecision`, turn suspension (`agent.ts:2101-2103`, `:3131-3146`),
  `#maybeResumeAfterActionDecision` (`overseer.ts:7842-7881`), `#resumeSuspendedAgent`
  (`overseer.ts:8001-8039`), and the synthetic "your changes were approved" resume message all
  delete. With connection requests also gone, **the entire turn-suspension mechanism disappears** —
  both of its callers are removed.
- The ordering invariant and `AutoApprovalDrainer` delete. Ordering becomes natural: actions happen
  inline, in the order the agent takes them, under `toolExecution: "sequential"`.
- **Action simulation deletes.** Notion, Confluence, and Google Docs maintain read-time overlays
  (base truth + pending actions replayed in order) purely so a Gadget can work against state a
  pending action has not been applied to. With no pending state, the real state *is* the state.
  Large, high-value simplification — staged separately (Phase 5).
- MCP's `ActionStore` two-phase machine collapses: the `applying` claim, crash-recovery
  force-fail, and `retryable` logic guard a *deferred, separately-retried* apply. The
  "outcome unknown after a network failure" problem remains, now carried by
  `failed(error, mayHaveTakenEffect)`.
- **The MCP `vetted` trust tier is deleted** (your call, and correct). `readOnlyHint` keeps its
  meaning (read → observation, write → action). `ServerTrust`, `portalTrust()`,
  `MCP_PORTAL_TRUST_ANNOTATIONS`, `ClassifiedTool.autoApprovable`, and the
  `destructiveHint`/`idempotentHint` reads exist *only* to gate auto-apply and go with it. An admin
  who trusts a portal expresses it by enabling the vendor and constraining it with
  `disabledActionKinds`. A second trust axis that no longer gates anything is exactly the
  false-confidence gate Amp warns against.

**Backpressure.** `MAX_PENDING_ACTIONS = 50` (`mcp-shared/src/action-store.ts:11`) was the only
limit on how many external writes an agent could accumulate. Replace with a per-turn action budget
in the Overseer; exceeded → `blocked` record + a tool error the agent can read. Do not skip this —
it is the one genuine capability the queue provided that nothing else covers.

## The activity log (what replaces approval history)

You asked to remove approval history. To be precise about what that means: **the record of
approvals is deleted; the record of actions is kept and improved.** There is no "history of
approvals" because nothing is ever approved. There is a history of *what the agent did*, which is
the auditability requirement.

Concretely, the surviving log answers: **when, what, on which resource, under whose grant, with
what result.** It does not answer "who clicked Approve", because nobody ever will.

### Vocabulary changes (the current terms are decision-shaped and will read wrong)

| Today | Becomes | Why |
|---|---|---|
| `ActionState = "pending" \| "approved" \| "rejected"` | `"succeeded" \| "failed" \| "blocked"` | Outcome, not verdict |
| `resolvedBy` | `authorizedBy` | "under whose grant", not "who clicked Approve" |
| `autoApproved` | **deleted** | Everything is automatic; the useful fact is *which grant*, carried by `gatekeeperId` |
| `appliedAt` | `completedAt` | Currently doubles as the rejection timestamp |
| "Approved" / "Denied" / "Waiting" labels | "Succeeded" / "Failed" / "Blocked" | — |
| `Activity` "Needs review" | **deleted** | — |
| `Activity` "Auto-approval" | **deleted** | — |
| `Activity` "History" | the whole pane, renamed **Activity** | — |

### Audit gaps to close

| Gap | Today | Fix |
|---|---|---|
| No success logging | 3 log lines total, all failure-only | `logger.info` on every recorded action via `observability.ts` |
| No outcome recorded | `applyPendingAction` discards the return | `ActionHandle.succeeded/failed` |
| Coarse provenance | `{from:"agent", chatId}` — no turn, tool call, or model | Add `turnId`, `toolCallId`, `modelId` to `GatekeeperCaller` |
| Hook actions uncorrelated | `caller.from === "hook"` gets no chat association | Correlate to the hook binding |
| No pagination / retention / export | `listActions()` returns everything; `api.ts:1769` TODO | Paginate; retention policy; admin export |
| Collaborators blind | `listActions`/`subscribeToActions` denied in "use" mode (`overseer.ts:9099`, `:9115`) | Read-only activity for workspace members |
| No per-connection filter | Filters are only `all\|action\|observation\|bindHook` | Filter by `gatekeeperId` and `actionKind`; link from each connector card |
| Only classification is `ActionKind` | ...and 3.5 gatekeepers emit it | Universal kinds (Layer 2) + `risk` block |
| Observations unbounded | Every read writes a record, no rollup | Noted, out of scope |

**Keep the prompt-injection hardening.** `tools.ts:157-259` (fence defusing, heading stripping,
backtick-safe code spans, length caps) exists because server-controlled text renders into a surface
a human reads. Still true of an activity view. Retarget it; do not delete it.

## Frontend: everything approval-related, deleted

### Delete entirely

| File | Lines | Note |
|---|---|---|
| `components/ResolveButton.tsx` | 50 | Approve / Deny / Always-approve buttons |
| `components/AutoApproveConfirmDialog.tsx` | 85 | — |
| `useResolveAction.ts` | 35 | `approveAction`/`rejectAction` RPC |
| `useAlwaysApproveTag.ts` | 51 | — |
| `useAutoApproval.ts` | 132 | Rule management |
| `ActivityNotifications.tsx` | 137 | The "Needs review" bell — nothing is ever pending |
| `components/chat/PermissionToast.tsx` | 169 | Already dead, zero importers |
| `components/chat/{ChatMessage,ToolCallCard,ConnectionConfigModal,DataTab,AppPreview}.tsx`, `components/ConnectionChips.tsx` | ~600 | Dead prototype cluster, zero prod importers |

### `ChatInterface.tsx` — approval surfaces

Delete: the `actionControls` triad (`6534-6559`), the blocking `awaitDecision` callout
(`6588-6614`), the pending inline row (`6626-6637`), `hasPendingAwaitedAction` (`4844-4852`),
`applyOptimisticActionState` (`5869-5893`), `autoApproveConfirm` state (`5934-5948`), the dialog
mount (`7959-7975`), `onAutoApproveChange` (`4302-4305`), and the entire `blockedReason` cascade
(`1815`, `2182-2190`, `2467`, `2475`, `3190`, `3333`, `3379-3388`, `3458`, `7871-7877`) — with both
blockers gone, nothing blocks the composer.

Keep: the resolved collapsed row (`6638-6668`, becomes the only action rendering), the observation
card (`6460-6497`), the hook card (`6390-6458`), `expandedActions` (`4557-4559`),
`applyActionLogUpdateToCachedMessages` (`5846-5867`), `applyOptimisticHookEnabled` (`5895-5919`),
`handleToggleHook` (`5950-5972`).

### `ChatInterface.tsx` — in-composer resource grants

Both paths go. Consent belongs in the profile.

- **"Add resource" button** — `3559-3566`, `handleAttachOpen` (`2789-2804`),
  `handleAttachCreated` (`2833-2847`), the attach `GatekeeperModal` mount (`3663-3668`),
  `attachModalOpen`/`attachCursorPosRef` (`1937-1939`), the unused `attachLabel` prop
  (`1813`, `1865`), CSS `ChatInterface.module.css:121,126`.
- **URL capsule overlay** (your call to remove) — the `CapsuleOverlay` mount (`3315-3328`),
  `activeUrl` state (`1915-1919`), the scan cache (`1903-1904`), `URL_REGEX` (`447`),
  `urlLineOffset` (`2160-2180`), the keyboard routing (`3461-3471`), `handleCapsuleCreate`
  (`2676-2732`), `handleRefine` (`2734-2787`), `createCapsuleGatekeeper` prop (`1794`,
  `1823-1826`) and its three call sites (`6884-6886`, `7843-7845`,
  `routes/_authenticated/index.tsx:135-141`), `insertCapsuleAt` (`2806-2831`).
  Then `CapsuleOverlay.tsx` deletes; `ResourcePicker.tsx` survives only as
  `GatekeeperModal`'s picker, and its `type: 'connect'` row (`ResourcePicker.tsx:401`,
  `:435`) — which could start OAuth from chat — is removed.

Keep in the composer: the `Plus` menu (`3517-3558`: formats, thinking-trace, **Upload file**),
file attachments, and slash commands. None of those grant capabilities.

### `Activity.tsx` → the activity log

Delete: `ActivityView` `'review'` and `'auto'` (`21`), the review view (`190-248`),
`ReviewRequest` (`482-549`), `AutoApprovalPanel` (`345-480`), the confirm-dialog mount
(`326-340`), `processingActions` (`121`), `confirmAutoApprove` (`124-130`), `resolveAction`
(`158`), `alwaysApproveTag` (`177-178`), the `pending` split (`133-137`), the
`'pending' → "Waiting"` branch (`96-98`).

Keep and promote to the whole pane: the history view (`249-321`), `HistoryRow` (`551-637`),
`ResolverBadge` (`639-650`, relabelled for grants), `TypeIcon` (`105-110`),
`formatRelativeTime` (`61-68`), hook toggles (`160-175`). Add `gatekeeperId` and `actionKind`
filters.

### `GadgetEditor.tsx` / `WorkpiecePicker.tsx`

Delete `ACTIVITY_TABS` (`167-171`, one view remains), `autoApproveReloadTrigger`
(`582`, `1474`, `1594-1595`), `pendingActions`/`pendingActionsCount` (`735-742`), the
`ActivityNotifications` mount (`1386-1390`), the tab count (`1542`), and the rail's
`pendingActivityCount`/`onOpenActivity` (`1693-1694`; `WorkpiecePicker.tsx:25-26`, `38-39`,
`186-202`). Replace the bell with a plain link to the activity view.
Keep `useActions` (`713`) and `hookSignature` (`716-722`).

### Strengthened, not deleted

`routes/_authenticated/gatekeepers.tsx`, `components/ConnectConnectorModal.tsx` — the consent
layer: render the `ActionCapability` catalog at connect time; add per-resource ungrant; add a
per-connection activity link. `AdminPage.tsx` — add per-vendor action-kind toggles.
`Connections.tsx` and `useActions.ts` are untouched (verified: no approval UI; `useActions` is the
activity transport). All gatekeeper app UIs are untouched (verified: none surface approvals).

### Tests

No frontend test covers approval behavior, so removal carries no rewrite burden — and no regression
net. Only `WorkpiecePicker.test.tsx:31-32` breaks structurally, on removed props. Backend:
`workshop-backend/__tests__/auto-approval.test.ts` deletes;
`__tests__/agent-compaction.test.ts` has 5 `connectionRequest` references to update;
`gatekeeper-mcp-portal/__tests__/config.test.ts` and `mcp-shared/__tests__/tools.test.ts` lose
their trust-tier cases; `gatekeeper-microsoft/__tests__/sessions.test.ts` and
`mcp-shared/__tests__/session-methods.test.ts` need the one-phase conversion;
`integration-tests/fixtures/gatekeeper-test` needs the new contract. **Add tests for the surviving
activity view** — it is untested today.

## Phases

Ordered so `workshop-backend`/`workshop-shared` review separately from UI, per `AGENTS.md:16`.

**Phase 0 — Contract** (`workshop-shared` only; small, dense, line-by-line reviewed).
Add `ActionRecorder`/`ActionHandle`, `ActionCapability` + `risk`, `getActionCatalog()`, the new
`ActionState`, `AdminConfig.disabledActionKinds`. Remove `ApprovalQueue.submitAction`,
`awaitDecision`, `autoApprovable`, `implementsRevert`, `revertAction`, `PreApprovableAction`,
`approveAction`/`rejectAction`, the four auto-approval RPCs, `acceptConnectionRequest`/
`denyConnectionRequest`, and the `connectionRequest` message type. Doc-comment every exported
member.

**Phase 1 — Agent isolation.** Delete `requestConnection`, `listConnectableVendors`,
`listConnectableResources`, the `Connectable vendors:` prompt section, `connectionRequested`, and
the captured-request plumbing. The agent's prompt now lists only held bindings. Ship this early and
alone — it is the smallest change with the largest behavioral effect, and it is independently
verifiable.

**Phase 2 — Overseer.** Implement `authorizeAction`. Move the `prohibitAllSharing` lockdown out of
`submitAction`. Add the `disabledActionKinds` check and the per-turn budget. Delete
`auto-approval.ts`, the `autoApproveTags` collection, `#maybeResumeAfterActionDecision`,
`#resumeSuspendedAgent`, `awaitDecision` latching, and `shouldStopAfterTurn`'s suspension arms.
Enrich `GatekeeperCaller`; add outcome recording and success logging.

**Phase 3 — Gatekeepers.** One PR per vendor. Convert two-phase to inline; declare a kind and an
`ActionCapability` for every action. Delete the boilerplate from the six gatekeepers that submit
nothing. Start with Microsoft (richest catalog, already fully kinded) as the reference conversion.

**Phase 4 — MCP.** Collapse `ActionStore`; delete `getActionResult` and the `pending` result
variant; delete `ServerTrust`/`portalTrust`/`MCP_PORTAL_TRUST_ANNOTATIONS`; retarget `describeCall`
hardening at the activity renderer.

**Phase 5 — Frontend.** All deletions above; promote the activity view; add per-connection and
per-kind filters; render the `ActionCapability` catalog in `ConnectConnectorModal`; per-resource
ungrant; per-vendor action-kind toggles in `AdminPage`. Tests for the surviving surfaces.

**Phase 6 — Simplification harvest.** Delete the action-simulation overlays in Notion, Confluence,
and Google Docs. Independently valuable; gated on Phase 3 landing per vendor.

**Phase 7 — Audit completeness.** Pagination, retention, collaborator read-only access, admin
export. Update `AGENTS.md:28`, which documents the MCP "queued for approval" model.

## Open question

**Retention.** The `actions` collection is append-only with no GC and grows unboundedly per
workspace. Already true today; more acute when the log is the primary control. Needs a policy
decision, not just an implementation. Phase 7.

## Explicitly not doing

- No runtime policy engine, no LLM-judged gate. That reintroduces the thing being removed, with
  worse latency.
- No per-action user settings. A connected user never sees an approval prompt again.
- No in-chat consent of any kind. Grants live in the profile.
- No weakening of the sandbox, the capability boundary, `getGatekeeperClassFor`,
  `prohibitAllSharing`, or the observer graph. None of those are approval machinery.
