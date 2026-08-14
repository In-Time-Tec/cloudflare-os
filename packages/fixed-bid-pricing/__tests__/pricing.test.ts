import { describe, expect, it } from "vitest";
import {
  CURRENT_PRICING_POLICY,
  applyEstimateOperations,
  assertEstimateTransition,
  calculateEstimate,
  createEstimateDocument,
  normalizeEstimateDocument,
} from "../src/pricing.js";

function productionMigration() {
  const estimate = createEstimateDocument();
  estimate.project.engagementClass = "productionTransformation";
  estimate.project.deliveryWeeks = 13;
  estimate.pillars.speed.score = 3;
  estimate.pillars.complexity.score = 5;
  estimate.pillars.experience.score = 2;
  estimate.pillars.expertise.score = 4;
  estimate.pillars.risk.score = 5;
  estimate.pillars.teamComposition.score = 2;
  estimate.workstreams = [
    { id: "architecture", name: "Architecture", description: "", lowHours: 80, likelyHours: 120, highHours: 180 },
    { id: "migration", name: "Migration", description: "", lowHours: 430, likelyHours: 560, highHours: 760 },
    { id: "cutover", name: "Cutover", description: "", lowHours: 90, likelyHours: 150, highHours: 250 },
  ];
  estimate.risks = [{
    id: "external-dependency",
    description: "External system readiness",
    probabilityPct: 35,
    impactCost: 40_000,
    mitigation: "Prove access and throughput during discovery",
    mitigationEffectivenessPct: 40,
    owner: "Delivery lead",
  }];
  estimate.terms.acceptanceCriteria = ["Cutover succeeds against agreed reconciliation checks"];
  return estimate;
}

