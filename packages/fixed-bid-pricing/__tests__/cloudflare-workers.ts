export const DurableObject = class {
  /** Keep the test replacement structurally class-like without emulating Worker behavior. */
  testRuntime(): true {
    return true;
  }
};
