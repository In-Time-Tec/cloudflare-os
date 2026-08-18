// The trust boundary: what an MCP server says about its own tools becomes what a Gadget may do.
// Nothing outside this file reads a tool's `annotations`.

import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { McpContentBlock, McpTool, McpToolCallResult } from "./client.js";
import type { McpCallResult, McpToolInfo } from "./types";
import { hexEncode } from "./util.js";

/** Which side decided a tool's read/action classification. */
export type ClassificationSource = "server-annotation" | "default";

/** Upper bound on tools taken from one endpoint, to keep generated types and catalogs bounded. */
export const MAX_TOOLS_PER_SERVER = 200;

/** A tool plus the decisions this gatekeeper has made about it. */
export type ClassifiedTool = {
  tool: McpTool;
  /**
   * `read` runs immediately and is recorded as an observation; `action` is authorized against the
   * deployment's policy, then run, and recorded with its outcome.
   */
  mode: "read" | "action";
  /**
   * Whose word `mode` rests on. Recorded rather than re-derived, so no consumer can answer it
   * differently from the classifier that did.
   */
  classifiedBy: ClassificationSource;
};

// Whether the server declares this tool read-only. Strictly `=== true`, matching the spec's own
// default of `false`, so an absent annotation is not a read.
function isDeclaredReadOnly(tool: McpTool): boolean {
  return tool.annotations?.readOnlyHint === true;
}

/**
 * The single place a server's self-description becomes a policy decision.
 *
 * `readOnlyHint` is the one claim a server gets to make about itself, and it decides only whether
 * a call is recorded as an observation or as an action carrying that tool's action kind. That is a
 * tradeoff, not a free win: a tool the server mislabels is logged as a read of the world rather
 * than a change to it. It is accepted because a read that must be justified as an action is a
 * connector nobody can use, and because the owner chose to connect the server.
 *
 * The test is `=== true` rather than a truthiness check, matching the spec's own default of
 * `false`, so an unannotated tool comes out as an action.
 */
export function classifyTool(tool: McpTool): ClassifiedTool {
  const readOnly = isDeclaredReadOnly(tool);
  return {
    tool,
    mode: readOnly ? "read" : "action",
    classifiedBy: readOnly ? "server-annotation" : "default",
  };
}

/**
 * The tool as a Gadget sees it. `classifiedBy` is carried through so an audit can find every call
 * that was trusted on the server's word.
 */
export function toolInfo(entry: ClassifiedTool): McpToolInfo {
  return {
    name: entry.tool.name,
    title: entry.tool.title,
    description: entry.tool.description,
    mode: entry.mode,
    classifiedBy: entry.classifiedBy,
    inputSchema: entry.tool.inputSchema,
  };
}

/**
 * The policy identity of one tool on one binding: the kind every call to it is recorded under, and
 * the unit an administrator disables. `scopeTag` is caller-supplied so that two connectors using
 * the same binding id cannot share one kind.
 */
export function actionKindFor(scopeTag: string, toolName: string): ActionKind {
  return { tag: `${encodeURIComponent(scopeTag)}:${encodeURIComponent(toolName)}`, label: toolName };
}

/**
 * Stable fingerprint of a tool catalog, for detecting that an endpoint changed under us.
 *
 * Covers each tool's name and its read/action classification, which is everything a grant was
 * decided against. Descriptions are excluded so that copy edits do not fire the signal.
 */
export async function catalogRevision(tools: McpTool[]): Promise<string> {
  const canonical = tools
    .map(tool => `${tool.name}\u0000${isDeclaredReadOnly(tool) ? "r" : "w"}`)
    .toSorted()
    .join("\u0001");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return hexEncode(new Uint8Array(digest)).slice(0, 16);
}

/** Flattens tool content into the shape a Gadget sees. */
export function toCallResult(
  result: McpToolCallResult,
): Extract<McpCallResult, { status: "ok" }> {
  const content = (result.content ?? []) as McpContentBlock[];
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n");
  return {
    status: "ok",
    content: content as Extract<McpCallResult, { status: "ok" }>["content"],
    text,
    structuredContent: result.structuredContent,
    isError: result.isError,
  };
}

