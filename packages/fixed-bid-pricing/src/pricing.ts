/** The six company pricing pillars. */
export type PillarKey =
  | "speed"
  | "complexity"
  | "experience"
  | "expertise"
  | "risk"
  | "teamComposition";

/** A deliberately small ordinal score used by every pricing pillar. */
export type PillarScore = 1 | 2 | 3 | 4 | 5;

/** The commercial class used to choose a minimum credible engagement price. */
export type EngagementClass =
  | "proofOfConcept"
  | "focusedDelivery"
  | "productionTransformation"
  | "regulatedOrCritical";

/** One scored pillar and the evidence supporting the score. */
export type PillarAssessment = {
  score: PillarScore;
  evidence: string;
};

/** A three-point estimate for one customer-visible workstream. */
export type Workstream = {
  id: string;
  name: string;
  description: string;
  lowHours: number;
  likelyHours: number;
  highHours: number;
};

/** A role's percentage of the delivery effort. */
export type TeamAllocation = {
  roleId: string;
  allocationPct: number;
  rationale: string;
};

/** A non-labor cost that must be recovered by the engagement. */
export type ThirdPartyCost = {
  id: string;
  name: string;
  amount: number;
};

/** A normalized historical or market reference used only when it closely matches the engagement. */
export type ComparableEngagement = {
  id: string;
  name: string;
  referencePrice: number;
  referenceDate: string;
  similarityScore: PillarScore;
  notes: string;
};

/** One quantified residual risk retained by the vendor. */
export type EstimateRisk = {
  id: string;
  description: string;
  probabilityPct: number;
  impactCost: number;
  mitigation: string;
  mitigationEffectivenessPct: number;
  owner: string;
};

/** The complete durable estimate edited by people and proposed to by agents. */
export type EstimateDocument = {
  policyVersion: string;
  commercialStatus: "draft" | "approved" | "signed";
  project: {
    name: string;
    customer: string;
    engagementClass: EngagementClass;
    startDate: string;
    deliveryWeeks: number;
    targetMarginPct: number;
    proposedPrice: number | null;
  };
  pillars: Record<PillarKey, PillarAssessment>;
  workstreams: Workstream[];
  team: TeamAllocation[];
  thirdPartyCosts: ThirdPartyCost[];
  comparables: ComparableEngagement[];
  risks: EstimateRisk[];
  terms: {
    assumptions: string[];
    exclusions: string[];
    dependencies: string[];
    acceptanceCriteria: string[];
    paymentTerms: string;
    changeControl: string;
    warrantyWeeks: number;
  };
  actuals: {
    status: "notStarted" | "inProgress" | "won" | "lost" | "completed";
    contractedPrice: number | null;
    actualHours: number | null;
    actualCost: number | null;
    warrantyCost: number | null;
    outcomeNotes: string;
  };
};

type RolePolicy = {
  id: string;
  label: string;
  internalCostPerHour: number;
  marketRatePerHour: number;
};

/** Versioned commercial policy compiled into the Template. */
export type PricingPolicy = {
  version: string;
  effectiveDate: string;
  calibrationStatus: "initial" | "calibrated";
  targetMarginPct: number;
  minimumMarginPct: number;
  laborEconomicsBaseDate: string;
  annualLaborEscalationPct: number;
  roles: RolePolicy[];
  engagementMinimums: Record<EngagementClass, number>;
  speedCostFactors: readonly number[];
  complexityUncertaintyFactors: readonly number[];
  experienceUncertaintyFactors: readonly number[];
  expertiseMarketFactors: readonly number[];
  riskReserveFloorPcts: readonly number[];
  teamUncertaintyFactors: readonly number[];
  marketCredibilityRatio: number;
  closeComparableFloorRatio: number;
  includedWarrantyWeeks: number;
  baseWarrantyReservePct: number;
  extraWarrantyReservePctPerWeek: number;
};

/** A typed mutation that an agent can propose and the UI can preview before applying. */
export type EstimateOperation =
  | { type: "setProject"; patch: Partial<EstimateDocument["project"]> }
  | { type: "setPillars"; patch: Partial<Record<PillarKey, Partial<PillarAssessment>>> }
  | { type: "upsertWorkstream"; workstream: Workstream }
  | { type: "removeWorkstream"; id: string }
  | { type: "setTeam"; team: TeamAllocation[] }
  | { type: "setThirdPartyCosts"; costs: ThirdPartyCost[] }
  | { type: "setComparables"; comparables: ComparableEngagement[] }
  | { type: "upsertRisk"; risk: EstimateRisk }
  | { type: "removeRisk"; id: string }
  | { type: "setTerms"; patch: Partial<EstimateDocument["terms"]> }
  | { type: "setActuals"; patch: Partial<EstimateDocument["actuals"]> };

