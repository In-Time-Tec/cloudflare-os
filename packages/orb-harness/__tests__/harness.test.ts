import { describe, expect, it } from "vitest";
import { executeShell } from "../src/execute-shell.js";
import { HarnessAgentHooks } from "../src/hooks-adapter.js";
import type { OrbTurnRecord } from "@gadgets/workshop-shared/orb-harness";

describe("executeShell", () => {
  it("runs a command and captures stdout", async () => {
    const result = await executeShell("printf hello", 5_000);
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("streams output deltas", async () => {
    const deltas: string[] = [];
    await executeShell("printf abc", 5_000, (delta) => { deltas.push(delta); });
    expect(deltas.join("")).toBe("abc");
  });
});

describe("HarnessAgentHooks", () => {
  const turn = {
    turnId: "t1",
    chatId: 1,
    model: { id: "x", name: "x", api: "openai-completions", provider: "openai",
      baseUrl: "https://example", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000, maxTokens: 100 } as OrbTurnRecord["model"],
    codeDoc: { update: new Uint8Array(), version: 1 },
    grantJwt: "jwt",
    chatMessages: [],
    author: { type: "user", id: "u", name: "U" },
    initiator: { type: "user", id: "u", name: "U" },
    callbackInitiated: false,
    compaction: { modelConfig: { provider: "openai", model: "x", apiToken: "" }, measuredTokens: 0 },
    agentContext: { chatId: 1 },
    artifactInfos: [{
      id: 7, title: "App", rootName: "7", isDefault: true, bindings: [],
    }],
    modelData: [],
    stopAfterCompaction: false,
  } as unknown as OrbTurnRecord;

  it("resolves the default workpiece locally", () => {
    const hooks = new HarnessAgentHooks({} as never, turn);
    expect(hooks.resolveWorkpieceRoot()).toEqual({ workpieceId: 7, rootName: "7" });
  });

  it("appends artifacts created through the remote", async () => {
    const remote = {
      createArtifact: async () => ({ id: 8, title: "New" }),
    };
    const hooks = new HarnessAgentHooks(remote as never, turn);
    await hooks.createArtifact("New", "newGadget", 1);
    expect(hooks.listArtifactInfo(1).map((a) => a.id)).toEqual([7, 8]);
  });

  it("awaits the remote addChatMessages promise", async () => {
    let resolved = false;
    const remote = {
      addChatMessages: async () => {
        await Promise.resolve();
        resolved = true;
      },
    };
    const hooks = new HarnessAgentHooks(remote as never, turn);
    await hooks.addChatMessages(1, turn.author, []);
    expect(resolved).toBe(true);
  });
});
