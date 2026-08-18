import { expect, it, vi } from "vitest";

import { McpProtocolError } from "../src/client.js";
import { McpSessionBase, type McpSessionHost } from "../src/session.js";
import { classifyTool } from "../src/tools.js";

const entry = classifyTool({ name: "jira_create_issue" });

function fakeHost(call: McpSessionHost["call"]): McpSessionHost {
  return {
    serverName: "Jira",
    endpoint: "https://mcp.example.com",
    scope: { serverId: "jira" },
    tools: async () => [entry],
    call,
    actionKindFor: () => ({ tag: "jira:create", label: "Create issue" }),
  } as unknown as McpSessionHost;
}

/** Records the outcome reported on the handle `authorizeAction` hands back. */
function fakeRecorder() {
  const outcomes: ({ state: "succeeded" } | { state: "failed"; mayHaveTakenEffect: boolean })[] = [];
  const recorder = {
    async authorizeObservation() {},
    async authorizeAction() {
      return {
        async succeeded() { outcomes.push({ state: "succeeded" }); },
        async failed(_error: string, mayHaveTakenEffect: boolean) {
          outcomes.push({ state: "failed", mayHaveTakenEffect });
        },
      };
    },
  };
  return { recorder: recorder as never, outcomes };
}

it("runs an action inline and returns the server's own result", async () => {
  const { recorder, outcomes } = fakeRecorder();
  const host = fakeHost(async fn => fn({
    callTool: async () => ({ content: [{ type: "text", text: "ISSUE-1" }] }),
  } as never));

  const result = await new McpSessionBase(host, recorder).callTool(entry.tool.name);

  expect(result).toMatchObject({ status: "ok", text: "ISSUE-1" });
  expect(outcomes).toEqual([{ state: "succeeded" }]);
});

it("never calls the tool when authorization refuses it", async () => {
  const callTool = vi.fn();
  const host = fakeHost(async fn => fn({ callTool } as never));
  const recorder = {
    async authorizeObservation() {},
    async authorizeAction() { throw new Error("An administrator disabled this action."); },
  } as never;

  await expect(new McpSessionBase(host, recorder).callTool(entry.tool.name))
    .rejects.toThrow(/administrator disabled/);
  expect(callTool).not.toHaveBeenCalled();
});

it("records a refused call as not having taken effect", async () => {
  const { recorder, outcomes } = fakeRecorder();
  const host = fakeHost(async () => {
    throw new McpProtocolError("Unauthorized.", 401, "declined");
  });

  await expect(new McpSessionBase(host, recorder).callTool(entry.tool.name))
    .rejects.toThrow(/Unauthorized/);
  expect(outcomes).toEqual([{ state: "failed", mayHaveTakenEffect: false }]);
});

it("records a call that failed after dispatch as possibly having taken effect", async () => {
  const { recorder, outcomes } = fakeRecorder();
  const host = fakeHost(async () => { throw new Error("connection reset"); });

  await expect(new McpSessionBase(host, recorder).callTool(entry.tool.name))
    .rejects.toThrow(/connection reset/);
  expect(outcomes).toEqual([{ state: "failed", mayHaveTakenEffect: true }]);
});

it("never retries a write on session expiry", async () => {
  const { recorder } = fakeRecorder();
  let options: unknown;
  const host = fakeHost(async (fn, opts) => {
    options = opts;
    return fn({ callTool: async () => ({ content: [] }) } as never);
  });

  await new McpSessionBase(host, recorder).callTool(entry.tool.name);

  expect(options).toEqual({ retryOnExpiry: false });
});
