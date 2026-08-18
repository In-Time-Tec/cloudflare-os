import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_GROUPS } from "../src/capabilities.js";
import { SUPPORTED_RESOURCES } from "../src/resources.js";

describe("capability catalog", () => {
  it("gives every capability a group that exists", () => {
    const groupIds = new Set(CAPABILITY_GROUPS.map(group => group.id));
    for (const capability of CAPABILITIES) {
      expect(groupIds, capability.tag).toContain(capability.group);
    }
  });

  it("ties every group to a resource the vendor actually offers", () => {
    const patterns = new Set(SUPPORTED_RESOURCES.map(resource => resource.urlPattern));
    for (const group of CAPABILITY_GROUPS) {
      expect(group.resourceUrlPattern, group.id).toBeDefined();
      expect(patterns, group.id).toContain(group.resourceUrlPattern!);
    }
  });

  it("uses unique tags", () => {
    const tags = CAPABILITIES.map(capability => capability.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("offers a read capability in every group, so reads are grantable everywhere", () => {
    for (const group of CAPABILITY_GROUPS) {
      const reads = CAPABILITIES.filter(c => c.group === group.id && c.mode === "read");
      expect(reads.length, group.id).toBeGreaterThan(0);
    }
  });

  it("gives every write a risk profile and no read one", () => {
    for (const capability of CAPABILITIES) {
      if (capability.mode === "write") expect(capability.risk, capability.tag).toBeDefined();
      else expect(capability.risk, capability.tag).toBeUndefined();
    }
  });
});
