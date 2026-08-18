// The orb-harness wire contract: the capnweb boundary between the Overseer DO (kernel) and an
// agent loop running inside a thread's E2B sandbox (the "orb harness").
//
// This is the same split AgentHooks already draws inside the DO -- the loop touches kernel state
// exclusively through ~25 method calls -- with the caller moved to the sandbox. Both sides speak
// these plain types over capnweb; no Effect values, Y.Doc instances, or RPC stubs ride inside
// them (capnweb itself carries callback stubs and Uint8Array natively, which is why
// onOutputText and doc-state transfers appear below). The harness implements AgentHooks
// (from the loop driver) by delegating every method to an OrbHooks stub; the DO implements
// OrbHooks by delegating to the same Overseer methods the kernel already owns. See
// plans/pi-in-orb.md.

import type { RpcTarget } from "capnweb";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatStreamEvent, TemplateOutput, WorkpieceId,
} from "./api.js";
import type { ObservationDescription } from "./gatekeeper.js";
import type {
  AgentArtifactInfo, AiChatAgentContext, AiChatMessageBodyWithModelData, AiGatewayLogRoute,
  ChatBindingEntry, CompactionCheckpoint, CompactionContext, SeedBindingInfo,
  StoredAssistantMessage,
} from "./agent-types.js";

/**
 * The pi model descriptor a turn runs on, as dispatched to the harness: everything the loop's
 * ModelHandle needs to shape requests, minus anything secret. `baseUrl` is the *proxy* origin
 * (`<origin>/orb-api/inference`), never the provider's real endpoint -- pi appends the provider
 * API's own path (e.g. /chat/completions) to it, and the upstream Worker rewrites that onto the
 * real provider route while attaching deployment credentials server-side. `headers` is omitted
 * entirely: the only auth the harness may present is the turn grant, which rides in its own
 * header on the inference request, not in the model descriptor.
 */
export type OrbModelSnapshot = Omit<Model<Api>, "headers"> & {
  baseUrl: string;
};

/**
 * One turn dispatched to the harness. The DO prepares it (replay, compaction checkpoint
 * selection, model selection, binding seed) and records it before pushing it, so a harness crash
 * can reclaim it via `claimPendingTurn`.
 */
export type OrbTurnRecord = {
  /** Stable turn id; the DO dedupes terminal reports and pending-claims on it. */
  turnId: string;
  /** Thread (Overseer DO id) this turn belongs to. */
  chatId: number;

  /**
   * The resolved model for this turn, pinned at dispatch (see OrbModelSnapshot). The harness
   * cannot choose models, endpoints, or credentials.
   */
  model: OrbModelSnapshot;

  /**
   * Thread code snapshot the harness hydrates into a local Y.Doc. Live Y.Doc instances cannot
   * cross RPC; this is `Y.encodeStateAsUpdateV2` of the same state `buildYDoc` would return for
   * this turn's observed version. Incremental edits return through `addChatMessages` "changes"
   * records, the same path the in-DO loop uses.
   */
  codeDoc: { update: Uint8Array; version: number };

  /**
   * Route for retrieving this model's AI Gateway logs for cost accounting, resolved server-side
   * and stripped of credentials. Absent for direct-provider routes. The DO ignores any route the
   * harness sends back and applies the kernel-stored route instead.
   */
  aiGatewayLogRoute?: { gateway: string; accountId?: string };

  /**
   * Turn-scoped inference grant: what the harness presents to POST /orb-api/inference. Minted by
   * the DO at dispatch (and re-minted at claim for turns queued across a harness crash).
   */
  grantJwt: string;

  /** The chat log the turn runs against (already replay/compaction-prepared by the DO). */
  chatMessages: AiChatMessage[];

  /** Author of the activity that started this turn; recorded into the chat log. */
  author: AiChatAuthorInfo;

  /** Initiator recorded for observation/cost attribution (may differ from author). */
  initiator: AiChatAuthorInfo;

  /** True when this turn continues an earlier one in response to an agent callback. */
  callbackInitiated: boolean;

  /** Compaction state and policy; see CompactionContext. */
  compaction: CompactionContext;

  /** Chat agent context at dispatch; the harness answers getChatAgentContext locally from this. */
  agentContext: AiChatAgentContext;

  /**
   * Artifact registry snapshot at dispatch. The harness answers listArtifactInfo and
   * resolveWorkpieceRoot locally, and appends artifacts it creates through createArtifact.
   */
  artifactInfos: AgentArtifactInfo[];

  /**
   * Model-facing snapshots for this chat, keyed by message sequence. The harness answers
   * getChatModelData locally so replay does not round-trip per step.
   */
  modelData: {sequence: number, message: StoredAssistantMessage}[];

  /** True when this turn is `/compact` and must stop after committing a checkpoint. */
  stopAfterCompaction: boolean;
};

