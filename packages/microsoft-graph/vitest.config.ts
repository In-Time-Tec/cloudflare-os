import { defineConfig } from "vitest/config";

/** Pure unit tests with a mocked fetch; no Workers runtime needed. */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
  },
});