/** A calculated confidence scenario. */
export type PricingScenario = {
  effortHours: number;
  deliveryCost: number;
  marketReference: number;
  price: number;
};

/** A required review raised by deterministic pricing policy. */
export type PricingApproval = {
  code: string;
  message: string;
};

/** All deterministic outputs presented to the estimator and agent. */
export type PricingCalculation = {
  policyVersion: string;
  escalationFactor: number;
  scenarios: {
    p50: PricingScenario;
    p80: PricingScenario;
    p90: PricingScenario;
  };
  recommendedPrice: number;
  selectedPrice: number;
  minimumSustainablePrice: number;
  marketCredibilityFloor: number;
  closeComparableMedian: number | null;
  closeComparableFloor: number | null;
  engagementMinimum: number;
  riskReserve: number;
  explicitRiskReserve: number;
  warrantyReserve: number;
  estimatedGrossMarginPct: number;
  uncertaintyFactor: number;
  fixedBidEligible: boolean;
  ineligibilityReasons: string[];
  discoveryRequired: boolean;
  discoveryReasons: string[];
  approvals: PricingApproval[];
  drivers: string[];
  backtest: {
    realizedMarginPct: number | null;
    effortVariancePct: number | null;
  };
};

const PILLAR_KEYS: PillarKey[] = [
  "speed",
  "complexity",
  "experience",
  "expertise",
  "risk",
  "teamComposition",
];

const ENGAGEMENT_CLASSES: EngagementClass[] = [
  "proofOfConcept",
  "focusedDelivery",
  "productionTransformation",
  "regulatedOrCritical",
];

/**
 * Initial policy derived from public compensation and contract-rate benchmarks. It is intentionally
 * marked initial until company actuals can calibrate costs, overruns, realized margin, and outcomes.
 */
export const CURRENT_PRICING_POLICY: PricingPolicy = {
  version: "itt-fixed-bid-2026.1",
  effectiveDate: "2026-08-14",
  calibrationStatus: "initial",
  targetMarginPct: 35,
  minimumMarginPct: 30,
  laborEconomicsBaseDate: "2026-07-01",
  annualLaborEscalationPct: 2.95,
  roles: [
    { id: "deliveryEngineer", label: "Delivery engineer", internalCostPerHour: 72, marketRatePerHour: 121 },
    { id: "seniorEngineer", label: "Senior engineer / lead", internalCostPerHour: 98, marketRatePerHour: 158 },
    { id: "dataEngineer", label: "Data engineer", internalCostPerHour: 90, marketRatePerHour: 146 },
    { id: "solutionArchitect", label: "Solution architect", internalCostPerHour: 125, marketRatePerHour: 182 },
    { id: "projectManager", label: "Project manager / BA", internalCostPerHour: 85, marketRatePerHour: 147 },
    { id: "qualityEngineer", label: "Quality engineer", internalCostPerHour: 65, marketRatePerHour: 108 },
    { id: "securityEngineer", label: "Security engineer", internalCostPerHour: 110, marketRatePerHour: 154 },
    { id: "productDesigner", label: "Product designer", internalCostPerHour: 80, marketRatePerHour: 130 },
  ],
  engagementMinimums: {
    proofOfConcept: 35_000,
    focusedDelivery: 75_000,
    productionTransformation: 125_000,
    regulatedOrCritical: 200_000,
  },
  speedCostFactors: [1, 1.03, 1.08, 1.15, 1.25],
  complexityUncertaintyFactors: [0.75, 0.9, 1.05, 1.25, 1.5],
  experienceUncertaintyFactors: [1.45, 1.2, 1, 0.85, 0.75],
  expertiseMarketFactors: [0.95, 1, 1.08, 1.16, 1.25],
  riskReserveFloorPcts: [3, 6, 10, 15, 22],
  teamUncertaintyFactors: [1.35, 1.15, 1, 0.9, 0.85],
  marketCredibilityRatio: 0.9,
  closeComparableFloorRatio: 0.8,
  includedWarrantyWeeks: 2,
  baseWarrantyReservePct: 4,
  extraWarrantyReservePctPerWeek: 1,
};

