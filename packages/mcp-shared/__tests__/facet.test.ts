import { expect, it } from "vitest";

import { McpFacetBase } from "../src/facet.js";
import { McpSessionBase } from "../src/session.js";
import { classifyTool, type ClassifiedTool } from "../src/tools.js";
import type { ConnectionAccount } from "../src/connection.js";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";

const log = {
  debug() {}, info() {}, error() {},
  warnings: [] as string[],
  warn(message: string) { this.warnings.push(message); },
  with() { return this; },
};

class TestSession extends McpSessionBase {}

class TestFacet extends McpFacetBase<object, {
  endpoint: string;
  scope: {};
}, TestSession> {
  catalog: Promise<ClassifiedTool[]> = Promise.resolve([
    classifyTool({ name: "list_issues", annotations: { readOnlyHint: true } } as never),
    classifyTool({ name: "create_issue", description: "Files a new issue." } as never),
  ]);

  protected get log() { return log; }
  protected get sessionClass() { return TestSession; }
  protected get actionScopeTag() { return "test"; }
  protected get observerName() { return "the test server"; }
  protected account(): ConnectionAccount { throw new Error("not used"); }
  describe(): Promise<ResourceDescription> { throw new Error("not used"); }
  getTypeScriptTypes(): Promise<string> { throw new Error("not used"); }
  get serverName() { return "Test"; }
  override tools() { return this.catalog; }
}

function facet() {
  const ctx = {
    props: { endpoint: "https://example.com/mcp", scope: {} },
    storage: { kv: {} },
  };
  return new TestFacet(ctx as never, {});
}

const recorder = {
  dup() { return this; },
  authorizeObservation() {},
};

it("builds tool methods and falls back to the plain session when catalog loading fails", async () => {
  const subject = facet();
  const dynamic = await subject.startSession(recorder as never);
  expect("listIssues" in dynamic).toBe(true);

  subject.catalog = Promise.reject(new Error("offline"));
  const fallback = await subject.startSession(recorder as never);
  expect("listIssues" in fallback).toBe(false);
  expect(log.warnings).toContain("starting session without per-tool methods");
});

it("keeps facets owner-only using the connector's resource label", async () => {
  await expect(facet().addObserver("observer", {} as never))
    .rejects.toThrow(/test server.*only be opened by its owner/s);
});

it("declares a capability for every non-read tool, and none for a read", async () => {
  const catalog = await facet().getActionCatalog();
  expect(catalog).toHaveLength(1);
  expect(catalog[0]).toMatchObject({
    kind: { tag: "test:create_issue", label: "create_issue" },
    summary: "Files a new issue.",
  });
  // An arbitrary MCP tool describes no inverse operation and no audience, so the profile is the
  // honest floor rather than a guess.
  expect(catalog[0].risk).toEqual({
    reversible: "no", reach: "acts-on-world", audience: "external", freeform: true,
  });
});
