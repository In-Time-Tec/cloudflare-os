export const MAX_GATEKEEPER_APP_PROMPT_LENGTH = 4_000;

// A Durable Object ID string, which is what a thread ID is.
const THREAD_ID_PATTERN = /^[0-9a-f]{64}$/;

export type GatekeeperAppThreadTarget = { threadId: string; gadgetId?: number };

/**
 * Validates a thread target arriving from a sandboxed gatekeeper app before the host navigates
 * to it. The app is untrusted input, so the shape is checked here rather than at the router.
 */
export function parseGatekeeperAppThreadTarget(
  threadId: unknown,
  gadgetId: unknown,
): GatekeeperAppThreadTarget {
  if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) {
    throw new TypeError("Invalid gatekeeper app thread target.");
  }
  if (gadgetId === undefined) return { threadId };
  if (typeof gadgetId !== "number" || !Number.isSafeInteger(gadgetId) || gadgetId < 0) {
    throw new TypeError("Invalid gatekeeper app thread target.");
  }
  return { threadId, gadgetId };
}

export function normalizeGatekeeperAppPrompt(value: string): string {
  if (typeof value !== "string") throw new TypeError("Gatekeeper app prompt must be text.");
  const prompt = value.trim();
  if (!prompt) throw new TypeError("Gatekeeper app prompt cannot be empty.");
  if (prompt.length > MAX_GATEKEEPER_APP_PROMPT_LENGTH) {
    throw new RangeError("Gatekeeper app prompt is too long.");
  }
  return prompt;
}