/** Terminal state of a dispatched turn, reported back to the DO. */
export type OrbTurnOutcome =
  | {
      kind: "ok";
      /** The checkpoint the turn produced if it compacted instead of prompting. */
      checkpoint?: CompactionCheckpoint;
    }
  | {
      kind: "compacted";
      /** Commit this checkpoint and keep the turn running; the harness continues the loop. */
      checkpoint: CompactionCheckpoint;
    }
  | {
      kind: "failed";
      /** Renderable failure description; the DO records it like an in-DO turn failure. */
      error: string;
    };

/**
 * The subset of AgentHooks (the loop's kernel boundary) that crosses the wire to a sandbox.
 * The harness fulfills AgentHooks by delegating to this stub; the DO fulfills it by relaying to
 * the same Overseer methods the kernel already owns, so stream events, chat-log appends,
 * observations, and capability checks behave identically. Methods not present here are local to
 * the harness: buildYDoc (hydrated from the turn snapshot / getCodeDocState), executeShell (a
 * local child process), and web fetch (remoted as executeWebFetch so SSRF checks stay
 * server-side).
 */
export interface OrbHooks extends RpcTarget {
  /** Local-to-the-harness loop state; see AgentHooks.getChatAgentContext. */
  getChatAgentContext(chatId: number): AiChatAgentContext;

  /** Summarize the thread's artifacts for the system prompt. See AgentHooks.listArtifactInfo. */
  listArtifactInfo(forChatId: number): AgentArtifactInfo[];

  /**
   * Resolve an agent tool's optional workpiece reference to the workpiece's files root. Absent
   * means the thread's default artifact. See AgentHooks.resolveWorkpieceRoot.
   */
  resolveWorkpieceRoot(workpieceId?: WorkpieceId, mustExist?: boolean, forChatId?: number)
      : {workpieceId: WorkpieceId, rootName: string};

  /** Create a new artifact workpiece, provisional to the chat. See AgentHooks.createArtifact. */
  createArtifact(title: string, bindingName: string, chatId: number, output?: TemplateOutput)
      : {id: WorkpieceId, title: string};

  /** Describe a workpiece reachable as `envName` (the describeBinding tool). */
  describeBinding(envName: string, id: WorkpieceId): Promise<string>;

  /** Add a binding to an artifact, provisional to the chat. See AgentHooks.addArtifactBinding. */
  addArtifactBinding(artifactId: WorkpieceId, name: string, target: WorkpieceId, chatId: number): void;

  /** Prepare the chat's seed binding layer. See AgentHooks.prepareChatBindings. */
  prepareChatBindings(chatId: number, chatMessages: AiChatMessage[]): Promise<SeedBindingInfo[]>;

  /**
   * Run one-off code in a no-egress Worker sandbox with the chat's env bindings. The code runs
   * kernel-side (Worker Loader, `globalOutbound: null`); `onOutputText` is a capnweb callback
   * stub the sandbox supplies, invoked with each output delta so the harness can surface it as a
   * toolOutputDelta stream event.
   */
  executeCodeMode(chatId: number, code: string,
                   initiator: AiChatAuthorInfo, initiatorModelId: string,
                   bindings: Record<string, ChatBindingEntry>,
                   onOutputText?: (delta: string) => void): Promise<string>;

  /** Spawn a child thread owned by the same user. See AgentHooks.spawnChildThread. */
  spawnChildThread(title: string, prompt: string): Promise<string>;

  /** Send a follow-up prompt to a child thread. See AgentHooks.sendToChildThread. */
  sendToChildThread(childThreadId: string, prompt: string): Promise<void>;

  /** Block until a spawned child thread responds (or timeout). See AgentHooks.waitForChildThreads. */
  waitForChildThreads(timeoutMs: number)
      : Promise<{threadId: string, title: string, response: string}[]>;

  /** List spawned child threads with pending-response counts. See AgentHooks.listChildThreads. */
  listChildThreads(): {threadId: string, title: string, pendingResponses: number}[];

  /** Read a spawned child thread's transcript (bounded plain text). */
  readChildThreadTranscript(childThreadId: string): Promise<string>;

  /** Count in-flight agent callbacks. See AgentHooks.activeAgentCallbackCount. */
  activeAgentCallbackCount(chatId: number): number;

  /** Reject all outstanding agent callbacks with an error. See AgentHooks.rejectAllAgentCallbacks. */
  rejectAllAgentCallbacks(chatId: number, error: string): void;

  /** Drain and clear this thread's captured side-effect records. See AgentHooks.consumeCapturedActions. */
  consumeCapturedActions(chatId: number)
      : {actions: number[], accessedArtifact: boolean} | undefined;

  /**
   * Append messages to the chat log and update cost/token accounting. When `aiGatewayLogId` and
   * `aiGatewayLogRoute` are both present the authoritative cost is fetched from the AI Gateway
   * log; otherwise `estimatedCost` applies. See AgentHooks.addChatMessages.
   */
  addChatMessages(chatId: number, author: AiChatAuthorInfo,
      msgs: AiChatMessageBodyWithModelData[],
      totalTokens?: number, aiGatewayLogId?: string, aiGatewayLogRoute?: AiGatewayLogRoute,
      estimatedCost?: number): Promise<void>;

