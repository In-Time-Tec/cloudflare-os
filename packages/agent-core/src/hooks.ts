import * as Y from "yjs";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatStreamEvent, TemplateOutput, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type {
  AgentArtifactInfo, AiChatAgentContext, AiChatMessageBodyWithModelData, AiGatewayLogRoute,
  ChatBindingEntry, SeedBindingInfo, StoredAssistantMessage,
} from "@gadgets/workshop-shared/agent-types";

type MaybePromise<T> = T | Promise<T>;

export interface AgentHooks {
  getChatAgentContext(chatId: number): AiChatAgentContext;
  buildYDoc(version: number | "current"): {ydoc: Y.Doc, version: number};

  /**
   * Summarize the thread's artifacts for the system prompt (see AgentArtifactInfo). Artifacts still
   * provisional to a chat other than `forChatId` are omitted.
   */
  listArtifactInfo(forChatId: number): AgentArtifactInfo[];

  /**
   * Resolve an agent tool's optional workpiece reference to the workpiece's files root. Absent
   * means the thread's default artifact; throws an agent-readable error if there is none. When
   * `mustExist` is set, additionally throws if the artifact isn't currently registered -- or is
   * provisional to a chat other than `forChatId` -- (used by live file tools; history replay
   * omits it so old edits to since-deleted artifacts still resolve).
   */
  resolveWorkpieceRoot(workpieceId?: WorkpieceId, mustExist?: boolean, forChatId?: number)
      : {workpieceId: WorkpieceId, rootName: string};

  /**
   * Create a new, empty artifact workpiece with the given title and binding name, provisional to
   * the given chat: it becomes permanent only when the user accepts the chat's changes through
   * the "changes" message that records the creation (see ArtifactRecord.pending in overseer.ts).
   * Throws if the binding name is invalid or already claimed by another artifact (including one
   * still pending in another chat). Returns the id and the (trimmed) title as created. `output`
   * is the format declared by the template being instantiated, if any (see fetchTemplate).
   */
  createArtifact(title: string, bindingName: string, chatId: number, output?: TemplateOutput)
      : MaybePromise<{id: WorkpieceId, title: string}>;

  /**
   * Describe a workpiece (a artifact or a gatekeeper) reachable as `envName` in the chat's env,
   * for the agent's describeBinding tool. (`envName` is provided here only so that it can be
   * incorporated into the returned description.)
   */
  describeBinding(envName: string, id: WorkpieceId): Promise<string>;

  /**
   * Add a binding to the given artifact, pointing at the given workpiece. The binding is provisional
   * to the chat. The caller is responsible for getting the addition recorded in the chat log (see
   * `addedBindings` on the "changes" message) so the pending edge gets sequence-stamped.
   */
  addArtifactBinding(artifactId: WorkpieceId, name: string, target: WorkpieceId, chatId: number)
      : MaybePromise<void>;

  /**
   * Prepare (seeding/naming lazily as needed) and return the chat's seed binding layer, including
   * the always-available (ambient) resources with their discovery catalogs. Called at turn start,
   * before history replay; this is also the chokepoint that stamps binding names onto any
   * persisted messages that introduced resources but don't carry a name yet (pasted resources,
   * plus connection requests from before agents named their own). `chatMessages` is the caller's
   * in-memory copy of the chat log, which is both scanned and stamped in place -- storage reads
   * return fresh deserialized objects, so stamping a separately-listed copy would leave the
   * caller's replay blind to the new names until the next turn.
   */
  prepareChatBindings(chatId: number, chatMessages: AiChatMessage[]): Promise<SeedBindingInfo[]>;

  executeCodeMode(chatId: number, code: string,
                   initiator: AiChatAuthorInfo, initiatorModelId: string,
                   bindings: Record<string, ChatBindingEntry>,
                   onOutputText?: (delta: string) => void): Promise<string>;

  /**
   * Run one shell command and return its collected output. The orb harness runs this locally in
   * the sandbox (child_process) and may stream output to the UI as toolOutputDelta. Commands are
   * bounded (output size + wall-clock) — long-running work belongs in background processes.
   */
  executeShell(command: string, timeoutMs: number, onDelta?: (delta: string) => void)
      : Promise<{stdout: string, stderr: string, exitCode: number}>;

  /**
   * Spawn a child thread owned by the same user, seeded with `prompt` as its first message
   * (which starts the child's own agent turn). Returns the child's thread id. The child's
   * completed responses are consumed with waitForChildThreads.
   */
  spawnChildThread(title: string, prompt: string): Promise<string>;

  /** Send a follow-up prompt to a child thread this thread previously spawned. */
  sendToChildThread(childThreadId: string, prompt: string): Promise<void>;

