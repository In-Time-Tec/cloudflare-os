// The portable agent loop: everything the pi loop needs that does not touch workerd.
//
// Consumed by the orb harness (the agent loop running inside a thread's sandbox — see
// plans/pi-in-orb.md). Wire-crossable types live in @gadgets/workshop-shared/agent-types; this
// package holds the driver, prompts, tools, replay/compaction helpers, and diff formatting, and
// is kept free of workerd imports by construction (anything Cloudflare-specific must enter
// through the AgentHooks boundary).

export type { AgentHooks } from "./hooks.js";
export { runAgent } from "./run-agent.js";
export type { CompactionContext } from "@gadgets/workshop-shared/agent-types";
export { makeStoredAssistantMessage, rehydrateStoredAssistantMessage } from "./agent-messages.js";
export { AgentTurnError, completeText, httpStatusFromError, zeroUsage } from "./invoke.js";
export { formatInstanceInstructions } from "./instructions.js";
export { PDF_MIME_TYPE, bridgePdfAttachments, modelApiSupportsPdfAttachments } from "./pdf.js";
export type {
  ChangeBatch, CompactionProjectionMessage,
} from "./compaction.js";
export {
  buildCompactionState, buildSummaryPrompt, COMPACTION_SYSTEM_PROMPT, estimateProjectionTokens,
  findCompactionBoundary, foldProposedChanges, getModelTokenLimits, isCompactionTurn,
  protectRetainedReverts, shouldCompactChat,
} from "./compaction.js";
export { StreamingToolInputParser } from "./streaming-json-parser.js";
export {
  formatAgentCatalogPrompt, formatAlwaysAvailableResourcesPrompt, normalizeAgentCatalog,
  completeAgentCatalogSnapshot,
} from "./catalog.js";
export { CodePreviewManager, ExecuteCodeStreamManager } from "./stream-managers.js";
