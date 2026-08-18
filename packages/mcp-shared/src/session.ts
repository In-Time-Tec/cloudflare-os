// The capability a Gadget actually holds: one session over one MCP binding. Every tool call a Gadget
// can make arrives here, and the rules applied are the same for both connectors.
//
// What differs per connector is which server and how to reach it, which is what `McpSessionHost`
// supplies. The base never touches the Durable Object, the account, or the endpoint's credentials.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type { ActionKind, ActionRecorder } from "@gadgets/workshop-shared/gatekeeper";

import { callMayHaveTakenEffect, type McpClient } from "./client.js";
import type { WithClientOptions } from "./connection.js";
import { isWholeEndpoint, type ToolScope } from "./scope.js";
import { describeCall, toCallResult, toolInfo, type ClassifiedTool } from "./tools.js";
import type { McpCallResult, McpToolInfo } from "./types";

/**
 * What a session needs from the gatekeeper facet that owns it. Narrow: the session is handed to a
 * Gadget, so anything reachable from here is one `followPath` away from untrusted code.
 */
export interface McpSessionHost {
  readonly serverName: string;
  readonly endpoint: string;
  /** How much of the endpoint this binding may call. Only used to word the "no such tool" error. */
  readonly scope: ToolScope;

  tools(): Promise<ClassifiedTool[]>;

  /** Runs `fn` against an initialized client for this binding's endpoint. */
  call<T>(fn: (client: McpClient) => Promise<T>, options?: WithClientOptions): Promise<T>;

  /** The action kind for one tool, namespaced so policy cannot cross servers. */
  actionKindFor(toolName: string): ActionKind;
}

/**
 * The Gadget-facing session. A named method per tool is installed on a per-grant subclass (see
 * `session-methods.ts`), each a one-line delegate to `callTool`. Connectors subclass this and apply
 * `@validateRpc()` there, so the decorator is visible in the file that hands it to a Gadget.
 */
export class McpSessionBase extends RpcTarget {
  #host: McpSessionHost;
  #recorder: RpcStub<ActionRecorder>;

  constructor(host: McpSessionHost, recorder: RpcStub<ActionRecorder>) {
    super();
    this.#host = host;
    this.#recorder = recorder;
  }

  [Symbol.dispose](): void {
    (this.#recorder as RpcStub<ActionRecorder> & { [Symbol.dispose](): void })[Symbol.dispose]();
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools = await this.#host.tools();
    await this.#recorder.authorizeObservation({
      title: `${this.#host.serverName}: list tools`,
      description:
        `Read the tool catalog of the MCP server **${this.#host.serverName}** ` +
        `(\`${this.#host.endpoint}\`).`,
    });
    return tools.map(toolInfo);
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult> {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("callTool() requires a tool name.");
    }
    const toolArgs = args ?? {};
    if (typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
      throw new Error("callTool() arguments must be an object.");
    }

    const host = this.#host;
    const tools = await host.tools();
    const entry = tools.find(candidate => candidate.tool.name === name);
    if (!entry) {
      // Worded from the grant's point of view: on a scoped binding the tool may exist on the server,
      // and "no such tool" would send an agent looking for a typo.
      const available = tools.map(candidate => candidate.tool.name).join(", ");
      throw new Error(isWholeEndpoint(host.scope)
        ? `The MCP server "${host.serverName}" has no tool named "${name}". Available: ${available}`
        : `This binding grants only these tools: ${available}.`);
    }

    const described = describeCall({
      serverName: host.serverName,
      endpoint: host.endpoint,
      tool: entry.tool,
      toolArgs,
      mode: entry.mode,
      classifiedBy: entry.classifiedBy,
    });

    if (entry.mode === "read") {
      const result = await host.call(client => client.callTool(name, toolArgs));
      // Authorize before the data is handed back, per the gatekeeper contract.
      await this.#recorder.authorizeObservation(described);
      return toCallResult(result);
    }

    const handle = await this.#recorder.authorizeAction({
      ...described,
      actionKind: host.actionKindFor(name),
    });

    let result;
    try {
      // A write is never retried on session expiry: a fronting proxy can report one after the
      // upstream already accepted the call.
      result = await host.call(
        client => client.callTool(name, toolArgs), { retryOnExpiry: false });
    } catch (err) {
      // `callMayHaveTakenEffect` fails safe: anything it cannot positively identify as declined is
      // reported as possibly performed, since MCP offers no way to check or undo one.
      await handle.failed(
        err instanceof Error ? err.message : String(err), callMayHaveTakenEffect(err));
      throw err;
    }
    await handle.succeeded();
    return toCallResult(result);
  }
}