const DEFAULT_PILLARS: Record<PillarKey, PillarAssessment> = {
  speed: { score: 3, evidence: "" },
  complexity: { score: 3, evidence: "" },
  experience: { score: 3, evidence: "" },
  expertise: { score: 3, evidence: "" },
  risk: { score: 3, evidence: "" },
  teamComposition: { score: 3, evidence: "" },
};

const DEFAULT_TEAM: TeamAllocation[] = [
  { roleId: "seniorEngineer", allocationPct: 35, rationale: "Technical delivery and leadership" },
  { roleId: "deliveryEngineer", allocationPct: 35, rationale: "Implementation" },
  { roleId: "projectManager", allocationPct: 10, rationale: "Delivery coordination and analysis" },
  { roleId: "qualityEngineer", allocationPct: 15, rationale: "Quality and acceptance" },
  { roleId: "solutionArchitect", allocationPct: 5, rationale: "Architecture and risk retirement" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedText(value: unknown, fallback = "", max = 2_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function nullableNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : null;
}

function score(value: unknown, fallback: PillarScore = 3): PillarScore {
  return Math.round(boundedNumber(value, fallback, 1, 5)) as PillarScore;
}

function safeId(value: unknown, prefix: string, index: number): string {
  const clean = boundedText(value, "", 80).replaceAll(/[^a-zA-Z0-9_-]/g, "");
  return clean || `${prefix}-${index + 1}`;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => boundedText(entry, "", 1_000)).filter(Boolean).slice(0, 100);
}

function engagementClass(value: unknown): EngagementClass {
  return ENGAGEMENT_CLASSES.includes(value as EngagementClass)
    ? value as EngagementClass
    : "focusedDelivery";
}

function normalizeWorkstreams(value: unknown): Workstream[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((raw, index) => {
    const input = asRecord(raw);
    const low = boundedNumber(input.lowHours, 0, 0, 100_000);
    const likely = Math.max(low, boundedNumber(input.likelyHours, low, 0, 100_000));
    const high = Math.max(likely, boundedNumber(input.highHours, likely, 0, 100_000));
    return {
      id: safeId(input.id, "workstream", index),
      name: boundedText(input.name, `Workstream ${index + 1}`, 200),
      description: boundedText(input.description, "", 2_000),
      lowHours: low,
      likelyHours: likely,
      highHours: high,
    };
  });
}

function normalizeTeam(value: unknown, policy: PricingPolicy): TeamAllocation[] {
  if (!Array.isArray(value) || value.length === 0) return structuredClone(DEFAULT_TEAM);
  const knownRoles = new Set(policy.roles.map((role) => role.id));
  return value.slice(0, policy.roles.length).flatMap((raw, index) => {
    const input = asRecord(raw);
    const roleId = boundedText(input.roleId, "", 80);
    if (!knownRoles.has(roleId)) return [];
    return [{
      roleId,
      allocationPct: boundedNumber(input.allocationPct, 0, 0, 100),
      rationale: boundedText(input.rationale, "", 1_000),
    } satisfies TeamAllocation];
  }).filter((entry, index, all) => all.findIndex((candidate) =>
    candidate.roleId === entry.roleId) === index);
}

function normalizeCosts(value: unknown): ThirdPartyCost[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((raw, index) => {
    const input = asRecord(raw);
    return {
      id: safeId(input.id, "cost", index),
      name: boundedText(input.name, `Direct cost ${index + 1}`, 200),
      amount: boundedNumber(input.amount, 0, 0, 100_000_000),
    };
  });
}

function normalizeComparables(value: unknown): ComparableEngagement[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((raw, index) => {
    const input = asRecord(raw);
    return {
      id: safeId(input.id, "comparable", index),
      name: boundedText(input.name, `Comparable ${index + 1}`, 200),
      referencePrice: boundedNumber(input.referencePrice, 0, 0, 1_000_000_000),
      referenceDate: /^\d{4}-\d{2}-\d{2}$/.test(String(input.referenceDate))
        ? String(input.referenceDate)
        : "",
      similarityScore: score(input.similarityScore),
      notes: boundedText(input.notes, "", 2_000),
    };
  });
}

function normalizeRisks(value: unknown): EstimateRisk[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((raw, index) => {
    const input = asRecord(raw);
    return {
      id: safeId(input.id, "risk", index),
      description: boundedText(input.description, `Risk ${index + 1}`, 1_000),
      probabilityPct: boundedNumber(input.probabilityPct, 0, 0, 100),
      impactCost: boundedNumber(input.impactCost, 0, 0, 100_000_000),
      mitigation: boundedText(input.mitigation, "", 2_000),
      mitigationEffectivenessPct: boundedNumber(
        input.mitigationEffectivenessPct,
        0,
        0,
        100,
      ),
      owner: boundedText(input.owner, "", 200),
    };
  });
}

/** Create a blank, valid estimate pinned to the current policy. */
export function createEstimateDocument(
  policy: PricingPolicy = CURRENT_PRICING_POLICY,
): EstimateDocument {
  return {
    policyVersion: policy.version,
    commercialStatus: "draft",
    project: {
      name: "New fixed-bid engagement",
      customer: "",
      engagementClass: "focusedDelivery",
      startDate: "",
      deliveryWeeks: 12,
      targetMarginPct: policy.targetMarginPct,
      proposedPrice: null,
    },
    pillars: structuredClone(DEFAULT_PILLARS),
    workstreams: [],
    team: structuredClone(DEFAULT_TEAM),
    thirdPartyCosts: [],
    comparables: [],
    risks: [],
    terms: {
      assumptions: [],
      exclusions: [],
      dependencies: [],
      acceptanceCriteria: [],
      paymentTerms: "",
      changeControl: "",
      warrantyWeeks: policy.includedWarrantyWeeks,
    },
    actuals: {
      status: "notStarted",
      contractedPrice: null,
      actualHours: null,
      actualCost: null,
      warrantyCost: null,
      outcomeNotes: "",
    },
  };
}

/** Normalize untrusted UI or agent input into the one durable estimate representation. */
export function normalizeEstimateDocument(
  value: unknown,
  policy: PricingPolicy = CURRENT_PRICING_POLICY,
): EstimateDocument {
  const root = asRecord(value);
  const project = asRecord(root.project);
  const rawPillars = asRecord(root.pillars);
  const terms = asRecord(root.terms);
  const actuals = asRecord(root.actuals);
  const commercialStatus = ["draft", "approved", "signed"].includes(
    String(root.commercialStatus),
  ) ? root.commercialStatus as EstimateDocument["commercialStatus"] : "draft";
  const status = ["notStarted", "inProgress", "won", "lost", "completed"].includes(
    String(actuals.status),
  ) ? actuals.status as EstimateDocument["actuals"]["status"] : "notStarted";
  const pillars = {} as Record<PillarKey, PillarAssessment>;
  for (const key of PILLAR_KEYS) {
    const assessment = asRecord(rawPillars[key]);
    pillars[key] = {
      score: score(assessment.score, DEFAULT_PILLARS[key].score),
      evidence: boundedText(assessment.evidence, "", 2_000),
    };
  }

  return {
    policyVersion: boundedText(root.policyVersion, policy.version, 100) || policy.version,
    commercialStatus,
    project: {
      name: boundedText(project.name, "New fixed-bid engagement", 200),
      customer: boundedText(project.customer, "", 200),
      engagementClass: engagementClass(project.engagementClass),
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(project.startDate))
        ? String(project.startDate)
        : "",
      deliveryWeeks: boundedNumber(project.deliveryWeeks, 12, 1, 260),
      targetMarginPct: boundedNumber(
        project.targetMarginPct,
        policy.targetMarginPct,
        0,
        80,
      ),
      proposedPrice: nullableNumber(project.proposedPrice, 0, 1_000_000_000),
    },
    pillars,
    workstreams: normalizeWorkstreams(root.workstreams),
    team: normalizeTeam(root.team, policy),
    thirdPartyCosts: normalizeCosts(root.thirdPartyCosts),
    comparables: normalizeComparables(root.comparables),
    risks: normalizeRisks(root.risks),
    terms: {
      assumptions: stringList(terms.assumptions),
      exclusions: stringList(terms.exclusions),
      dependencies: stringList(terms.dependencies),
      acceptanceCriteria: stringList(terms.acceptanceCriteria),
      paymentTerms: boundedText(terms.paymentTerms, "", 2_000),
      changeControl: boundedText(terms.changeControl, "", 2_000),
      warrantyWeeks: boundedNumber(
        terms.warrantyWeeks,
        policy.includedWarrantyWeeks,
        0,
        104,
      ),
    },
    actuals: {
      status,
      contractedPrice: nullableNumber(actuals.contractedPrice, 0, 1_000_000_000),
      actualHours: nullableNumber(actuals.actualHours, 0, 10_000_000),
      actualCost: nullableNumber(actuals.actualCost, 0, 1_000_000_000),
      warrantyCost: nullableNumber(actuals.warrantyCost, 0, 1_000_000_000),
      outcomeNotes: boundedText(actuals.outcomeNotes, "", 5_000),
    },
  };
}