  /** Relay one stream event to the thread's UI subscribers. See AgentHooks.emitChatStreamEvent. */
  emitChatStreamEvent(chatId: number, event: AiChatStreamEvent): void;

  /** Fetch a persisted agent-step model snapshot. See AgentHooks.getChatModelData. */
  getChatModelData(chatId: number, sequence: number): StoredAssistantMessage | undefined;

  /** Record an observation in the Overseer audit log. See AgentHooks.recordAgentObservation. */
  recordAgentObservation(
      chatId: number,
      resourceTitle: string,
      resourceUrl: string | undefined,
      description: ObservationDescription): Promise<void>;

  /** Returns the bytes of a committed attachment owned by this chat. */
  getChatAttachmentData(chatId: number, id: string): Promise<Uint8Array>;

  /** Deployment-wide admin instructions ("" when none). See AgentHooks.getInstanceInstructions. */
  getInstanceInstructions(): Promise<string>;

  /** Templates available to the turn's initiator, as formatted text. */
  listAvailableTemplates(initiator: AiChatAuthorInfo): Promise<string>;

  /** A standing note naming the deployment's standard output formats, or "". */
  describeStandardFormats(): Promise<string>;

  /** Fetch a template's decoded files plus notes and declared output. See AgentHooks.fetchTemplate. */
  fetchTemplate(templateId: string)
      : Promise<{files: Record<string, string>, notes: string, output?: TemplateOutput}>;

  /**
   * Full Y.Doc update vector plus the observed code version, matching AgentHooks.buildYDoc.
   * Used when the harness must rebuild after the snapshot in the turn record (reconnect).
   */
  getCodeDocState(version: number | "current"): Promise<{update: Uint8Array, version: number}>;

  /**
   * Fetch a public web URL with server-side SSRF checks and Workers-AI document-to-Markdown
   * conversion, recording the observation in the audit log. This is the remoted form of the
   * webFetch tool; the loop driver's webFetch implementation stays DO-side (its env is not
   * wire-safe and the checks must be authoritative).
   */
  executeWebFetch(chatId: number, url: string, raw?: boolean): Promise<string>;

  /**
   * Chat log tail the next model step should see (after the active compaction boundary). Used
   * when the harness continues a logical run after compaction or a callback nudge.
   */
  listChatTail(chatId: number): AiChatMessage[];

  /** Append the outstanding-callback nudge into the chat log. The harness owns whether to nudge. */
  nudgeOutstandingCallbacks(chatId: number): void;

  /**
   * Claim a turn that was dispatched while the harness was down. Returns one queued turn record
   * (with a freshly minted grant) or undefined when the queue is empty.
   */
  claimPendingTurn(): Promise<OrbTurnRecord | undefined>;

  /**
   * Report a turn's terminal state so the DO can run its normal turn-end bookkeeping. The
   * harness must await this so compaction-continue and callback-nudge dispatch before the
   * RPC returns.
   */
  reportTurnTerminal(turnId: string, outcome: OrbTurnOutcome): Promise<void>;

  /**
   * Refresh the harness's session token (15-minute lifetime) so the hooks connection survives
   * without re-authentication. The DO responds with a freshly minted token for the same orb
   * generation; a bumped generation rejects the old token regardless.
   */
  refreshOrbSession(): Promise<string>;

  /** Mint a fresh inference grant for `turnId` (used when reclaiming a queued turn). */
  mintInferenceGrant(turnId: string): Promise<string>;

  /**
   * Register this harness so the DO can push turns. Mirrors AiChatSubscriber: the harness passes
   * itself over capnweb and the DO holds the stub. On attach the DO also delivers any queued
   * turn via claimPendingTurn semantics (the harness should call claimPendingTurn after attach
   * as crash recovery).
   */
  attachHarness(target: OrbHarnessTarget): void;
}

/**
 * What the harness registers with the DO at attach time, so the DO can push turns to the sandbox.
 * Mirrors the AiChatSubscriber registration pattern: the harness passes itself over capnweb and
 * the DO holds the stub. Absent a live target the DO leaves turns queued for claimPendingTurn.
 */
export interface OrbHarnessTarget extends RpcTarget {
  /**
   * Dispatch one prepared turn. The harness runs the portable loop driver; the turn reports its
   * own outcome via hooks.reportTurnTerminal.
   */
  runTurn(turn: OrbTurnRecord): void;

  /** Abort a running turn. The harness interrupts the loop; a dead socket falls back to killing
   *  the harness process and the DO marks the turn failed-restartable. */
  abortTurn(turnId: string): void;

  /** Liveness probe; used by the DO to detect a wedged socket cheaply. */
  ping(): void;
}
