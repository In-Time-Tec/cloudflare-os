import { RpcStub, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatStreamEvent, TemplateOutput, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type {
  AgentArtifactInfo, AiChatAgentContext, AiChatMessageBodyWithModelData, AiGatewayLogRoute,
  ChatBindingEntry, SeedBindingInfo, StoredAssistantMessage,
} from "@gadgets/workshop-shared/agent-types";
import type {
  OrbHarnessTarget, OrbHooks, OrbTurnOutcome, OrbTurnRecord,
} from "@gadgets/workshop-shared/orb-harness";
import type { OverseerImpl } from "../overseer.js";

@validateRpc()
export class OrbHooksImpl extends RpcTarget implements OrbHooks {
  constructor(private host: OverseerImpl, private epoch: number) {
    super();
  }

  private requireExecutor(): void {
    if (this.epoch !== this.host.executorEpoch()) {
      throw new Error("Orb session has been replaced.");
    }
  }

  private requireTurn(chatId: number) {
    this.requireExecutor();
    const turn = this.host.storage.orbTurns.byChatId.get(chatId);
    if (!turn || turn.status !== "running") {
      throw new Error("Turn is no longer active.");
    }
    return turn;
  }

  getChatAgentContext(chatId: number): AiChatAgentContext {
    this.requireTurn(chatId);
    return this.host.getChatAgentContext(chatId);
  }

  listArtifactInfo(forChatId: number): AgentArtifactInfo[] {
    this.requireTurn(forChatId);
    return this.host.listArtifactInfo(forChatId);
  }

  resolveWorkpieceRoot(workpieceId?: WorkpieceId, mustExist?: boolean, forChatId?: number)
      : {workpieceId: WorkpieceId, rootName: string} {
    this.requireExecutor();
    return this.host.resolveWorkpieceRoot(workpieceId, mustExist, forChatId);
  }

  createArtifact(title: string, bindingName: string, chatId: number, output?: TemplateOutput)
      : {id: WorkpieceId, title: string} {
    this.requireTurn(chatId);
    const record = this.host.createArtifact(title, bindingName, chatId, output);
    return { id: record.id, title: record.title };
  }

  describeBinding(envName: string, id: WorkpieceId): Promise<string> {
    this.requireExecutor();
    return this.host.describeBinding(envName, id);
  }

  addArtifactBinding(artifactId: WorkpieceId, name: string, target: WorkpieceId, chatId: number)
      : void {
    this.requireTurn(chatId);
    this.host.addArtifactBinding(artifactId, name, target, chatId);
  }

  prepareChatBindings(chatId: number, chatMessages: AiChatMessage[]): Promise<SeedBindingInfo[]> {
    this.requireTurn(chatId);
    return this.host.prepareChatBindings(chatId, chatMessages);
  }

  executeCodeMode(chatId: number, code: string,
                   initiator: AiChatAuthorInfo, initiatorModelId: string,
                   bindings: Record<string, ChatBindingEntry>,
                   onOutputText?: (delta: string) => void): Promise<string> {
    this.requireTurn(chatId);
    return this.host.executeCodeMode(
        chatId, code, initiator, initiatorModelId, bindings, onOutputText);
  }

  spawnChildThread(title: string, prompt: string): Promise<string> {
    this.requireExecutor();
    return this.host.spawnChildThread(title, prompt);
  }

  sendToChildThread(childThreadId: string, prompt: string): Promise<void> {
    this.requireExecutor();
    return this.host.sendToChildThread(childThreadId, prompt);
  }

  waitForChildThreads(timeoutMs: number)
      : Promise<{threadId: string, title: string, response: string}[]> {
    this.requireExecutor();
    return this.host.waitForChildThreads(timeoutMs);
  }

  listChildThreads(): {threadId: string, title: string, pendingResponses: number}[] {
    this.requireExecutor();
    return this.host.listChildThreads();
  }

  readChildThreadTranscript(childThreadId: string): Promise<string> {
    this.requireExecutor();
    return this.host.readChildThreadTranscript(childThreadId);
  }

  activeAgentCallbackCount(chatId: number): number {
    this.requireTurn(chatId);
    return this.host.activeAgentCallbackCount(chatId);
  }

  rejectAllAgentCallbacks(chatId: number, error: string): void {
    this.requireTurn(chatId);
    this.host.rejectAllAgentCallbacks(chatId, error);
  }

  consumeCapturedActions(chatId: number)
      : {actions: number[], accessedArtifact: boolean} | undefined {
    this.requireTurn(chatId);
    return this.host.consumeCapturedActions(chatId);
  }

  addChatMessages(chatId: number, author: AiChatAuthorInfo,
      msgs: AiChatMessageBodyWithModelData[],
      totalTokens?: number, aiGatewayLogId?: string, _aiGatewayLogRoute?: AiGatewayLogRoute,
      estimatedCost?: number): Promise<void> {
    const turn = this.requireTurn(chatId);
    this.host.addChatMessages(
        chatId, author, msgs, totalTokens, aiGatewayLogId, turn.logRoute, estimatedCost);
    return Promise.resolve();
  }

  emitChatStreamEvent(chatId: number, event: AiChatStreamEvent): void {
    this.requireTurn(chatId);
    this.host.emitChatStreamEvent(chatId, event);
  }

  getChatModelData(chatId: number, sequence: number): StoredAssistantMessage | undefined {
    this.requireTurn(chatId);
    return this.host.getChatModelData(chatId, sequence);
  }

  recordAgentObservation(
      chatId: number,
      resourceTitle: string,
      resourceUrl: string | undefined,
      description: ObservationDescription): Promise<void> {
    this.requireTurn(chatId);
    return this.host.recordAgentObservation(chatId, resourceTitle, resourceUrl, description);
  }

  getChatAttachmentData(chatId: number, id: string): Promise<Uint8Array> {
    this.requireExecutor();
    return this.host.getChatAttachmentData(chatId, id);
  }

  getInstanceInstructions(): Promise<string> {
    this.requireExecutor();
    return this.host.getInstanceInstructions();
  }

  listAvailableTemplates(initiator: AiChatAuthorInfo): Promise<string> {
    this.requireExecutor();
    return this.host.listAvailableTemplates(initiator);
  }

  describeStandardFormats(): Promise<string> {
    this.requireExecutor();
    return this.host.describeStandardFormats();
  }

  fetchTemplate(templateId: string)
      : Promise<{files: Record<string, string>, notes: string, output?: TemplateOutput}> {
    this.requireExecutor();
    return this.host.fetchTemplate(templateId);
  }

  getCodeDocState(version: number | "current"): Promise<{update: Uint8Array, version: number}> {
    this.requireExecutor();
    return Promise.resolve(this.host.getCodeDocState(version));
  }

  executeWebFetch(chatId: number, url: string, raw?: boolean): Promise<string> {
    this.requireTurn(chatId);
    return this.host.executeWebFetch(chatId, url, raw);
  }

  listChatTail(chatId: number): AiChatMessage[] {
    this.requireTurn(chatId);
    return this.host.listChatTail(chatId);
  }

  nudgeOutstandingCallbacks(chatId: number): void {
    const turn = this.requireTurn(chatId);
    this.host.nudgeOutstandingCallbacks(chatId, turn.record.initiator);
  }

  claimPendingTurn(): Promise<OrbTurnRecord | undefined> {
    this.requireExecutor();
    return this.host.claimPendingTurn();
  }

  reportTurnTerminal(turnId: string, outcome: OrbTurnOutcome): Promise<void> {
    this.requireExecutor();
    return this.host.reportOrbTurnTerminal(turnId, outcome);
  }

  refreshOrbSession(): Promise<string> {
    this.requireExecutor();
    return this.host.refreshOrbSession();
  }

  mintInferenceGrant(turnId: string): Promise<string> {
    this.requireExecutor();
    return this.host.mintTurnGrant(turnId);
  }

  attachHarness(target: OrbHarnessTarget): void {
    this.requireExecutor();
    this.host.attachHarness(target as RpcStub<OrbHarnessTarget>);
  }
}