describe("fixed-bid pricing", () => {
  it("prices a production transformation above the engagement credibility minimum", () => {
    const calculation = calculateEstimate(productionMigration());

    expect(calculation.scenarios.p50.price).toBeGreaterThanOrEqual(125_000);
    expect(calculation.recommendedPrice).toBeGreaterThan(calculation.scenarios.p50.price);
    expect(calculation.scenarios.p90.price).toBeGreaterThan(calculation.recommendedPrice);
    expect(calculation.riskReserve).toBeGreaterThan(0);
  });

  it("uses delivery experience to widen confidence rather than inflate expected effort", () => {
    const experienced = productionMigration();
    experienced.pillars.experience.score = 5;
    const unfamiliar = structuredClone(experienced);
    unfamiliar.pillars.experience.score = 1;

    const experiencedResult = calculateEstimate(experienced);
    const unfamiliarResult = calculateEstimate(unfamiliar);

    expect(unfamiliarResult.scenarios.p50.effortHours)
      .toBe(experiencedResult.scenarios.p50.effortHours);
    expect(unfamiliarResult.scenarios.p90.effortHours)
      .toBeGreaterThan(experiencedResult.scenarios.p90.effortHours);
  });

  it("requires discovery and rejects extreme uncertainty as a direct fixed bid", () => {
    const estimate = productionMigration();
    estimate.pillars.experience.score = 1;
    estimate.terms.acceptanceCriteria = [];

    const calculation = calculateEstimate(estimate);

    expect(calculation.fixedBidEligible).toBe(false);
    expect(calculation.discoveryRequired).toBe(true);
    expect(calculation.approvals.map((approval) => approval.code))
      .toContain("paid-discovery-required");
  });

  it("raises approval when a one-off price falls below sustainable and market floors", () => {
    const estimate = productionMigration();
    estimate.project.proposedPrice = 40_000;

    const calculation = calculateEstimate(estimate);
    const codes = calculation.approvals.map((approval) => approval.code);

    expect(codes).toContain("below-sustainable-floor");
    expect(codes).toContain("below-market-floor");
    expect(calculation.estimatedGrossMarginPct).toBeLessThan(0);
  });

  it("uses inflation-adjusted close comparables as a credibility floor", () => {
    const estimate = productionMigration();
    estimate.comparables = [
      {
        id: "close-one",
        name: "Close production migration",
        referencePrice: 200_000,
        referenceDate: CURRENT_PRICING_POLICY.laborEconomicsBaseDate,
        similarityScore: 5,
        notes: "Same delivery obligation",
      },
      {
        id: "close-two",
        name: "Comparable modernization",
        referencePrice: 250_000,
        referenceDate: CURRENT_PRICING_POLICY.laborEconomicsBaseDate,
        similarityScore: 4,
        notes: "Similar systems and acceptance risk",
      },
      {
        id: "distant",
        name: "Distant reference",
        referencePrice: 1_000_000,
        referenceDate: CURRENT_PRICING_POLICY.laborEconomicsBaseDate,
        similarityScore: 3,
        notes: "Not close enough to affect pricing",
      },
    ];

    const calculation = calculateEstimate(estimate);
    expect(calculation.closeComparableMedian).toBe(225_000);
    expect(calculation.closeComparableFloor).toBe(180_000);
    expect(calculation.recommendedPrice).toBeGreaterThanOrEqual(180_000);

    estimate.project.proposedPrice = 150_000;
    expect(calculateEstimate(estimate).approvals.map(({ code }) => code))
      .toContain("below-close-comparables");
  });

  it("escalates labor economics for future delivery dates", () => {
    const current = productionMigration();
    current.project.startDate = CURRENT_PRICING_POLICY.laborEconomicsBaseDate;
    const future = structuredClone(current);
    future.project.startDate = "2028-07-01";

    expect(calculateEstimate(future).escalationFactor)
      .toBeGreaterThan(calculateEstimate(current).escalationFactor);
  });

  it("applies typed agent proposals without mutating the current estimate", () => {
    const current = createEstimateDocument();
    const next = applyEstimateOperations(current, [
      {
        type: "upsertWorkstream",
        workstream: {
          id: "discovery",
          name: "Discovery",
          description: "Retire integration uncertainty",
          lowHours: 40,
          likelyHours: 60,
          highHours: 100,
        },
      },
      { type: "setPillars", patch: { complexity: { score: 4, evidence: "Three integrations" } } },
      {
        type: "setComparables",
        comparables: [{
          id: "analog",
          name: "Close analog",
          referencePrice: 100_000,
          referenceDate: "2026-01-01",
          similarityScore: 4,
          notes: "Similar scope",
        }],
      },
    ]);

    expect(current.workstreams).toHaveLength(0);
    expect(next.workstreams).toHaveLength(1);
    expect(next.comparables).toHaveLength(1);
    expect(next.pillars.complexity).toEqual({ score: 4, evidence: "Three integrations" });
  });

  it("normalizes malformed estimate input at the ownership boundary", () => {
    const estimate = normalizeEstimateDocument({
      project: { targetMarginPct: 500 },
      workstreams: [{ lowHours: 100, likelyHours: 20, highHours: 5 }],
      team: [{ roleId: "not-a-role", allocationPct: 100 }],
    });

    expect(estimate.project.targetMarginPct).toBe(80);
    expect(estimate.workstreams[0].likelyHours).toBe(100);
    expect(estimate.workstreams[0].highHours).toBe(100);
    expect(estimate.team).toHaveLength(0);
  });

  it("enforces the draft, approved, and signed commercial lifecycle", () => {
    const draft = createEstimateDocument();
    draft.workstreams = [{
      id: "delivery",
      name: "Delivery",
      description: "",
      lowHours: 100,
      likelyHours: 110,
      highHours: 120,
    }];
    draft.terms.acceptanceCriteria = ["Agreed acceptance test passes"];
    draft.pillars.complexity.score = 2;
    draft.pillars.experience.score = 4;
    draft.pillars.risk.score = 2;

    const approved = structuredClone(draft);
    approved.commercialStatus = "approved";
    expect(() => assertEstimateTransition(draft, approved)).not.toThrow();

    const editedWhileApproved = structuredClone(approved);
    editedWhileApproved.project.proposedPrice = 50_000;
    expect(() => assertEstimateTransition(approved, editedWhileApproved))
      .toThrow("Reopen the approved estimate");

    const signed = structuredClone(approved);
    signed.commercialStatus = "signed";
    expect(() => assertEstimateTransition(approved, signed)).not.toThrow();

    const actuals = structuredClone(signed);
    actuals.actuals.actualHours = 125;
    expect(() => assertEstimateTransition(signed, actuals)).not.toThrow();

    const reopened = structuredClone(signed);
    reopened.commercialStatus = "draft";
    expect(() => assertEstimateTransition(signed, reopened)).toThrow("cannot be reopened");
  });

  it("does not allow an estimate with open delivery gates to be approved", () => {
    const draft = createEstimateDocument();
    const approved = structuredClone(draft);
    approved.commercialStatus = "approved";

    expect(() => assertEstimateTransition(draft, approved))
      .toThrow("eligibility gate");
  });
});
