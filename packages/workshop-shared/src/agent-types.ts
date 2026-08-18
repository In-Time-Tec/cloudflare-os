// Wire-safe types shared between the Workshop kernel (Overseer DO) and any consumer of the
// agent loop, in particular the orb harness that runs the loop inside a thread's sandbox.
//
// These used to live in workshop-backend's agent.ts; they moved here because an agent loop
// running outside the DO exchanges them with the kernel over capnweb, and a type that crosses
// the wire must have exactly one canonical definition. The portable loop driver lives in
// packages/agent-core and speaks these shapes through AgentHooks.

import type {
  AgentSpawnerConfig, AiChatMessageBody, AiModelConfig, TemplateOutput, WorkpieceId,
} from "./api.js";
import type { AgentCatalog } from "./gatekeeper.js";
import type {
  Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions,
  TextContent, ThinkingContent, ToolCall,
} from "@earendil-works/pi-ai";

/**
 * One entry of the chat's seed binding layer, as returned by AgentHooks.prepareChatBindings():
 * a name in the chat's env, its target workpiece, and display info for the system prompt.
 */
export type SeedBindingInfo = {
  name: string;
  target: WorkpieceId;

  /** Human title of the target (a artifact's title, or a gatekeeper's resource title). */
  title: string;

  /** Whether the target is a artifact (vs. an external resource gatekeeper). */
  isArtifact: boolean;

  /**
   * Present when this entry is an always-available (ambient) resource, e.g. the read session of a
   * connected account that provides a singleton; carries its progressive-discovery catalog (null
   * when the gatekeeper provides none). Such entries get their own system-prompt section.
   */
  catalog?: AgentCatalog | null;
};

/**
 * One entry of the chat's binding map: what a name in the agent's executeCode `env` resolves to.
 * Either a workpiece (a artifact or gatekeeper -- the overseer distinguishes at env-build time) or
 * the value arguments of an agent callback.
 */
export type ChatBindingEntry =
  | { type: "workpiece"; id: WorkpieceId }
  | { type: "value"; messageSequence: number };

/**
 * Additional per-chat-thread info needed by the AI agent but not by the client. Returned by
 * AgentHooks.getChatAgentContext().
 */
export type AiChatAgentContext = {
  /** Chat ID, corresponds to `chatMeta`. */
  chatId: number;

  /**
   * If present, this chat was spawned using a spawner, and this was the spawner config at the
   * time.
   */
  spawnerConfig?: AgentSpawnerConfig;

  /**
   * Initial `env` binding set gathered when this chat was started, typically including all artifacts
   * and all gatekeepers which those artifacts bind to, but the contents may be different depending
   * on how the chat thread was started (e.g. agent spawners initialize env in a specific way).
   *
   * This map is frozen after the chat starts. "changes" messages in the chat log may introduce
   * new bindings, but they aren't added here; instead, the chat log must be replayed to find out
   * the current binding set.
   *
   * This is absent for chats created before named chat bindings existed; such chats are seeded
   * lazily at their next turn start.
   *
   * If any workpieces referenced here are deleted, this will be detected when the env is
   * materialized for a particular execution, and the corresponding bindings will be dropped.
   */
  bindings?: Record<string, WorkpieceId>;

  /**
   * Gatekeeper IDs for ambient capsules which were instantiated into this chat when it started.
   * This array predates the creation of per-chat named bindings; back then, ambient gatekeepers
   * were delivered as numbered "capsules", occupying the lowest numbers in the capsules array, and
   * this array specified their order. But with the advent of per-chat named bindings, these are now
   * folded into `bindings`, above. This array continues to exist to support migrations from old
   * chats (`bindings` will be initialized on next use), and as a record of which bindings came
   * from ambient gatekeepers (though arguably some other data structure might make more sense for
   * that).
   */
  alwaysAvailableCapsuleIds?: WorkpieceId[];

  /**
   * Cached discovery catalogs for the always-available resources, keyed per gatekeeper.
   * Regenerable: re-fetched when missing/stale (see prepareChatBindings).
   */
  alwaysAvailableCatalogs?: AgentCatalogSnapshot[];
};

