import { describe, expect, it } from "vitest";
import {
  MAX_GATEKEEPER_APP_PROMPT_LENGTH,
  normalizeGatekeeperAppPrompt,
  parseGatekeeperAppThreadTarget,
} from "./gatekeeperAppNavigation";

const THREAD_ID = "a".repeat(64);

describe("parseGatekeeperAppThreadTarget", () => {
  it("accepts a thread ID with an optional gadget", () => {
    expect(parseGatekeeperAppThreadTarget(THREAD_ID, undefined)).toEqual({
      threadId: THREAD_ID,
    });
    expect(parseGatekeeperAppThreadTarget(THREAD_ID, 0)).toEqual({
      threadId: THREAD_ID,
      gadgetId: 0,
    });
  });

  it.each([
    ["", undefined],
    ["../admin", undefined],
    [THREAD_ID.toUpperCase(), undefined],
    [`${THREAD_ID}a`, undefined],
    [THREAD_ID, -1],
    [THREAD_ID, 1.5],
    [THREAD_ID, 9_007_199_254_740_992],
    [THREAD_ID, "1"],
  ])("rejects (%s, %s)", (threadId, gadgetId) => {
    expect(() => parseGatekeeperAppThreadTarget(threadId, gadgetId)).toThrow(
      "Invalid gatekeeper app thread target",
    );
  });
});

describe("normalizeGatekeeperAppPrompt", () => {
  it("trims a bounded visible prompt", () => {
    expect(normalizeGatekeeperAppPrompt("  Set up a daily brief.  ")).toBe("Set up a daily brief.");
  });

  it("rejects empty and oversized prompts", () => {
    expect(() => normalizeGatekeeperAppPrompt("   ")).toThrow("cannot be empty");
    expect(() =>
      normalizeGatekeeperAppPrompt("x".repeat(MAX_GATEKEEPER_APP_PROMPT_LENGTH + 1)),
    ).toThrow("too long");
  });
});