function roundCurrency(value: number): number {
  return Math.max(0, Math.round(value / 1_000) * 1_000);
}

function precisePct(value: number): number {
  return Math.round(value * 10) / 10;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function monthsBetween(base: string, target: string): number {
  const baseDate = new Date(`${base}T00:00:00Z`);
  const targetDate = new Date(`${target}T00:00:00Z`);
  if (!Number.isFinite(baseDate.valueOf()) || !Number.isFinite(targetDate.valueOf())) return 0;
  return Math.max(0, (targetDate.valueOf() - baseDate.valueOf()) / (365.25 / 12 * 86_400_000));
}

function scenarioEffort(document: EstimateDocument, uncertaintyFactor: number) {
  let mean = 0;
  let variance = 0;
  let low = 0;
  let high = 0;
  for (const stream of document.workstreams) {
    mean += (stream.lowHours + 4 * stream.likelyHours + stream.highHours) / 6;
    const deviation = (stream.highHours - stream.lowHours) / 6;
    variance += deviation * deviation;
    low += stream.lowHours;
    high += stream.highHours;
  }
  const adjustedDeviation = Math.sqrt(variance) * uncertaintyFactor;
  return {
    p50: mean,
    p80: mean + 0.8416 * adjustedDeviation,
    p90: mean + 1.2816 * adjustedDeviation,
    low,
    high,
  };
}

function roleWeightedRate(
  document: EstimateDocument,
  policy: PricingPolicy,
  field: "internalCostPerHour" | "marketRatePerHour",
): number {
  const total = document.team.reduce((sum, allocation) => sum + allocation.allocationPct, 0);
  if (total <= 0) return 0;
  const roles = new Map(policy.roles.map((role) => [role.id, role]));
  return document.team.reduce((sum, allocation) => {
    const role = roles.get(allocation.roleId);
    return sum + (role?.[field] ?? 0) * allocation.allocationPct / total;
  }, 0);
}

function riskReserve(document: EstimateDocument): number {
  return document.risks.reduce((sum, risk) => sum +
    risk.probabilityPct / 100 * risk.impactCost *
      (1 - risk.mitigationEffectivenessPct / 100), 0);
}

/** Calculate deterministic prices, confidence scenarios, eligibility, and approvals. */
export function calculateEstimate(
  input: EstimateDocument,
  policy: PricingPolicy = CURRENT_PRICING_POLICY,
): PricingCalculation {
  const document = normalizeEstimateDocument(input, policy);
  const scoreIndex = (key: PillarKey) => document.pillars[key].score - 1;
  const speedFactor = policy.speedCostFactors[scoreIndex("speed")] ?? 1;
  const complexityFactor = policy.complexityUncertaintyFactors[scoreIndex("complexity")] ?? 1;
  const experienceFactor = policy.experienceUncertaintyFactors[scoreIndex("experience")] ?? 1;
  const teamFactor = policy.teamUncertaintyFactors[scoreIndex("teamComposition")] ?? 1;
  // Add deltas rather than stacking correlated multipliers. Complexity, historical experience, and
  // team resilience all describe uncertainty in the same effort distribution.
  const uncertaintyFactor = Math.min(
    2.2,
    Math.max(0.6, 1 + (complexityFactor - 1) + (experienceFactor - 1) + (teamFactor - 1)),
  );
  const effort = scenarioEffort(document, uncertaintyFactor);
  const months = document.project.startDate
    ? monthsBetween(policy.laborEconomicsBaseDate, document.project.startDate)
    : 0;
  const escalationFactor = (1 + policy.annualLaborEscalationPct / 100) ** (months / 12);
  const internalRate = roleWeightedRate(document, policy, "internalCostPerHour") * escalationFactor;
  const marketRate = roleWeightedRate(document, policy, "marketRatePerHour") * escalationFactor;
  const directCosts = document.thirdPartyCosts.reduce((sum, cost) => sum + cost.amount, 0);
  const laborP50 = effort.p50 * internalRate * speedFactor;
  const explicitRiskReserve = riskReserve(document);
  const riskFloorPct = policy.riskReserveFloorPcts[scoreIndex("risk")] ?? 0;
  const reserve = Math.max(explicitRiskReserve, (laborP50 + directCosts) * riskFloorPct / 100);
  const extraWarrantyWeeks = Math.max(
    0,
    document.terms.warrantyWeeks - policy.includedWarrantyWeeks,
  );
  const warrantyPct = policy.baseWarrantyReservePct +
    extraWarrantyWeeks * policy.extraWarrantyReservePctPerWeek;
  const warrantyReserve = laborP50 * warrantyPct / 100;
  const targetMargin = document.project.targetMarginPct / 100;
  const safeMarginDivisor = Math.max(0.2, 1 - targetMargin);
  const expertiseFactor = policy.expertiseMarketFactors[scoreIndex("expertise")] ?? 1;
  const engagementMinimum = policy.engagementMinimums[document.project.engagementClass];
  const comparableTargetDate = document.project.startDate || policy.laborEconomicsBaseDate;
  const closeComparableMedian = median(document.comparables
    .filter((comparable) => comparable.similarityScore >= 4 && comparable.referencePrice > 0)
    .map((comparable) => {
      const comparableAgeMonths = comparable.referenceDate
        ? monthsBetween(comparable.referenceDate, comparableTargetDate)
        : 0;
      return comparable.referencePrice * Math.pow(
        1 + policy.annualLaborEscalationPct / 100,
        comparableAgeMonths / 12,
      );
    }));
  const closeComparableFloor = closeComparableMedian === null
    ? null
    : roundCurrency(closeComparableMedian * policy.closeComparableFloorRatio);

  const makeScenario = (hours: number): PricingScenario => {
    const labor = hours * internalRate * speedFactor;
    const deliveryCost = labor + directCosts + reserve + warrantyReserve;
    const marketReference = hours * marketRate * speedFactor *
      policy.marketCredibilityRatio * expertiseFactor + directCosts + reserve + warrantyReserve;
    return {
      effortHours: Math.round(hours),
      deliveryCost: roundCurrency(deliveryCost),
      marketReference: roundCurrency(marketReference),
      price: roundCurrency(Math.max(
        deliveryCost / safeMarginDivisor,
        marketReference,
        engagementMinimum,
      )),
    };
  };

  const scenarios = {
    p50: makeScenario(effort.p50),
    p80: makeScenario(effort.p80),
    p90: makeScenario(effort.p90),
  };
  const minimumSustainablePrice = roundCurrency(
    scenarios.p80.deliveryCost / (1 - policy.minimumMarginPct / 100),
  );
  const marketCredibilityFloor = roundCurrency(Math.max(
    scenarios.p50.marketReference,
    engagementMinimum,
    closeComparableFloor ?? 0,
  ));
  const recommendedPrice = Math.max(
    scenarios.p80.price,
    minimumSustainablePrice,
    marketCredibilityFloor,
  );
  const selectedPrice = document.project.proposedPrice ?? recommendedPrice;
  const estimatedGrossMarginPct = selectedPrice > 0
    ? precisePct((selectedPrice - scenarios.p80.deliveryCost) / selectedPrice * 100)
    : -100;

  const teamTotal = document.team.reduce((sum, allocation) => sum + allocation.allocationPct, 0);
  const spreadRatio = effort.low > 0 ? effort.high / effort.low : effort.high > 0 ? Infinity : 0;
  const ineligibilityReasons: string[] = [];
  if (document.workstreams.length === 0 || effort.p50 <= 0) {
    ineligibilityReasons.push("Add at least one estimated workstream before using a fixed bid.");
  }
  if (Math.abs(teamTotal - 100) > 0.1) {
    ineligibilityReasons.push("Team allocations must total 100%.");
  }
  if (document.pillars.complexity.score === 5 && document.pillars.experience.score === 1) {
    ineligibilityReasons.push(
      "Extreme complexity without close delivery experience is not eligible for a direct fixed bid.",
    );
  }
  if (spreadRatio >= 2.5) {
    ineligibilityReasons.push(
      "The high estimate is at least 2.5× the low estimate; retire uncertainty before fixing price.",
    );
  }
  if (document.pillars.risk.score === 5 &&
      (document.risks.length === 0 || document.terms.acceptanceCriteria.length === 0)) {
    ineligibilityReasons.push(
      "Extreme risk requires a quantified risk register and explicit acceptance criteria.",
    );
  }

  const discoveryReasons: string[] = [];
  if (uncertaintyFactor >= 1.45) {
    discoveryReasons.push("The combined uncertainty factor is too high for direct commitment.");
  }
  if (spreadRatio >= 1.8) {
    discoveryReasons.push("The three-point estimate range is too wide.");
  }
  if (document.pillars.complexity.score >= 4 && document.pillars.experience.score <= 2) {
    discoveryReasons.push("High complexity is paired with limited close historical experience.");
  }
  if (document.pillars.risk.score >= 4 && document.risks.length === 0) {
    discoveryReasons.push("High retained risk has not been quantified in the risk register.");
  }
  if (document.terms.acceptanceCriteria.length === 0) {
    discoveryReasons.push("Acceptance criteria are not yet explicit.");
  }

  const approvals: PricingApproval[] = [];
  if (document.project.targetMarginPct < policy.minimumMarginPct) {
    approvals.push({
      code: "margin-below-policy",
      message: `Target margin is below the ${policy.minimumMarginPct}% policy minimum.`,
    });
  }
  if (document.project.proposedPrice !== null && selectedPrice < minimumSustainablePrice) {
    approvals.push({
      code: "below-sustainable-floor",
      message: "Proposed price is below the P80 delivery economics floor at minimum margin.",
    });
  }
  if (document.project.proposedPrice !== null && selectedPrice < marketCredibilityFloor) {
    approvals.push({
      code: "below-market-floor",
      message: "Proposed price is below the comparable-market credibility floor.",
    });
  }
  if (document.project.proposedPrice !== null && closeComparableFloor !== null &&
      selectedPrice < closeComparableFloor) {
    approvals.push({
      code: "below-close-comparables",
      message: "Proposed price is materially below the inflation-adjusted median of close comparables.",
    });
  }
  if (document.project.proposedPrice !== null && selectedPrice < scenarios.p50.price) {
    approvals.push({
      code: "below-p50",
      message: "Proposed price is below the low confidence price.",
    });
  }
  if (estimatedGrossMarginPct < policy.minimumMarginPct) {
    approvals.push({
      code: "estimated-margin-below-policy",
      message: `Estimated P80 gross margin is below ${policy.minimumMarginPct}%.`,
    });
  }
  if (discoveryReasons.length > 0) {
    approvals.push({
      code: "paid-discovery-required",
      message: "Complete paid discovery and re-estimate before issuing a fixed-bid SOW.",
    });
  }

  const drivers = [
    `${Math.round(effort.p50).toLocaleString()} P50 hours across ${document.workstreams.length} workstream(s)`,
    `${speedFactor.toFixed(2)}× delivery-cost factor for Speed ${document.pillars.speed.score}/5`,
    `${uncertaintyFactor.toFixed(2)}× combined range factor from Complexity, Experience, and Team Composition`,
    `${expertiseFactor.toFixed(2)}× market factor for Expertise ${document.pillars.expertise.score}/5`,
    `${riskFloorPct}% minimum residual reserve for Risk ${document.pillars.risk.score}/5`,
    `${escalationFactor.toFixed(3)}× labor escalation from the policy base date`,
  ];
  if (closeComparableMedian !== null) {
    drivers.push(
      `${roundCurrency(closeComparableMedian).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} inflation-adjusted median from close comparables`,
    );
  }

  const actualTotalCost = document.actuals.actualCost === null
    ? null
    : document.actuals.actualCost + (document.actuals.warrantyCost ?? 0);
  const realizedMarginPct = actualTotalCost !== null &&
      document.actuals.contractedPrice !== null && document.actuals.contractedPrice > 0
    ? precisePct(
      (document.actuals.contractedPrice - actualTotalCost) /
        document.actuals.contractedPrice * 100,
    )
    : null;
  const effortVariancePct = document.actuals.actualHours !== null && effort.p50 > 0
    ? precisePct((document.actuals.actualHours - effort.p50) / effort.p50 * 100)
    : null;

  return {
    policyVersion: policy.version,
    escalationFactor: Math.round(escalationFactor * 1_000) / 1_000,
    scenarios,
    recommendedPrice,
    selectedPrice: roundCurrency(selectedPrice),
    minimumSustainablePrice,
    marketCredibilityFloor,
    closeComparableMedian: closeComparableMedian === null
      ? null
      : roundCurrency(closeComparableMedian),
    closeComparableFloor,
    engagementMinimum,
    riskReserve: roundCurrency(reserve),
    explicitRiskReserve: roundCurrency(explicitRiskReserve),
    warrantyReserve: roundCurrency(warrantyReserve),
    estimatedGrossMarginPct,
    uncertaintyFactor: Math.round(uncertaintyFactor * 100) / 100,
    fixedBidEligible: ineligibilityReasons.length === 0,
    ineligibilityReasons,
    discoveryRequired: discoveryReasons.length > 0,
    discoveryReasons,
    approvals,
    drivers,
    backtest: { realizedMarginPct, effortVariancePct },
  };
}

/** Apply typed proposal operations and re-normalize the resulting estimate. */
export function applyEstimateOperations(
  current: EstimateDocument,
  operations: EstimateOperation[],
  policy: PricingPolicy = CURRENT_PRICING_POLICY,
): EstimateDocument {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 100) {
    throw new TypeError("A proposal must contain between 1 and 100 operations.");
  }
  const next = structuredClone(normalizeEstimateDocument(current, policy));
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") throw new TypeError("Invalid operation.");
    switch (operation.type) {
      case "setProject":
        Object.assign(next.project, operation.patch);
        break;
      case "setPillars":
        for (const key of PILLAR_KEYS) {
          if (operation.patch[key]) Object.assign(next.pillars[key], operation.patch[key]);
        }
        break;
      case "upsertWorkstream": {
        const index = next.workstreams.findIndex((entry) => entry.id === operation.workstream.id);
        if (index === -1) next.workstreams.push(operation.workstream);
        else next.workstreams[index] = operation.workstream;
        break;
      }
      case "removeWorkstream":
        next.workstreams = next.workstreams.filter((entry) => entry.id !== operation.id);
        break;
      case "setTeam":
        next.team = operation.team;
        break;
      case "setThirdPartyCosts":
        next.thirdPartyCosts = operation.costs;
        break;
      case "setComparables":
        next.comparables = operation.comparables;
        break;
      case "upsertRisk": {
        const index = next.risks.findIndex((entry) => entry.id === operation.risk.id);
        if (index === -1) next.risks.push(operation.risk);
        else next.risks[index] = operation.risk;
        break;
      }
      case "removeRisk":
        next.risks = next.risks.filter((entry) => entry.id !== operation.id);
        break;
      case "setTerms":
        Object.assign(next.terms, operation.patch);
        break;
      case "setActuals":
        Object.assign(next.actuals, operation.patch);
        break;
      default:
        throw new TypeError("Unknown estimate operation.");
    }
  }
  return normalizeEstimateDocument(next, policy);
}

