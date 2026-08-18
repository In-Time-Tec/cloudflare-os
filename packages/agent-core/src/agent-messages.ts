import { createLogger } from "@gadgets/backend-utils/logger";
import type {
  AssistantMessage, TSchema, TextContent, ToolCall,
} from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AiToolCall } from "@gadgets/workshop-shared/api";
import type {
  ModelHandle, StoredAssistantMessage, StoredToolCall,
} from "@gadgets/workshop-shared/agent-types";
import { zeroUsage } from "./invoke.js";

const logger = createLogger<{chatId?: number; sequence?: number; toolCallId?: string; error?: unknown}>({
  component: "agent-core.messages",
});

/**
 * Snapshots a completed step's AssistantMessage for persistence. See StoredAssistantMessage for
 * why this copies everything and subtracts rather than picking fields. (Exported for tests.)
 */
export function makeStoredAssistantMessage(message: AssistantMessage): StoredAssistantMessage {
  return {
    ...message,
    content: message.content.map(block => {
      if (block.type !== "toolCall") return block;
      let stored: StoredToolCall & {arguments?: Record<string, unknown>} = {...block};
      delete stored.arguments;
      return stored;
    }),
  };
}

/**
 * Methods of OverseerImpl that runAgent() needs to call, extracted as an interface to avoid cyclic
 * dependencies.
 * TODO(cleanup): This is getting a bit large, and there's a lot of state that is passed into the
 *   agent just so that it can be passed back to these hooks, like `chatId`. We could probably
 *   factor out some sort of chat context object here -- maybe merge with LiveChatContext in
 *   overseer.ts?
 */

export function jsonToolResultText(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Rebuilds the model-facing assistant message for one agent step from its persisted snapshot,
 * verbatim except that each tool-call block's arguments are rehydrated from the step's AiToolCall
 * record (see StoredToolCall). Returns undefined -- the caller then falls back to reconstructing
 * the message from the display record -- if a block references a tool call the display record
 * doesn't have, which indicates a bug (the two are written together) or corrupted storage.
 * (Exported for tests.)
 */
export function rehydrateStoredAssistantMessage(
    stored: StoredAssistantMessage, toolCalls: AiToolCall[] | undefined,
    chatId: number, sequence: number): AssistantMessage | undefined {
  let toolCallsById = new Map((toolCalls ?? []).map(tc => [tc.toolCallId, tc]));
  let content: AssistantMessage["content"] = [];
  for (let block of stored.content) {
    if (block.type !== "toolCall") {
      content.push(block);
      continue;
    }
    let record = toolCallsById.get(block.id);
    if (!record) {
      logger.error("stored assistant message references unknown tool call", {
        event: "agent.model.data.rehydrate.failed",
        chatId, sequence, toolCallId: block.id,
      });
      return undefined;
    }
    content.push({...block, arguments: record.input as Record<string, unknown>});
  }
  return {...stored, content};
}

/**
 * Builds an assistant message reconstructed from the chat log, filling the bookkeeping fields pi
 * requires (provenance from the session's model, zero usage, a plain "stop").
 */
export function makeReplayAssistantMessage(
    content: (TextContent | ToolCall)[], model: ModelHandle["model"],
    timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp,
  };
}

/**
 * Builds an AgentTool while keeping `execute`'s params typed by its TypeBox schema; the cast to
 * the untyped AgentTool erases the parameter type (pi validates tool-call arguments against the
 * schema before calling execute, so the runtime types are guaranteed).
 */
export function defineTool<TParameters extends TSchema>(def: AgentTool<TParameters>): AgentTool {
  return def as unknown as AgentTool;
}

/**
 * Runs one agent turn against the chat's history. Returns a checkpoint when the turn compacted
 * instead of prompting the model: the caller commits it, then reruns for a normal turn or stops for
 * `/compact`. Returns undefined when the turn ran.
 */