/** A gatekeeper's agent-facing discovery catalog as snapshot-cached on the thread. */
export type AgentCatalogSnapshot = {
  gatekeeperId: number;
  catalog: AgentCatalog | null;
};

/**
 * Summary of one of the thread's artifacts, as needed by the agent: identity, the name of the
 * Y.Doc root map holding its files, and its named bindings. See AgentHooks.listArtifactInfo().
 */
export type AgentArtifactInfo = {
  id: WorkpieceId;
  title: string;
  rootName: string;
  /**
   * Whether this is the thread's default artifact: the artifact that tools operate on when their
   * artifact-name parameter is omitted. Only threads migrated from single-artifact days
   * (or created from a template) have one.
   */
  isDefault: boolean;
  bindings: {name: string, title: string, target: WorkpieceId}[];
  /** What instantiating this artifact's template produces, when it came from one that declares it. */
  output?: TemplateOutput;
};

/**
 * A tool-call block as persisted in a StoredAssistantMessage: everything pi produced except the
 * arguments, which the step's AiToolCall record already stores (as `input`) and which replay
 * rehydrates by id (see rehydrateStoredAssistantMessage). Tool arguments are the one genuinely
 * large duplicate (writeFile/executeCode payloads are whole files); everything else is kept.
 */
export type StoredToolCall = Omit<ToolCall, "arguments">;

/**
 * The AssistantMessage for one agent step, persisted exactly as pi produced it (except for
 * StoredToolCall's deliberate subtraction) so later turns can replay the step verbatim. This is
 * what preserves reasoning across turns and restarts: thinking blocks keep their provider
 * signatures (including encrypted/redacted payloads), and the message keeps its true
 * api/provider/model provenance, so pi's transformMessages can reflect same-model reasoning back
 * to the provider and apply its cross-model conversions when the user switches models. The
 * snapshot is subtractive on purpose -- copy everything, delete only what's provably redundant --
 * so fields pi adds in the future are retained by default (dropping them would silently reduce
 * fidelity and break prompt caching). Stored server-side only (see `chatModelData` in
 * overseer.ts); clients never receive these.
 */
export type StoredAssistantMessage = Omit<AssistantMessage, "content"> & {
  content: (TextContent | ThinkingContent | StoredToolCall)[];
};

/**
 * A chat message body as the agent loop hands it to AgentHooks.addChatMessages: the client-visible
 * body, plus (for agent steps) the model-facing snapshot to persist alongside it. The overseer
 * strips `modelData` into separate storage; it must never reach clients.
 */
export type AiChatMessageBodyWithModelData = AiChatMessageBody & {
  modelData?: StoredAssistantMessage;
};

/**
 * Stores replay state for one compacted chat prefix. Checkpoints are immutable, and a chat keeps
 * every one it has published, so reading history or reverting can select the newest checkpoint below
 * any sequence.
 */
