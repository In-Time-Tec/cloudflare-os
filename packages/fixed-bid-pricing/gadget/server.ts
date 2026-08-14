import { DurableObject } from "cloudflare:workers";
import {
  CURRENT_PRICING_POLICY,
  applyEstimateOperations,
  assertEstimateTransition,
  calculateEstimate,
  createEstimateDocument,
  normalizeEstimateDocument,
  type EstimateDocument,
  type EstimateOperation,
  type PricingCalculation,
} from "../src/pricing.js";

const STORAGE_KEY = "fixed-bid-estimate:v1";
const MAX_PROPOSALS = 20;
const MAX_AUDIT_ENTRIES = 100;

type ProposalImpact = {
  before: Pick<PricingCalculation, "recommendedPrice" | "selectedPrice" | "fixedBidEligible" | "discoveryRequired">;
  after: Pick<PricingCalculation, "recommendedPrice" | "selectedPrice" | "fixedBidEligible" | "discoveryRequired">;
};

type EstimateProposal = {
  id: string;
  summary: string;
  createdAt: string;
  baseRevision: number;
  operations: EstimateOperation[];
  impact: ProposalImpact;
};

type AuditEntry = {
  id: string;
  occurredAt: string;
  actor: "manual" | "proposal";
  summary: string;
  revision: number;
};

type StoredState = {
  revision: number;
  estimate: EstimateDocument;
  proposals: EstimateProposal[];
  auditTrail: AuditEntry[];
};

type EstimateSnapshot = {
  revision: number;
  estimate: EstimateDocument;
  calculation: PricingCalculation;
  proposals: EstimateProposal[];
  auditTrail: AuditEntry[];
  policy: {
    version: string;
    effectiveDate: string;
    calibrationStatus: "initial" | "calibrated";
    roles: Array<{ id: string; label: string }>;
  };
};

type Subscriber = {
  dup(): Subscriber;
  update(snapshot: EstimateSnapshot): Promise<void>;
  onRpcBroken(callback: () => void): void;
  [Symbol.dispose](): void;
};

type GadgetState = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
};

function proposalImpact(calculation: PricingCalculation): ProposalImpact["before"] {
  return {
    recommendedPrice: calculation.recommendedPrice,
    selectedPrice: calculation.selectedPrice,
    fixedBidEligible: calculation.fixedBidEligible,
    discoveryRequired: calculation.discoveryRequired,
  };
}

function summaryText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Proposal summary is required.");
  }
  return value.trim().slice(0, 500);
}