  /**
   * Block until at least one spawned child thread has completed a response (or timeout),
   * consuming and returning each ready child's oldest response. Empty = timeout.
   */
  waitForChildThreads(timeoutMs: number)
      : Promise<{threadId: string, title: string, response: string}[]>;

  /** List child threads this thread has spawned, with unconsumed-response counts. */
  listChildThreads(): MaybePromise<{threadId: string, title: string, pendingResponses: number}[]>;

  /** Read a spawned child thread's conversation transcript (bounded plain text). */
  readChildThreadTranscript(childThreadId: string): Promise<string>;
  activeAgentCallbackCount(chatId: number): MaybePromise<number>;
  rejectAllAgentCallbacks(chatId: number, error: string): MaybePromise<void>;
  consumeCapturedActions(chatId: number)
      : MaybePromise<{actions: number[], accessedArtifact: boolean} | undefined>;
  /**
   * Appends messages to the chat log and updates cost/token accounting. When both
   * `aiGatewayLogId` and `aiGatewayLogRoute` are present, the authoritative cost is fetched
   * asynchronously from the AI Gateway log, with `estimatedCost` (pi's catalog-priced estimate
   * from the turn's token usage, in dollars) as the fallback if the gateway can't produce a
   * cost; otherwise the estimate is applied directly, so direct-provider routes still get cost
   * accounting.
   */
  addChatMessages(chatId: number, author: AiChatAuthorInfo,
      msgs: AiChatMessageBodyWithModelData[],
      totalTokens?: number, aiGatewayLogId?: string, aiGatewayLogRoute?: AiGatewayLogRoute,
      estimatedCost?: number): MaybePromise<void>;
  emitChatStreamEvent(chatId: number, event: AiChatStreamEvent): void;

  /**
   * Fetch the model-facing snapshot persisted for an agent step's "message" record, if any (see
   * StoredAssistantMessage). Absent for messages persisted before snapshots existed; replay then
   * falls back to reconstructing the message from the client-visible record.
   */
  getChatModelData(chatId: number, sequence: number): StoredAssistantMessage | undefined;

  /**
   * Record an observation in the Overseer audit log on behalf of a built-in agent tool
   * (i.e. one that isn't backed by a gatekeeper, like `webFetch`). Used to track which
   * external influencers may have tainted the agent's session.
   */
  recordAgentObservation(
      chatId: number,
      resourceTitle: string,
      resourceUrl: string | undefined,
      description: ObservationDescription): Promise<void>;

  /** Returns the bytes of a committed attachment owned by this chat for inclusion in model input. */
  getChatAttachmentData(chatId: number, id: string): Promise<Uint8Array>;

  /**
   * Fetch a public web URL on behalf of the webFetch tool, returning the formatted result
   * string the tool hands to the model. The implementation owns everything that must stay
   * authoritative: server-side fetch with SSRF checks, Workers AI document-to-Markdown
   * conversion, and the observation recorded in the Overseer audit log. The harness remotes this
   * to the DO so a sandbox can never bypass the checks or the audit log.
   */
  executeWebFetch(chatId: number, url: string, raw?: boolean): Promise<string>;

  /**
   * Deployment-wide, admin-authored instructions to append to the agent's system prompt. Returns
   * "" when none are set. Read on each turn so admin edits take effect promptly.
   */
  getInstanceInstructions(): Promise<string>;

  /**
   * Template hooks for the agent.
   *
   * List the templates available to the turn's initiator (their own published templates, their
   * library, and the deployment's featured set) as formatted text. The initiator -- not the
   * thread owner -- because template libraries are per-user: a collaborator driving the agent
   * should see their own. There is no search index; the corpora are small enough for the model to
   * scan directly.
   */
  listAvailableTemplates(initiator: AiChatAuthorInfo): Promise<string>;

  /**
   * A short standing note naming the deployment's standard output formats, or "" if it has none.
   * Carried in the system prompt rather than left to `listTemplates`, because a request phrased as
   * "make me a doc" may not prompt an agent to go looking for templates at all.
   */
  describeStandardFormats(): Promise<string>;

  /**
   * Fetch a template's decoded files, plus formatted notes describing the copied files and the
   * bindings the template's code expects the agent to wire up. Used by the createArtifact tool to
   * instantiate the template as a new artifact, along with the output format the template declares
   * (if any), which the created artifact inherits. Throws an agent-readable error if the template
   * doesn't exist.
   */
  fetchTemplate(templateId: string)
      : Promise<{files: Record<string, string>, notes: string, output?: TemplateOutput}>;
}

