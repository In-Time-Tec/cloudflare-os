import * as Y from "yjs";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatStreamEvent, TemplateOutput, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type {
  AgentArtifactInfo, AiChatAgentContext, AiChatMessageBodyWithModelData, AiGatewayLogRoute,
  ChatBindingEntry, SeedBindingInfo, StoredAssistantMessage,
} from "@gadgets/workshop-shared/agent-types";
import type { OrbHooks, OrbTurnRecord } from "@gadgets/workshop-shared/orb-harness";
import type { AgentHooks } from "@gadgets/agent-core";
import { executeShell } from "./execute-shell.js";

export type Remoted<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};

export class HarnessAgentHooks implements AgentHooks {
  artifactInfos: AgentArtifactInfo[];
  private codeDoc: { update: Uint8Array; version: number };
  private agentContext: AiChatAgentContext;
  private modelData: Map<number, StoredAssistantMessage>;

  constructor(private remote: Remoted<OrbHooks>, turn: OrbTurnRecord) {
    this.artifactInfos = [...turn.artifactInfos];
    this.codeDoc = turn.codeDoc;
    this.agentContext = turn.agentContext;
    this.modelData = new Map(turn.modelData.map((entry) => [entry.sequence, entry.message]));
  }

  getChatAgentContext(_chatId: number): AiChatAgentContext {
    return this.agentContext;
  }

  buildYDoc(_version: number | "current"): {ydoc: Y.Doc, version: number} {
    const ydoc = new Y.Doc();
    Y.applyUpdateV2(ydoc, this.codeDoc.update);
    return { ydoc, version: this.codeDoc.version };
  }

  listArtifactInfo(_forChatId: number): AgentArtifactInfo[] {
    return this.artifactInfos;
  }

  resolveWorkpieceRoot(workpieceId?: WorkpieceId, mustExist?: boolean, _forChatId?: number)
      : {workpieceId: WorkpieceId, rootName: string} {
    if (workpieceId === undefined) {
      const def = this.artifactInfos.find((artifact) => artifact.isDefault) ?? this.artifactInfos[0];
      if (!def) {
        throw new Error(
            "No workpiece was specified, and this thread has no default artifact. Pass the " +
            "`workpiece` parameter naming the artifact to operate on, or create one with " +
            "createArtifact first.");
      }
      return { workpieceId: def.id, rootName: def.rootName };
    }
    const info = this.artifactInfos.find((artifact) => artifact.id === workpieceId);
    if (mustExist && !info) throw new Error(`No such artifact: ${workpieceId}`);
    if (info) return { workpieceId: info.id, rootName: info.rootName };
    return { workpieceId, rootName: String(workpieceId) };
  }

  async createArtifact(title: string, bindingName: string, chatId: number, output?: TemplateOutput)
      : Promise<{id: WorkpieceId, title: string}> {
    const created = await this.remote.createArtifact(title, bindingName, chatId, output);
    this.artifactInfos.push({
      id: created.id,
      title: created.title,
      rootName: String(created.id),
      isDefault: false,
      bindings: [],
    });
    return created;
  }

  describeBinding(envName: string, id: WorkpieceId): Promise<string> {
    return this.remote.describeBinding(envName, id);
  }

  async addArtifactBinding(
      artifactId: WorkpieceId, name: string, target: WorkpieceId, chatId: number): Promise<void> {
    await this.remote.addArtifactBinding(artifactId, name, target, chatId);
  }

  prepareChatBindings(chatId: number, chatMessages: AiChatMessage[]): Promise<SeedBindingInfo[]> {
    return this.remote.prepareChatBindings(chatId, chatMessages);
  }

  executeCodeMode(chatId: number, code: string,
                   initiator: AiChatAuthorInfo, initiatorModelId: string,
                   bindings: Record<string, ChatBindingEntry>,
                   onOutputText?: (delta: string) => void): Promise<string> {
    return this.remote.executeCodeMode(
        chatId, code, initiator, initiatorModelId, bindings, onOutputText);
  }

  executeShell(command: string, timeoutMs: number, onDelta?: (delta: string) => void)
      : Promise<{stdout: string, stderr: string, exitCode: number}> {
    return executeShell(command, timeoutMs, onDelta);
  }

  spawnChildThread(title: string, prompt: string): Promise<string> {
    return this.remote.spawnChildThread(title, prompt);
  }

  sendToChildThread(childThreadId: string, prompt: string): Promise<void> {
    return this.remote.sendToChildThread(childThreadId, prompt);
  }

  waitForChildThreads(timeoutMs: number)
      : Promise<{threadId: string, title: string, response: string}[]> {
    return this.remote.waitForChildThreads(timeoutMs);
  }

  listChildThreads(): Promise<{threadId: string, title: string, pendingResponses: number}[]> {
    return Promise.resolve(this.remote.listChildThreads());
  }

  readChildThreadTranscript(childThreadId: string): Promise<string> {
    return this.remote.readChildThreadTranscript(childThreadId);
  }

  activeAgentCallbackCount(chatId: number): Promise<number> {
    return Promise.resolve(this.remote.activeAgentCallbackCount(chatId));
  }

  rejectAllAgentCallbacks(chatId: number, error: string): Promise<void> {
    return Promise.resolve(this.remote.rejectAllAgentCallbacks(chatId, error));
  }

  consumeCapturedActions(chatId: number)
      : Promise<{actions: number[], accessedArtifact: boolean} | undefined> {
    return Promise.resolve(this.remote.consumeCapturedActions(chatId));
  }

  addChatMessages(chatId: number, author: AiChatAuthorInfo,
      msgs: AiChatMessageBodyWithModelData[],
      totalTokens?: number, aiGatewayLogId?: string, aiGatewayLogRoute?: AiGatewayLogRoute,
      estimatedCost?: number): Promise<void> {
    return this.remote.addChatMessages(
        chatId, author, msgs, totalTokens, aiGatewayLogId, aiGatewayLogRoute, estimatedCost);
  }

  emitChatStreamEvent(chatId: number, event: AiChatStreamEvent): void {
    void this.remote.emitChatStreamEvent(chatId, event);
  }

  getChatModelData(_chatId: number, sequence: number): StoredAssistantMessage | undefined {
    return this.modelData.get(sequence);
  }

  recordAgentObservation(
      chatId: number,
      resourceTitle: string,
      resourceUrl: string | undefined,
      description: ObservationDescription): Promise<void> {
    return this.remote.recordAgentObservation(chatId, resourceTitle, resourceUrl, description);
  }

  getChatAttachmentData(chatId: number, id: string): Promise<Uint8Array> {
    return this.remote.getChatAttachmentData(chatId, id);
  }

  executeWebFetch(chatId: number, url: string, raw?: boolean): Promise<string> {
    return this.remote.executeWebFetch(chatId, url, raw);
  }

  getInstanceInstructions(): Promise<string> {
    return this.remote.getInstanceInstructions();
  }

  listAvailableTemplates(initiator: AiChatAuthorInfo): Promise<string> {
    return this.remote.listAvailableTemplates(initiator);
  }

  describeStandardFormats(): Promise<string> {
    return this.remote.describeStandardFormats();
  }

  fetchTemplate(templateId: string)
      : Promise<{files: Record<string, string>, notes: string, output?: TemplateOutput}> {
    return this.remote.fetchTemplate(templateId);
  }
}