// Longest server-supplied tool description reproduced in an activity-log entry.
const MAX_DESCRIPTION = 600;

// Longest rendering of a tool call's arguments reproduced in an activity-log entry.
const MAX_ARGUMENTS = 4000;

// Neutralizes Markdown fences in text about to be placed inside one. Without it a value can close
// the fence and continue in the log entry's own voice.
function defuseFences(text: string): string {
  return text.replace(/`{3,}/g, "'''");
}

// Renders untrusted server text safely inside the activity-log entry. Left alone, a tool
// description can write its own "Endpoint:" line and speak in the record's voice to whoever audits
// the workspace, so fences and headings are neutralized, the text is capped, and the rest is
// block-quoted.
function quoteUntrusted(text: string, max: number): string {
  const cleaned = defuseFences(text)
    // Repeated, since one strip leaves `##` as `#` -- still a heading, at heading weight, in the
    // entry a human reads.
    .replace(/^[ \t]*[#>]+[ \t]*/gm, "")
    .trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}\u2026` : cleaned;
  return clipped.split("\n").map(line => `> ${line}`).join("\n");
}

// Renders server-chosen text inside a Markdown code span.
//
// Tool names and endpoints are placed in backticks so a reader sees them exactly as sent, but a
// name is as server-controlled as a description: one containing a backtick closes the span and
// everything after it becomes prose the server wrote in the record's own voice. Backticks are
// dropped and the text is flattened, so what is shown cannot be more than one inline span.
function codeSpan(text: string, max = MAX_INLINE_TEXT): string {
  const cleaned = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}\u2026` : cleaned;
  return `\`${clipped || "(unnamed)"}\``;
}

// Longest server-chosen name or endpoint shown inline in a log entry.
const MAX_INLINE_TEXT = 120;

// Renders server-chosen text as inline prose, with the characters that would let it forge structure
// removed. `account.ts` already does this to a server's reported name before storing it; this is
// the same guard at the point of use, for the callers that pass a name from somewhere else.
function plainInline(text: string, max = MAX_INLINE_TEXT): string {
  const cleaned = text.replace(/[`*_[\]()#>|]/g, "").replace(/\s+/g, " ").trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}\u2026` : cleaned;
  return clipped || "(unnamed)";
}

/**
 * Renders a tool call as the Markdown recorded in the workspace's activity log. Every field in it
 * is written by the MCP server or by the agent, and a human reads the result, so all of it goes
 * through the hardening above.
 */
export function describeCall(args: {
  serverName: string;
  endpoint: string;
  tool: McpTool;
  toolArgs: Record<string, unknown>;
  mode: "read" | "action";
  classifiedBy: ClassificationSource;
}): { title: string; description: string } {
  // The arguments are the agent's text, and the agent is who this record is about, so they get the
  // same treatment as the server's description. `JSON.stringify` escapes quotes and backslashes but
  // not backticks.
  let rendered: string;
  try {
    rendered = defuseFences(JSON.stringify(args.toolArgs, null, 2));
  } catch {
    rendered = "(arguments could not be displayed)";
  }
  if (rendered.length > MAX_ARGUMENTS) {
    rendered = `${rendered.slice(0, MAX_ARGUMENTS)}\n... (truncated)`;
  }

  const provenance = args.mode === "read"
    ? args.classifiedBy === "server-annotation"
      ? "Recorded as an observation because the server declares this tool read-only. That claim " +
        "comes from the server itself."
      : "Treated as read-only by this deployment."
    : "Recorded as an action because the server did not declare it read-only.";

  const description = [
    `**${plainInline(args.serverName)}** \u2192 ${codeSpan(args.tool.name)}`,
    "",
    args.tool.description
      ? quoteUntrusted(args.tool.description, MAX_DESCRIPTION)
      : "_The server provided no description for this tool._",
    "",
    "Arguments:",
    "```json",
    rendered,
    "```",
    "",
    `Endpoint: ${codeSpan(args.endpoint)}`,
    "",
    provenance,
  ].join("\n");

  // The title is plain text rather than Markdown, but it is server-chosen and appears in the
  // activity list, so it gets the same flattening and cap.
  return {
    title: `${plainInline(args.serverName)}: ${plainInline(args.tool.name)}`,
    description,
  };
}
