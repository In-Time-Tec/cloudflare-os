// Workerd-specific residue of the agent loop: the storable callback-args machinery (which needs
// NativeRpcStub and the TransientStubLoopback transport) and re-exports of the portable loop.
//
// Everything portable moved to packages/agent-core (see plans/pi-in-orb.md): the loop driver,
// prompts, tools, replay/compaction helpers, diff formatting. This file keeps only what cannot
// leave workerd. Imports of `runAgent` / `AgentHooks` etc. elsewhere in this package now come
// from @gadgets/agent-core.

import { RpcStub as NativeRpcStub } from "cloudflare:workers";

export {
  AgentTurnError, buildCompactionState, buildSummaryPrompt, completeAgentCatalogSnapshot,
  completeText, COMPACTION_SYSTEM_PROMPT, estimateProjectionTokens, findCompactionBoundary,
  foldProposedChanges, formatAgentCatalogPrompt, formatAlwaysAvailableResourcesPrompt,
  getModelTokenLimits, httpStatusFromError, isCompactionTurn, makeStoredAssistantMessage,
  normalizeAgentCatalog, protectRetainedReverts, rehydrateStoredAssistantMessage,
  shouldCompactChat, StreamingToolInputParser, zeroUsage,
} from "@gadgets/agent-core";
export type {
  AgentHooks, ChangeBatch, CompactionProjectionMessage, CompactionContext,
} from "@gadgets/agent-core";
export type { ModelHandle, ModelStreamOptions } from "@gadgets/workshop-shared/agent-types";

// Agent callback args processing utilities.

// Checks if a value is a plain object (not a class instance, not a native type).
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  let proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Produces the storable version of callback args: deep copy where NativeRpcStub instances
 * are replaced with TransientStubLoopback Fetchers. ServiceStub/Fetcher instances and other
 * native types are kept as-is. Throws if depth exceeds 64.
 *
 * Each transient RpcStub found is collected into `transientStubs` (side output). The
 * `replaceTransientStub` callback creates a TransientStubLoopback Fetcher for the given
 * stub index.
 */
export function makeStorableArgs(
    value: unknown,
    replaceTransientStub: (stubIndex: number) => unknown,
    // TODO: When NativeStub<unknown> works, change `any[]` to `NativeStub<unknown>[]`.
    transientStubs: any[],
    depth: number = 0): unknown {
  if (depth > 64) {
    throw new Error("Agent callback arguments exceed maximum nesting depth of 64.");
  }

  // Transient RPC stubs → collect and replace with loopback.
  if (value instanceof NativeRpcStub) {
    let index = transientStubs.length;
    // @ts-ignore RPC types cause excessively deep instantiation.
    transientStubs.push(value);
    return replaceTransientStub(index);
  }

  if (Array.isArray(value)) {
    return (value as unknown[]).map(
        item => makeStorableArgs(item, replaceTransientStub, transientStubs, depth + 1));
  }

  // Recurse into plain objects.
  if (isPlainObject(value)) {
    let result: Record<string, unknown> = {};
    for (let key of Object.keys(value)) {
      result[key] = makeStorableArgs(
          value[key], replaceTransientStub, transientStubs, depth + 1);
    }
    return result;
  }

  // Everything else (primitives, Dates, Uint8Arrays, Fetchers, etc.) kept as-is.
  // TODO: Handle streams? Request? Response? Map? Set?
  return value;
}

/**
 * Produces a depth-limited summary string for callback args. Stubs and large content are
 * replaced with placeholders.
 */
export function summarizeArgs(args: unknown[]): string {
  return args.map((arg, i) => `[${i}]: ${summarizeValue(arg, 0)}`).join("\n");
}

// Summarize the content of params passed to an agent callback. This is presented to the agent
// in the chat log, but the agent can use executeCode to get access to the full value. If the
// value has a lot of data, we don't want to bloat the agent's context with it, but we also don't
// want to truncate too excessively as it forces the agent to perform round trips with
// executeCode.
// TODO: summarizeValue() can probably be optimized further. We also need to experiment with how
//   to best explain to the agent that it's seeing something truncated -- I've noticed the "..."
//   confuses it a bit.
function summarizeValue(value: unknown, depth: number): string {
  if (depth > 3) return "...";

  if (value === null) return "null";
  if (value === undefined) return "undefined";

  switch (typeof value) {
    case "string":
      if (value.length > 100) return JSON.stringify(value.slice(0, 100) + "...");
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
  }

  if (value instanceof NativeRpcStub) return "RpcStub";
  if (value instanceof Date) return `Date("${value.toISOString()}")`;
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;

  // TODO: Export ServiceStub from cloudflare:workers so we can represent it here. For now we
  //   guess that it's a stub if it has the constructor name "Fetcher".
  if (typeof value === "object" && value.constructor?.name === "Fetcher") {
    return "PersistentRpcStub";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    let maxItems = 30;
    let items = value.slice(0, maxItems).map(v => summarizeValue(v, depth + 1));
    if (value.length > maxItems) items.push(`...${value.length - maxItems} more`);
    return `[${items.join(", ")}]`;
  }

  if (isPlainObject(value)) {
    let keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    let maxKeys = 15;
    let entries = keys.slice(0, maxKeys).map(
        k => `${k}: ${summarizeValue(value[k], depth + 1)}`);
    if (keys.length > maxKeys) entries.push(`...${keys.length - maxKeys} more`);
    return `{${entries.join(", ")}}`;
  }

  // Other native objects
  if (typeof value === "object") return `${value.constructor?.name ?? "object"}`;

  return String(value);
}