function commercialBaseline(document: EstimateDocument): Omit<
  EstimateDocument,
  "commercialStatus" | "actuals"
> {
  const { commercialStatus: _commercialStatus, actuals: _actuals, ...baseline } = document;
  return baseline;
}

/**
 * Enforce the commercial lifecycle at the durable state boundary. Approved estimates must be
 * reopened before their pricing inputs change; signed estimates are terminal, while actuals remain
 * writable for back-testing. Advancing is impossible while an eligibility or discovery gate is
 * open. Policy exceptions remain visible and the human approval action acknowledges them.
 */
export function assertEstimateTransition(
  currentValue: unknown,
  nextValue: unknown,
  policy: PricingPolicy = CURRENT_PRICING_POLICY,
): void {
  const current = normalizeEstimateDocument(currentValue, policy);
  const next = normalizeEstimateDocument(nextValue, policy);
  if (next.policyVersion !== current.policyVersion) {
    throw new Error("An estimate's pinned pricing policy cannot be changed in place.");
  }

  const commercialChanged = JSON.stringify(commercialBaseline(next)) !==
    JSON.stringify(commercialBaseline(current));
  if (current.commercialStatus !== "draft" && commercialChanged) {
    throw new Error(
      current.commercialStatus === "signed"
        ? "Signed estimate terms are immutable; create a new estimate for commercial changes."
        : "Reopen the approved estimate as a draft before changing commercial inputs.",
    );
  }

  if (current.commercialStatus === "signed" && next.commercialStatus !== "signed") {
    throw new Error("A signed estimate cannot be reopened or downgraded.");
  }
  if (current.commercialStatus === "draft" && next.commercialStatus === "signed") {
    throw new Error("Approve the estimate before marking it signed.");
  }

  const advancing = next.commercialStatus !== current.commercialStatus &&
    (next.commercialStatus === "approved" || next.commercialStatus === "signed");
  if (advancing) {
    const calculation = calculateEstimate(next, policy);
    if (!calculation.fixedBidEligible) {
      throw new Error("Resolve every fixed-bid eligibility gate before advancing the estimate.");
    }
    if (calculation.discoveryRequired) {
      throw new Error("Complete paid discovery and re-estimate before advancing the estimate.");
    }
  }
}
