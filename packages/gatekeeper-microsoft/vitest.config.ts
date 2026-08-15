import { defineConfig } from "vitest/config";

/** Pure unit tests of the ID-token claim validation; no Workers runtime needed. */
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
  },
});
