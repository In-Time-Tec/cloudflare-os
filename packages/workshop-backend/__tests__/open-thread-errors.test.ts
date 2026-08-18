import { describe, expect, it } from "vitest";
import {
  createOpenThreadError,
  getOpenThreadErrorCode,
  OPEN_THREAD_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

describe("open artifact errors", () => {
  it.each([
    [OPEN_THREAD_ERROR_CODES.threadNotFound, "Thread not found."],
    [OPEN_THREAD_ERROR_CODES.threadAccessDenied, "You don't have access to this thread."],
  ] as const)(
    "creates an enumerable %s code with a readable message",
    (code, message) => {
      let error = createOpenThreadError(code);

      expect(error.message).toBe(message);
      expect(error.code).toBe(code);
      expect(Object.keys(error)).toContain("code");
      expect(getOpenThreadErrorCode(error)).toBe(code);
    },
  );

  it.each(Object.values(OPEN_THREAD_ERROR_CODES))(
    "does not infer %s from an error message",
    (code) => {
      expect(getOpenThreadErrorCode(new Error(code))).toBeUndefined();
    },
  );

  it("does not classify unexpected errors", () => {
    expect(getOpenThreadErrorCode(new Error("storage unavailable"))).toBeUndefined();
    expect(getOpenThreadErrorCode({ code: "UNKNOWN" })).toBeUndefined();
  });
});