export type CompactionCheckpoint = {
  /** Chat this checkpoint belongs to. */
  chatId: number;

  /** First sequence replay starts at. Messages before this are represented by the checkpoint. */
  compactedTo: number;

  /** The summary the model wrote. We send it as one user message before the retained messages. */
  summary: string;

  /**
   * The chat's named bindings. Retained messages and the summary refer to these names as
   * `env.NAME`.
   */
  chatBindings: [string, ChatBindingEntry][];

  /** The next change ID for replayed tool results. Change IDs remain sequential across boundaries. */
  nextChangeId: number;

  /** The code version used as the replay base. Tool calls and changes batches can establish it. */
  observedCodeVersion?: number;

  /**
   * Accepted Y.Doc updates from before the boundary, merged into one update. The chat stays pinned
   * to `observedCodeVersion`, so accepted updates are still part of the replay base rather than of
   * the version replay starts from.
   */
  acceptedChanges?: Uint8Array;

  /**
   * Still-proposed Y.Doc updates from before the boundary, merged into one update. Disjoint from
   * `acceptedChanges`; replay applies both. Individual batches remain addressable through the chat
   * log, so reverting to a point before the boundary is still possible.
   *
   * Provisional artifact creations and binding additions from before the boundary are deliberately
   * absent: they carry no Y.Doc update, and the registry rows they created (`ArtifactRecord.pending`,
   * `BindingRecord.pending`) already record them with the sequence that did, untouched by
   * compaction. Merge and revert promote and delete from there rather than from the log, so
   * duplicating them here would be a second source of truth. See getProposedChanges(), which
   * reports the compacted prefix as pending when either this or such a row exists.
   */
  proposedChanges?: Uint8Array;
};

/** The compaction state and policy for one call to `runAgent`. */
export type CompactionContext = {
  /** The checkpoint to replay from, if the thread has one. */
  checkpoint?: CompactionCheckpoint;

  /** The chosen model, whose window and reserved response capacity size the prompt budget. */
  modelConfig: AiModelConfig;

  /** The total tokens reported for the last measured model step, or zero if none are available. */
  measuredTokens: number;
};

/**
 * Route for retrieving a model's AI Gateway logs for cost accounting. Absent when requests
 * don't flow through an AI Gateway (direct provider access, direct Workers AI REST). The
 * `apiToken` member appears only in gateway routes resolved server-side; it is never rendered
 * to a client and never crosses the wire to a sandbox.
 */
export type AiGatewayLogRoute =
  | { gateway: string }
  | { gateway: string; accountId: string; apiToken: string };

/**
 * Per-call stream options accepted by a ModelHandle, extending pi's own options with
 * handle-level knobs.
 */
export type ModelStreamOptions = SimpleStreamOptions & {
  /**
   * When false, suppress the handle's per-API thinking/reasoning defaults so the request runs
   * without extended thinking (as far as the model allows). Used by completeText(): one-shot
   * calls -- titles, binding names, compaction summaries, artifact model bindings -- should be
   * quick, and none of them benefit from cross-step reasoning. Default: true.
   */
  thinking?: boolean;
};

/**
 * A resolved model plus everything needed to stream from it: `stream` closes over the routing
 * (endpoint, auth headers, gateway attribution metadata, session affinity) chosen by the
 * resolver (in-process getModel, or the orb inference proxy's server-side routing), so callers
 * never handle credentials themselves. The harness builds one of these over the inference
 * proxy (see plans/pi-in-orb.md).
 */
export type ModelHandle = {
  /** pi model descriptor (plain data; pi dispatches purely on `model.api`). */
  model: Model<Api>;

  /**
   * Streams a response. Merges the handle's routing/auth and per-API options into whatever
   * per-call options the caller (e.g. the agent loop) passes. Assignable to pi-agent-core's
   * StreamFn (the extra ModelStreamOptions knobs are optional).
   */
  stream: (model: Model<Api>, context: Context, options?: ModelStreamOptions)
      => AssistantMessageEventStream;

  /**
   * Route for retrieving this model's AI Gateway logs for cost accounting. Absent when requests
   * don't flow through an AI Gateway (direct provider access, direct Workers AI REST).
   */
  aiGatewayLogRoute?: AiGatewayLogRoute;

  /**
   * Status and AI Gateway log id of the most recent HTTP response observed by `stream`. Reset at
   * the start of every request and set from pi's onResponse callback (which fires only once a
   * response arrives -- an SDK-level failure leaves this undefined), so consumers must read it
   * right after the request they care about completes. Turns run requests sequentially, so this
   * is safe.
   */
  lastResponse?: { status: number; aiGatewayLogId?: string };
};
