import { describe, expect, it } from "vitest";
import { Gadget } from "../gadget/server.js";

function makeGadget() {
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      values.set(key, structuredClone(value));
    },
  };
  return new Gadget({ storage }, {});
}

describe("fixed-bid Gadget server", () => {
  it("previews an agent proposal without applying it until a user approval", async () => {
    const gadget = makeGadget();
    const initial = await gadget.getEstimate();

    const proposal = await gadget.proposeChanges({
      expectedRevision: initial.revision,
      summary: "Name the engagement",
      operations: [{ type: "setProject", patch: { name: "Migration program" } }],
    });

    expect((await gadget.getEstimate()).estimate.project.name)
      .toBe("New fixed-bid engagement");
    const approved = await gadget.approveProposal({ id: proposal.id });
    expect(approved.estimate.project.name).toBe("Migration program");
    expect(approved.revision).toBe(initial.revision + 1);
    expect(approved.proposals).toHaveLength(0);
  });

  it("rejects a stale agent proposal after a concurrent manual revision", async () => {
    const gadget = makeGadget();
    const initial = await gadget.getEstimate();
    const proposal = await gadget.proposeChanges({
      expectedRevision: initial.revision,
      summary: "Name the engagement",
      operations: [{ type: "setProject", patch: { name: "Migration program" } }],
    });

    await gadget.updateEstimate({
      expectedRevision: initial.revision,
      estimate: {
        ...initial.estimate,
        project: { ...initial.estimate.project, customer: "Customer" },
      },
      summary: "Added customer",
    });

    await expect(gadget.approveProposal({ id: proposal.id }))
      .rejects.toThrow("review it again against revision");
    expect((await gadget.getEstimate()).estimate.project.name)
      .toBe("New fixed-bid engagement");
  });
});