export class Gadget extends DurableObject {
  private readonly state: GadgetState;
  private readonly subscribers = new Set<Subscriber>();
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(state: GadgetState, env: unknown) {
    super(state, env);
    this.state = state;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<StoredState> {
    const existing = await this.state.storage.get<StoredState>(STORAGE_KEY);
    if (existing) {
      return {
        revision: Math.max(1, Math.floor(existing.revision || 1)),
        estimate: normalizeEstimateDocument(existing.estimate),
        proposals: Array.isArray(existing.proposals) ? existing.proposals.slice(-MAX_PROPOSALS) : [],
        auditTrail: Array.isArray(existing.auditTrail)
          ? existing.auditTrail.slice(-MAX_AUDIT_ENTRIES)
          : [],
      };
    }
    const created: StoredState = {
      revision: 1,
      estimate: createEstimateDocument(),
      proposals: [],
      auditTrail: [{
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        actor: "manual",
        summary: `Created estimate with policy ${CURRENT_PRICING_POLICY.version}`,
        revision: 1,
      }],
    };
    await this.state.storage.put(STORAGE_KEY, created);
    return created;
  }

  private snapshot(state: StoredState): EstimateSnapshot {
    return {
      revision: state.revision,
      estimate: state.estimate,
      calculation: calculateEstimate(state.estimate),
      proposals: state.proposals,
      auditTrail: state.auditTrail,
      policy: {
        version: CURRENT_PRICING_POLICY.version,
        effectiveDate: CURRENT_PRICING_POLICY.effectiveDate,
        calibrationStatus: CURRENT_PRICING_POLICY.calibrationStatus,
        roles: CURRENT_PRICING_POLICY.roles.map(({ id, label }) => ({ id, label })),
      },
    };
  }

  private async persist(state: StoredState, broadcast = true): Promise<EstimateSnapshot> {
    state.proposals = state.proposals.slice(-MAX_PROPOSALS);
    state.auditTrail = state.auditTrail.slice(-MAX_AUDIT_ENTRIES);
    await this.state.storage.put(STORAGE_KEY, state);
    const snapshot = this.snapshot(state);
    if (broadcast) await this.broadcast(snapshot);
    return snapshot;
  }

  private async broadcast(snapshot: EstimateSnapshot): Promise<void> {
    await Promise.allSettled([...this.subscribers].map(async (subscriber) => {
      try {
        await subscriber.update(snapshot);
      } catch {
        this.subscribers.delete(subscriber);
        subscriber[Symbol.dispose]();
      }
    }));
  }

  async getEstimate(): Promise<EstimateSnapshot> {
    return this.snapshot(await this.load());
  }

  async getPricingSummary(): Promise<{
    revision: number;
    commercialStatus: EstimateDocument["commercialStatus"];
    project: EstimateDocument["project"];
    calculation: PricingCalculation;
  }> {
    const state = await this.load();
    return {
      revision: state.revision,
      commercialStatus: state.estimate.commercialStatus,
      project: state.estimate.project,
      calculation: calculateEstimate(state.estimate),
    };
  }

  updateEstimate(input: {
    expectedRevision: number;
    estimate: EstimateDocument;
    summary?: string;
  }): Promise<EstimateSnapshot> {
    return this.enqueue(async () => {
      const state = await this.load();
      if (input.expectedRevision !== state.revision) {
        throw new Error(`Estimate changed; expected revision ${input.expectedRevision}, found ${state.revision}.`);
      }
      const next = normalizeEstimateDocument(input.estimate);
      assertEstimateTransition(state.estimate, next);
      state.estimate = next;
      state.revision += 1;
      state.auditTrail.push({
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        actor: "manual",
        summary: typeof input.summary === "string" && input.summary.trim()
          ? input.summary.trim().slice(0, 500)
          : "Updated estimate",
        revision: state.revision,
      });
      return this.persist(state);
    });
  }

  proposeChanges(input: {
    expectedRevision: number;
    summary: string;
    operations: EstimateOperation[];
  }): Promise<EstimateProposal> {
    return this.enqueue(async () => {
      const state = await this.load();
      if (input.expectedRevision !== state.revision) {
        throw new Error(`Estimate changed; expected revision ${input.expectedRevision}, found ${state.revision}.`);
      }
      const proposed = applyEstimateOperations(state.estimate, input.operations);
      assertEstimateTransition(state.estimate, proposed);
      const before = calculateEstimate(state.estimate);
      const after = calculateEstimate(proposed);
      const proposal: EstimateProposal = {
        id: crypto.randomUUID(),
        summary: summaryText(input.summary),
        createdAt: new Date().toISOString(),
        baseRevision: state.revision,
        operations: structuredClone(input.operations),
        impact: { before: proposalImpact(before), after: proposalImpact(after) },
      };
      state.proposals.push(proposal);
      await this.persist(state);
      return proposal;
    });
  }

  approveProposal(input: { id: string }): Promise<EstimateSnapshot> {
    return this.enqueue(async () => {
      const state = await this.load();
      const proposal = state.proposals.find((entry) => entry.id === input.id);
      if (!proposal) throw new Error("Proposal not found.");
      if (proposal.baseRevision !== state.revision) {
        throw new Error(
          `Proposal targets revision ${proposal.baseRevision}; review it again against revision ${state.revision}.`,
        );
      }
      const next = applyEstimateOperations(state.estimate, proposal.operations);
      assertEstimateTransition(state.estimate, next);
      state.estimate = next;
      state.revision += 1;
      state.proposals = state.proposals.filter((entry) => entry.id !== proposal.id);
      state.auditTrail.push({
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        actor: "proposal",
        summary: proposal.summary,
        revision: state.revision,
      });
      return this.persist(state);
    });
  }

  rejectProposal(input: { id: string }): Promise<EstimateSnapshot> {
    return this.enqueue(async () => {
      const state = await this.load();
      if (!state.proposals.some((entry) => entry.id === input.id)) {
        throw new Error("Proposal not found.");
      }
      state.proposals = state.proposals.filter((entry) => entry.id !== input.id);
      return this.persist(state);
    });
  }

  async subscribe(callback: Subscriber): Promise<EstimateSnapshot> {
    const subscriber = callback.dup();
    this.subscribers.add(subscriber);
    subscriber.onRpcBroken(() => {
      this.subscribers.delete(subscriber);
      subscriber[Symbol.dispose]();
    });
    return this.getEstimate();
  }
}
