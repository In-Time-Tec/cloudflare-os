import type {
  EstimateDocument,
  PillarKey,
  PricingCalculation,
} from "../src/pricing.js";

type Proposal = {
  id: string;
  summary: string;
  createdAt: string;
  baseRevision: number;
  impact: {
    before: Pick<PricingCalculation, "recommendedPrice" | "selectedPrice" | "fixedBidEligible" | "discoveryRequired">;
    after: Pick<PricingCalculation, "recommendedPrice" | "selectedPrice" | "fixedBidEligible" | "discoveryRequired">;
  };
};

type Snapshot = {
  revision: number;
  estimate: EstimateDocument;
  calculation: PricingCalculation;
  proposals: Proposal[];
  auditTrail: Array<{
    id: string;
    occurredAt: string;
    actor: "manual" | "proposal";
    summary: string;
    revision: number;
  }>;
  policy: {
    version: string;
    effectiveDate: string;
    calibrationStatus: "initial" | "calibrated";
    roles: Array<{ id: string; label: string }>;
  };
};

type Tab = "overview" | "scope" | "risk" | "review";

const PILLARS: Array<{ key: PillarKey; label: string; description: string }> = [
  { key: "speed", label: "Speed", description: "Compression, parallel delivery, ramp-up, and response commitments." },
  { key: "complexity", label: "Complexity", description: "Architecture, integrations, data, dependencies, and acceptance difficulty." },
  { key: "experience", label: "Experience", description: "Evidence from close, successfully delivered historical analogs." },
  { key: "expertise", label: "Expertise", description: "Scarce specialization, domain knowledge, and market value." },
  { key: "risk", label: "Risk", description: "Ambiguity, dependencies, warranty, acceptance, and retained completion risk." },
  { key: "teamComposition", label: "Team Composition", description: "The role mix, continuity, quality, leadership, and resilience needed to deliver." },
];

const CLASS_LABELS: Record<EstimateDocument["project"]["engagementClass"], string> = {
  proofOfConcept: "Proof of concept",
  focusedDelivery: "Focused production delivery",
  productionTransformation: "Production transformation",
  regulatedOrCritical: "Regulated or mission-critical",
};

const STATUS_LABELS: Record<EstimateDocument["actuals"]["status"], string> = {
  notStarted: "Not started",
  inProgress: "In progress",
  won: "Won",
  lost: "Lost",
  completed: "Completed",
};

const COMMERCIAL_STATUS_LABELS: Record<EstimateDocument["commercialStatus"], string> = {
  draft: "Draft",
  approved: "Approved",
  signed: "Signed",
};

const app = document.createElement("main");
app.id = "pricing-app";
document.body.append(app);

const style = document.createElement("style");
style.textContent = `
  :root {
    color-scheme: light;
    font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #161616;
    background: #f5f5f3;
    --accent: #ff6633;
    --accent-dark: #d94716;
    --ink: #161616;
    --muted: #686865;
    --line: #deded9;
    --surface: #ffffff;
    --soft: #f7f7f4;
    --good: #18794e;
    --warn: #9a6700;
    --bad: #b42318;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f5f3; min-width: 320px; }
  button, input, select, textarea { font: inherit; }
  button { cursor: pointer; }
  .shell { max-width: 1480px; margin: 0 auto; padding: 24px; }
  .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 22px; }
  .eyebrow { color: var(--accent-dark); font-size: 12px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
  h1 { margin: 6px 0 4px; font-size: clamp(26px, 4vw, 40px); letter-spacing: -.04em; line-height: 1.05; }
  h2 { font-size: 20px; margin: 0; letter-spacing: -.02em; }
  h3 { font-size: 15px; margin: 0; }
  p { margin: 0; }
  .muted { color: var(--muted); }
  .policy-chip { border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 8px 12px; font-size: 12px; white-space: nowrap; }
  .policy-chip strong { color: var(--accent-dark); }
  .price-rail { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) 1.2fr; background: #161616; color: white; border-radius: 16px; overflow: hidden; margin-bottom: 16px; }
  .price-cell { padding: 18px 20px; border-right: 1px solid #3b3b3b; }
  .price-cell:last-child { border: 0; background: linear-gradient(135deg, #ff6633, #f6821f); }
  .price-label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #bdbdb7; font-weight: 700; }
  .price-cell:last-child .price-label { color: #fff1ea; }
  .price { font-size: clamp(23px, 3vw, 34px); font-weight: 760; letter-spacing: -.04em; margin-top: 5px; }
  .price-meta { margin-top: 4px; color: #bdbdb7; font-size: 12px; }
  .price-cell:last-child .price-meta { color: white; }
  .status-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
  .status { border: 1px solid var(--line); background: var(--surface); border-radius: 12px; padding: 13px 15px; display: flex; gap: 10px; align-items: flex-start; font-size: 13px; }
  .status-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; margin-top: 4px; background: var(--good); }
  .status.warn .status-dot { background: var(--warn); }
  .status.bad .status-dot { background: var(--bad); }
  .proposal-stack { display: grid; gap: 8px; margin-bottom: 16px; }
  .proposal { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 12px; padding: 14px 16px; display: flex; justify-content: space-between; gap: 18px; align-items: center; }
  .proposal-impact { font-size: 13px; color: #7c2d12; margin-top: 4px; }
  .button-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .button { border: 1px solid var(--ink); border-radius: 8px; background: var(--ink); color: white; padding: 8px 12px; font-weight: 700; font-size: 13px; }
  .button:hover { background: #30302f; }
  .button:disabled { cursor: not-allowed; opacity: .45; }
  .button:disabled:hover { background: var(--ink); }
  .button.secondary { background: white; color: var(--ink); border-color: var(--line); }
  .button.secondary:hover { background: var(--soft); }
  .button.danger { color: var(--bad); border-color: #f2b8b5; background: white; }
  .button.small { padding: 6px 9px; font-size: 12px; }
  .tabs { display: flex; gap: 4px; padding: 4px; border: 1px solid var(--line); background: #ecece8; border-radius: 11px; width: fit-content; margin-bottom: 16px; }
  .tab { border: 0; background: transparent; border-radius: 8px; padding: 9px 15px; color: var(--muted); font-size: 13px; font-weight: 700; }
  .tab[aria-selected="true"] { background: white; color: var(--ink); box-shadow: 0 1px 3px #00000012; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 310px; gap: 16px; align-items: start; }
  .stack { display: grid; gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 20px; }
  .card-head { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 16px; }
  .card-copy { color: var(--muted); font-size: 13px; margin-top: 4px; line-height: 1.5; }
  .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .form-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  label.field { display: grid; gap: 6px; color: #3f3f3c; font-size: 12px; font-weight: 700; }
  input, select, textarea { width: 100%; border: 1px solid #cfcfca; background: white; color: var(--ink); border-radius: 8px; padding: 9px 10px; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px #ff66331c; }
  textarea { min-height: 78px; resize: vertical; line-height: 1.45; }
  .help { color: var(--muted); font-weight: 400; font-size: 11px; }
  .pillar-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .pillar { border: 1px solid var(--line); border-radius: 11px; padding: 14px; background: var(--soft); }
  .pillar-top { display: grid; grid-template-columns: 1fr 110px; gap: 12px; align-items: start; margin-bottom: 10px; }
  .pillar p { color: var(--muted); font-size: 12px; line-height: 1.45; margin-top: 4px; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; min-width: 720px; }
  th { background: var(--soft); text-align: left; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; padding: 10px; border-bottom: 1px solid var(--line); }
  td { padding: 9px 10px; border-bottom: 1px solid #ecece8; vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td input, td select { min-width: 90px; }
  .empty { border: 1px dashed #cfcfca; border-radius: 10px; padding: 24px; text-align: center; color: var(--muted); font-size: 13px; }
  .metric-list { display: grid; gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .metric { display: flex; justify-content: space-between; gap: 15px; background: white; padding: 11px 12px; font-size: 13px; }
  .metric strong { text-align: right; }
  .side-list { margin: 0; padding-left: 18px; color: #454542; font-size: 13px; line-height: 1.5; }
  .side-list li + li { margin-top: 6px; }
  .notice { border-left: 3px solid var(--accent); padding: 10px 12px; background: #fff7ed; color: #7c2d12; font-size: 12px; line-height: 1.5; margin-top: 12px; }
  .locked { opacity: .72; }
  .locked input, .locked select, .locked textarea { background: #f1f1ee; }
  .scenario-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .scenario { border: 1px solid var(--line); border-radius: 11px; padding: 15px; }
  .scenario.recommended { border: 2px solid var(--accent); padding: 14px; }
  .scenario .amount { font-size: 26px; font-weight: 760; letter-spacing: -.03em; margin: 7px 0 10px; }
  .scenario dl { margin: 0; display: grid; gap: 6px; font-size: 12px; }
  .scenario dl div { display: flex; justify-content: space-between; gap: 8px; }
  .scenario dt { color: var(--muted); }
  .scenario dd { margin: 0; font-weight: 700; }
  .audit { display: grid; gap: 9px; }
  .audit-entry { border-left: 2px solid var(--line); padding-left: 10px; font-size: 12px; }
  .audit-entry time { color: var(--muted); display: block; margin-top: 2px; }
  #save-status { position: fixed; right: 18px; bottom: 18px; z-index: 10; background: #161616; color: white; border-radius: 9px; padding: 9px 12px; font-size: 12px; opacity: 0; transform: translateY(6px); transition: .18s ease; pointer-events: none; }
  #save-status.visible { opacity: 1; transform: translateY(0); }
  #save-status.error { background: var(--bad); }
  .print-summary { display: none; }
  @media (max-width: 980px) {
    .layout { grid-template-columns: 1fr; }
    .price-rail { grid-template-columns: repeat(2, 1fr); }
    .price-cell:nth-child(2) { border-right: 0; }
    .price-cell:nth-child(-n+2) { border-bottom: 1px solid #3b3b3b; }
    .status-grid, .scenario-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 680px) {
    .shell { padding: 14px; }
    .topbar { display: grid; }
    .policy-chip { white-space: normal; }
    .price-rail, .form-grid, .form-grid.three, .pillar-grid { grid-template-columns: 1fr; }
    .price-cell { border-right: 0; border-bottom: 1px solid #3b3b3b; }
    .tabs { width: 100%; overflow-x: auto; }
    .tab { white-space: nowrap; flex: 1; }
    .proposal { align-items: flex-start; flex-direction: column; }
  }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
  @media print {
    body { background: white; }
    .shell { max-width: none; padding: 0; }
    .tabs, .screen-content, .proposal-stack, #save-status { display: none !important; }
    .print-summary { display: block; }
    .price-rail { break-inside: avoid; print-color-adjust: exact; }
    .card { break-inside: avoid; box-shadow: none; }
  }
`;
document.head.append(style);

let snapshot: Snapshot | null = null;
let activeTab: Tab = "overview";
let mutationQueue: Promise<void> = Promise.resolve();
let statusTimer: number | undefined;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

function lines(value: string[]): string {
  return value.join("\n");
}

function field(
  label: string,
  path: string,
  value: string | number | null,
  options: { type?: string; help?: string; min?: number; max?: number; placeholder?: string } = {},
): string {
  return `<label class="field">${escapeHtml(label)}
    <input data-path="${escapeHtml(path)}" type="${options.type ?? "text"}"
      value="${escapeHtml(value ?? "")}" ${options.min !== undefined ? `min="${options.min}"` : ""}
      ${options.max !== undefined ? `max="${options.max}"` : ""}
      placeholder="${escapeHtml(options.placeholder ?? "")}">
    ${options.help ? `<span class="help">${escapeHtml(options.help)}</span>` : ""}
  </label>`;
}

function textarea(
  label: string,
  path: string,
  value: string,
  options: { help?: string; lines?: boolean; placeholder?: string } = {},
): string {
  return `<label class="field">${escapeHtml(label)}
    <textarea data-path="${escapeHtml(path)}" ${options.lines ? "data-lines=\"true\"" : ""}
      placeholder="${escapeHtml(options.placeholder ?? "")}">${escapeHtml(value)}</textarea>
    ${options.help ? `<span class="help">${escapeHtml(options.help)}</span>` : ""}
  </label>`;
}

function selectField(
  label: string,
  path: string,
  value: string | number,
  choices: Array<[string | number, string]>,
  help = "",
): string {
  return `<label class="field">${escapeHtml(label)}
    <select data-path="${escapeHtml(path)}">${choices.map(([key, text]) =>
      `<option value="${escapeHtml(key)}" ${String(key) === String(value) ? "selected" : ""}>${escapeHtml(text)}</option>`
    ).join("")}</select>
    ${help ? `<span class="help">${escapeHtml(help)}</span>` : ""}
  </label>`;
}

function topSummary(model: Snapshot): string {
  const { calculation, estimate } = model;
  const recommendedLabel = estimate.project.proposedPrice === null ? "Recommended P80" : "Proposed price";
  return `
    <section class="price-rail" aria-label="Pricing scenarios">
      <div class="price-cell"><div class="price-label">P50 · low</div><div class="price">${money(calculation.scenarios.p50.price)}</div><div class="price-meta">${calculation.scenarios.p50.effortHours.toLocaleString()} hours</div></div>
      <div class="price-cell"><div class="price-label">P80 · base</div><div class="price">${money(calculation.scenarios.p80.price)}</div><div class="price-meta">${calculation.scenarios.p80.effortHours.toLocaleString()} hours</div></div>
      <div class="price-cell"><div class="price-label">P90 · high</div><div class="price">${money(calculation.scenarios.p90.price)}</div><div class="price-meta">${calculation.scenarios.p90.effortHours.toLocaleString()} hours</div></div>
      <div class="price-cell"><div class="price-label">${recommendedLabel}</div><div class="price">${money(calculation.selectedPrice)}</div><div class="price-meta">${calculation.estimatedGrossMarginPct}% estimated P80 margin</div></div>
    </section>
    <section class="status-grid" aria-label="Pricing readiness">
      <div class="status ${calculation.fixedBidEligible ? "" : "bad"}"><span class="status-dot"></span><div><strong>${calculation.fixedBidEligible ? "Fixed-bid eligible" : "Not fixed-bid eligible"}</strong><div class="muted">${calculation.fixedBidEligible ? "No eligibility gate is blocking the estimate." : `${calculation.ineligibilityReasons.length} blocking condition(s).`}</div></div></div>
      <div class="status ${calculation.discoveryRequired ? "warn" : ""}"><span class="status-dot"></span><div><strong>${calculation.discoveryRequired ? "Paid discovery required" : "Discovery gate clear"}</strong><div class="muted">${calculation.discoveryRequired ? `${calculation.discoveryReasons.length} uncertainty trigger(s).` : "Current inputs support direct estimation."}</div></div></div>
      <div class="status ${calculation.approvals.length ? "warn" : ""}"><span class="status-dot"></span><div><strong>${calculation.approvals.length ? "Leadership review required" : "No pricing approval flags"}</strong><div class="muted">${calculation.approvals.length ? `${calculation.approvals.length} policy exception(s).` : "Price meets current policy checks."}</div></div></div>
    </section>`;
}

function proposals(model: Snapshot): string {
  if (model.proposals.length === 0) return "";
  return `<section class="proposal-stack" aria-label="Pending agent proposals">${model.proposals.map((proposal) => {
    const applicable = proposal.baseRevision === model.revision &&
      model.estimate.commercialStatus === "draft";
    return `
    <article class="proposal ${applicable ? "" : "locked"}">
      <div><div class="eyebrow">Agent proposal · revision ${proposal.baseRevision}</div><strong>${escapeHtml(proposal.summary)}</strong>
        <div class="proposal-impact">P80 ${money(proposal.impact.before.recommendedPrice)} → ${money(proposal.impact.after.recommendedPrice)} · ${dateTime(proposal.createdAt)}${applicable ? "" : " · Re-propose against the current draft"}</div></div>
      <div class="button-row"><button class="button small" data-action="approve-proposal" data-id="${escapeHtml(proposal.id)}" ${applicable ? "" : "disabled"}>Apply proposal</button><button class="button secondary small" data-action="reject-proposal" data-id="${escapeHtml(proposal.id)}">Reject</button></div>
    </article>`;
  }).join("")}</section>`;
}

function overviewTab(model: Snapshot): string {
  const { estimate } = model;
  return `<div class="stack" data-commercial>
    <section class="card">
      <div class="card-head"><div><h2>Engagement</h2><p class="card-copy">Price the obligation being accepted, not a customer-facing headcount.</p></div></div>
      <div class="form-grid three">
        ${field("Estimate name", "project.name", estimate.project.name)}
        ${field("Customer", "project.customer", estimate.project.customer)}
        ${selectField("Engagement class", "project.engagementClass", estimate.project.engagementClass,
          Object.entries(CLASS_LABELS))}
        ${field("Delivery start", "project.startDate", estimate.project.startDate, { type: "date", help: "Future starts apply policy labor escalation." })}
        ${field("Delivery weeks", "project.deliveryWeeks", estimate.project.deliveryWeeks, { type: "number", min: 1, max: 260 })}
        ${field("Target gross margin %", "project.targetMarginPct", estimate.project.targetMarginPct, { type: "number", min: 0, max: 80 })}
      </div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Six pricing pillars</h2><p class="card-copy">Score 1–5 and record evidence. Correlated uncertainty is combined once, not stacked as six multipliers.</p></div></div>
      <div class="pillar-grid">${PILLARS.map(({ key, label, description }) => {
        const assessment = estimate.pillars[key];
        return `<article class="pillar"><div class="pillar-top"><div><h3>${label}</h3><p>${description}</p></div>
          ${selectField("Score", `pillars.${key}.score`, assessment.score, [1, 2, 3, 4, 5].map((value) => [value, `${value} / 5`]))}</div>
          ${textarea("Evidence", `pillars.${key}.evidence`, assessment.evidence, { placeholder: "What facts support this score?" })}</article>`;
      }).join("")}</div>
    </section>
  </div>`;
}

function scopeTab(model: Snapshot): string {
  const { estimate, policy } = model;
  const workstreams = estimate.workstreams.length === 0
    ? `<div class="empty">No workstreams yet. Add the customer-visible outcomes that create the delivery obligation.</div>`
    : `<div class="table-wrap"><table><thead><tr><th>Workstream</th><th>Description</th><th>Low</th><th>Likely</th><th>High</th><th></th></tr></thead><tbody>${estimate.workstreams.map((stream, index) => `
      <tr><td><input aria-label="Workstream name" data-path="workstreams.${index}.name" value="${escapeHtml(stream.name)}"></td>
      <td><input aria-label="Workstream description" data-path="workstreams.${index}.description" value="${escapeHtml(stream.description)}"></td>
      <td><input aria-label="Low hours" data-path="workstreams.${index}.lowHours" type="number" min="0" value="${stream.lowHours}"></td>
      <td><input aria-label="Likely hours" data-path="workstreams.${index}.likelyHours" type="number" min="0" value="${stream.likelyHours}"></td>
      <td><input aria-label="High hours" data-path="workstreams.${index}.highHours" type="number" min="0" value="${stream.highHours}"></td>
      <td><button class="button danger small" data-action="remove-workstream" data-index="${index}" aria-label="Remove ${escapeHtml(stream.name)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`;
  const teamTotal = estimate.team.reduce((sum, role) => sum + role.allocationPct, 0);
  const team = `<div class="table-wrap"><table><thead><tr><th>Internal role</th><th>Allocation</th><th>Why needed</th><th></th></tr></thead><tbody>${estimate.team.map((allocation, index) => `
    <tr><td><select aria-label="Team role" data-path="team.${index}.roleId">${policy.roles.map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === allocation.roleId ? "selected" : ""}>${escapeHtml(role.label)}</option>`).join("")}</select></td>
    <td><input aria-label="Allocation percent" data-path="team.${index}.allocationPct" type="number" min="0" max="100" value="${allocation.allocationPct}"></td>
    <td><input aria-label="Role rationale" data-path="team.${index}.rationale" value="${escapeHtml(allocation.rationale)}"></td>
    <td><button class="button danger small" data-action="remove-team" data-index="${index}" aria-label="Remove team role">Remove</button></td></tr>`).join("")}</tbody></table></div>`;
  const costs = estimate.thirdPartyCosts.length === 0
    ? `<div class="empty">No third-party or pass-through costs.</div>`
    : `<div class="table-wrap"><table><thead><tr><th>Cost</th><th>Amount</th><th></th></tr></thead><tbody>${estimate.thirdPartyCosts.map((cost, index) => `
      <tr><td><input aria-label="Cost name" data-path="thirdPartyCosts.${index}.name" value="${escapeHtml(cost.name)}"></td>
      <td><input aria-label="Cost amount" data-path="thirdPartyCosts.${index}.amount" type="number" min="0" value="${cost.amount}"></td>
      <td><button class="button danger small" data-action="remove-cost" data-index="${index}" aria-label="Remove ${escapeHtml(cost.name)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`;
  const comparables = estimate.comparables.length === 0
    ? `<div class="empty">No close comparables yet. Add normalized historical or market evidence when it genuinely resembles this obligation.</div>`
    : `<div class="table-wrap"><table><thead><tr><th>Comparable</th><th>Reference price</th><th>Date</th><th>Similarity</th><th>Evidence</th><th></th></tr></thead><tbody>${estimate.comparables.map((comparable, index) => `
      <tr><td><input aria-label="Comparable name" data-path="comparables.${index}.name" value="${escapeHtml(comparable.name)}"></td>
      <td><input aria-label="Comparable reference price" data-path="comparables.${index}.referencePrice" type="number" min="0" value="${comparable.referencePrice}"></td>
      <td><input aria-label="Comparable reference date" data-path="comparables.${index}.referenceDate" type="date" value="${escapeHtml(comparable.referenceDate)}"></td>
      <td><select aria-label="Comparable similarity" data-path="comparables.${index}.similarityScore">${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${value === comparable.similarityScore ? "selected" : ""}>${value} / 5</option>`).join("")}</select></td>
      <td><input aria-label="Comparable evidence" data-path="comparables.${index}.notes" value="${escapeHtml(comparable.notes)}"></td>
      <td><button class="button danger small" data-action="remove-comparable" data-index="${index}" aria-label="Remove ${escapeHtml(comparable.name)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`;
  return `<div class="stack" data-commercial>
    <section class="card"><div class="card-head"><div><h2>Workstreams and effort range</h2><p class="card-copy">Estimate each obligation at low, likely, and high effort. The engine combines ranges into P50/P80/P90.</p></div><button class="button small" data-action="add-workstream">Add workstream</button></div>${workstreams}</section>
    <section class="card"><div class="card-head"><div><h2>Team composition</h2><p class="card-copy">Internal economics only. Customer pricing is not presented as rate × headcount.</p></div><button class="button secondary small" data-action="add-team">Add role</button></div>${team}<div class="notice">Allocation total: <strong>${teamTotal}%</strong>. It must equal 100%.</div></section>
    <section class="card"><div class="card-head"><div><h2>Third-party costs</h2><p class="card-copy">Licensing, travel, cloud, subcontractors, and other direct engagement costs.</p></div><button class="button secondary small" data-action="add-cost">Add cost</button></div>${costs}</section>
    <section class="card"><div class="card-head"><div><h2>Close comparables</h2><p class="card-copy">Only similarity scores 4–5 affect the credibility floor. Reference prices are escalated to the delivery start date.</p></div><button class="button secondary small" data-action="add-comparable">Add comparable</button></div>${comparables}</section>
  </div>`;
}

function riskTab(model: Snapshot): string {
  const { estimate } = model;
  const risks = estimate.risks.length === 0
    ? `<div class="empty">No quantified risks. High-risk engagements require a residual risk register.</div>`
    : `<div class="table-wrap"><table><thead><tr><th>Risk</th><th>Probability %</th><th>Impact $</th><th>Mitigation</th><th>Effective %</th><th>Owner</th><th></th></tr></thead><tbody>${estimate.risks.map((risk, index) => `
      <tr><td><input aria-label="Risk description" data-path="risks.${index}.description" value="${escapeHtml(risk.description)}"></td>
      <td><input aria-label="Risk probability" data-path="risks.${index}.probabilityPct" type="number" min="0" max="100" value="${risk.probabilityPct}"></td>
      <td><input aria-label="Risk impact" data-path="risks.${index}.impactCost" type="number" min="0" value="${risk.impactCost}"></td>
      <td><input aria-label="Risk mitigation" data-path="risks.${index}.mitigation" value="${escapeHtml(risk.mitigation)}"></td>
      <td><input aria-label="Mitigation effectiveness" data-path="risks.${index}.mitigationEffectivenessPct" type="number" min="0" max="100" value="${risk.mitigationEffectivenessPct}"></td>
      <td><input aria-label="Risk owner" data-path="risks.${index}.owner" value="${escapeHtml(risk.owner)}"></td>
      <td><button class="button danger small" data-action="remove-risk" data-index="${index}" aria-label="Remove risk">Remove</button></td></tr>`).join("")}</tbody></table></div>`;
  return `<div class="stack" data-commercial>
    <section class="card"><div class="card-head"><div><h2>Residual risk register</h2><p class="card-copy">Reserve = probability × financial impact × residual exposure after mitigation. Policy floors still apply.</p></div><button class="button small" data-action="add-risk">Add risk</button></div>${risks}</section>
    <section class="card"><div class="card-head"><div><h2>Contract boundaries</h2><p class="card-copy">One item per line. These terms are pricing inputs and SOW guardrails, not afterthoughts.</p></div></div>
      <div class="form-grid">
        ${textarea("Assumptions", "terms.assumptions", lines(estimate.terms.assumptions), { lines: true, placeholder: "Customer provides timely system access" })}
        ${textarea("Exclusions", "terms.exclusions", lines(estimate.terms.exclusions), { lines: true, placeholder: "Production support after warranty" })}
        ${textarea("Customer and vendor dependencies", "terms.dependencies", lines(estimate.terms.dependencies), { lines: true })}
        ${textarea("Acceptance criteria", "terms.acceptanceCriteria", lines(estimate.terms.acceptanceCriteria), { lines: true, help: "Required to clear the discovery gate." })}
        ${textarea("Payment terms", "terms.paymentTerms", estimate.terms.paymentTerms, { placeholder: "Milestones, timing, holdbacks, and acceptance windows" })}
        ${textarea("Change control", "terms.changeControl", estimate.terms.changeControl, { placeholder: "What creates a priced change rather than retained completion risk?" })}
        ${field("Warranty / hypercare weeks", "terms.warrantyWeeks", estimate.terms.warrantyWeeks, { type: "number", min: 0, max: 104 })}
      </div>
    </section>
  </div>`;
}

function reviewTab(model: Snapshot): string {
  const { estimate, calculation } = model;
  const scenario = (label: string, key: "p50" | "p80" | "p90", description: string) => {
    const value = calculation.scenarios[key];
    return `<article class="scenario ${key === "p80" ? "recommended" : ""}"><div class="eyebrow">${label}</div><div class="amount">${money(value.price)}</div><p class="card-copy">${description}</p><dl>
      <div><dt>Effort</dt><dd>${value.effortHours.toLocaleString()} h</dd></div>
      <div><dt>Delivery cost</dt><dd>${money(value.deliveryCost)}</dd></div>
      <div><dt>Market reference</dt><dd>${money(value.marketReference)}</dd></div>
    </dl></article>`;
  };
  const guardrails = [
    ...calculation.ineligibilityReasons.map((message) => ({ type: "Eligibility", message })),
    ...calculation.discoveryReasons.map((message) => ({ type: "Discovery", message })),
    ...calculation.approvals.map(({ message }) => ({ type: "Approval", message })),
  ];
  return `<div class="stack">
    <section class="card"><div class="card-head"><div><h2>Confidence-priced range</h2><p class="card-copy">P80 is the default recommendation. P50 is not a discount target; P90 is the high-confidence commitment.</p></div></div>
      <div class="scenario-grid">${scenario("P50 · low", "p50", "Expected delivery case with minimum credibility floors.")}${scenario("P80 · recommended", "p80", "Default fixed-bid commitment and margin view.")}${scenario("P90 · high", "p90", "Higher confidence where commitment risk warrants it.")}</div>
    </section>
    <section class="card" data-commercial><div class="card-head"><div><h2>One-off commercial adjustment</h2><p class="card-copy">A proposed price never changes the deterministic recommendation. It only exposes the approvals and margin consequences.</p></div></div>
      <div class="form-grid">${field("Proposed customer price", "project.proposedPrice", estimate.project.proposedPrice, { type: "number", min: 0, help: "Leave blank to use recommended P80." })}</div>
    </section>
    <section class="card"><div class="card-head"><div><h2>Floors and reserves</h2></div></div><div class="metric-list">
      <div class="metric"><span>Minimum sustainable P80 price</span><strong>${money(calculation.minimumSustainablePrice)}</strong></div>
      <div class="metric"><span>Market credibility floor</span><strong>${money(calculation.marketCredibilityFloor)}</strong></div>
      ${calculation.closeComparableMedian === null ? "" : `<div class="metric"><span>Inflation-adjusted close-comparable median</span><strong>${money(calculation.closeComparableMedian)}</strong></div>`}
      ${calculation.closeComparableFloor === null ? "" : `<div class="metric"><span>Close-comparable credibility floor</span><strong>${money(calculation.closeComparableFloor)}</strong></div>`}
      <div class="metric"><span>Engagement-class minimum</span><strong>${money(calculation.engagementMinimum)}</strong></div>
      <div class="metric"><span>Residual risk reserve</span><strong>${money(calculation.riskReserve)}</strong></div>
      <div class="metric"><span>Warranty reserve</span><strong>${money(calculation.warrantyReserve)}</strong></div>
    </div></section>
    <section class="card"><div class="card-head"><div><h2>Guardrails and approvals</h2><p class="card-copy">Resolve every required item before issuing a SOW.</p></div></div>${guardrails.length
      ? `<ul class="side-list">${guardrails.map(({ type, message }) => `<li><strong>${type}:</strong> ${escapeHtml(message)}</li>`).join("")}</ul>`
      : `<div class="empty">No deterministic guardrail is currently open.</div>`}</section>
    ${commercialLifecycle(model)}
    <section class="card"><div class="card-head"><div><h2>Close the learning loop</h2><p class="card-copy">Actuals calibrate future policy. They never rewrite the signed estimate.</p></div></div><div class="form-grid three">
      ${selectField("Outcome", "actuals.status", estimate.actuals.status, Object.entries(STATUS_LABELS))}
      ${field("Contracted price", "actuals.contractedPrice", estimate.actuals.contractedPrice, { type: "number", min: 0 })}
      ${field("Actual hours", "actuals.actualHours", estimate.actuals.actualHours, { type: "number", min: 0 })}
      ${field("Actual delivery cost", "actuals.actualCost", estimate.actuals.actualCost, { type: "number", min: 0 })}
      ${field("Warranty / support cost", "actuals.warrantyCost", estimate.actuals.warrantyCost, { type: "number", min: 0 })}
      ${textarea("Win/loss and outcome notes", "actuals.outcomeNotes", estimate.actuals.outcomeNotes)}
    </div>${calculation.backtest.realizedMarginPct !== null || calculation.backtest.effortVariancePct !== null
      ? `<div class="notice">Realized margin: <strong>${calculation.backtest.realizedMarginPct ?? "—"}%</strong> · P50 effort variance: <strong>${calculation.backtest.effortVariancePct ?? "—"}%</strong></div>`
      : ""}</section>
  </div>`;
}

function commercialLifecycle(model: Snapshot): string {
  const { commercialStatus } = model.estimate;
  const canAdvance = model.calculation.fixedBidEligible && !model.calculation.discoveryRequired;
  const explanation = commercialStatus === "draft"
    ? "Approve only after reviewing the estimate and any policy exceptions. Approval locks commercial inputs until the estimate is explicitly reopened."
    : commercialStatus === "approved"
      ? "Commercial inputs are locked. Reopen to make changes, or mark the estimate signed to make the baseline permanent."
      : "The signed commercial baseline is permanent. Post-engagement actuals remain editable for calibration.";
  const actions = commercialStatus === "draft"
    ? `<button class="button" data-action="set-commercial-status" data-status="approved" ${canAdvance ? "" : "disabled"}>Approve estimate</button>`
    : commercialStatus === "approved"
      ? `<button class="button secondary" data-action="set-commercial-status" data-status="draft">Reopen as draft</button><button class="button" data-action="set-commercial-status" data-status="signed">Mark signed</button>`
      : "";
  return `<section class="card"><div class="card-head"><div><h2>Commercial lifecycle</h2><p class="card-copy">${explanation}</p></div><span class="policy-chip"><strong>${COMMERCIAL_STATUS_LABELS[commercialStatus]}</strong></span></div>
    ${actions ? `<div class="button-row">${actions}</div>` : ""}
    ${commercialStatus === "draft" && !canAdvance ? `<div class="notice">Resolve fixed-bid eligibility and paid-discovery gates before approval.</div>` : ""}
    ${commercialStatus === "draft" && model.calculation.approvals.length > 0 ? `<div class="notice">Approval acknowledges ${model.calculation.approvals.length} visible policy exception(s); leadership should review them before continuing.</div>` : ""}
  </section>`;
}

function sidebar(model: Snapshot): string {
  const { calculation } = model;
  return `<aside class="stack">
    <section class="card"><div class="card-head"><div><h2>Price drivers</h2></div></div><ul class="side-list">${calculation.drivers.map((driver) => `<li>${escapeHtml(driver)}</li>`).join("")}</ul>
      ${model.policy.calibrationStatus === "initial" ? `<div class="notice"><strong>Initial policy.</strong> Calibrate role economics, overruns, margin, warranty consumption, and win/loss outcomes with company actuals before treating these defaults as settled.</div>` : ""}</section>
    <section class="card"><div class="card-head"><div><h2>Recent changes</h2></div></div><div class="audit">${model.auditTrail.slice(-8).toReversed().map((entry) => `<div class="audit-entry"><strong>r${entry.revision}</strong> · ${escapeHtml(entry.summary)}<time>${dateTime(entry.occurredAt)}</time></div>`).join("")}</div></section>
  </aside>`;
}

function printSummary(model: Snapshot): string {
  const { estimate, calculation } = model;
  return `<section class="print-summary"><div class="card"><h2>${escapeHtml(estimate.project.name)}</h2><p class="card-copy">${escapeHtml(estimate.project.customer)} · ${escapeHtml(CLASS_LABELS[estimate.project.engagementClass])} · ${COMMERCIAL_STATUS_LABELS[estimate.commercialStatus]} · Policy ${escapeHtml(model.policy.version)}</p></div>
    <div class="card"><h2>Commercial recommendation</h2><div class="metric-list">
      <div class="metric"><span>Recommended P80</span><strong>${money(calculation.recommendedPrice)}</strong></div>
      <div class="metric"><span>Selected price</span><strong>${money(calculation.selectedPrice)}</strong></div>
      <div class="metric"><span>Range</span><strong>${money(calculation.scenarios.p50.price)} – ${money(calculation.scenarios.p90.price)}</strong></div>
      <div class="metric"><span>Estimated P80 gross margin</span><strong>${calculation.estimatedGrossMarginPct}%</strong></div>
    </div></div>
    <div class="card"><h2>Readiness</h2><ul class="side-list">${[
      ...(calculation.ineligibilityReasons.length ? calculation.ineligibilityReasons : ["Fixed-bid eligibility gate clear."]),
      ...(calculation.discoveryReasons.length ? calculation.discoveryReasons : ["Paid-discovery gate clear."]),
      ...calculation.approvals.map((approval) => approval.message),
    ].map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div></section>`;
}

function render(): void {
  if (!snapshot) {
    app.innerHTML = `<div class="shell"><section class="card"><h1>Loading fixed-bid pricing…</h1></section></div>`;
    return;
  }
  const tabs: Array<[Tab, string]> = [
    ["overview", "Overview & pillars"],
    ["scope", "Scope & team"],
    ["risk", "Risk & terms"],
    ["review", "Review & actuals"],
  ];
  const content = activeTab === "overview" ? overviewTab(snapshot)
    : activeTab === "scope" ? scopeTab(snapshot)
    : activeTab === "risk" ? riskTab(snapshot)
    : reviewTab(snapshot);
  app.innerHTML = `<div class="shell">
    <header class="topbar"><div><div class="eyebrow">In Time Tec · Commercial planning</div><h1>${escapeHtml(snapshot.estimate.project.name)}</h1><p class="muted">Fixed-bid SOW pricing built on delivery economics, evidence, and retained risk.</p></div>
      <div class="policy-chip"><strong>${COMMERCIAL_STATUS_LABELS[snapshot.estimate.commercialStatus]}</strong> · ${escapeHtml(snapshot.policy.version)} · effective ${escapeHtml(snapshot.policy.effectiveDate)} · revision ${snapshot.revision}</div></header>
    ${topSummary(snapshot)}${proposals(snapshot)}
    <nav class="tabs" role="tablist" aria-label="Estimate sections">${tabs.map(([key, label]) => `<button class="tab" role="tab" aria-selected="${activeTab === key}" data-tab="${key}">${label}</button>`).join("")}</nav>
    <div class="layout screen-content"><section>${content}</section>${sidebar(snapshot)}</div>
    ${printSummary(snapshot)}
  </div><div id="save-status" role="status" aria-live="polite"></div>`;
  if (snapshot.estimate.commercialStatus !== "draft") {
    for (const control of app.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
      "[data-commercial] input, [data-commercial] select, [data-commercial] textarea, [data-commercial] button",
    )) {
      control.disabled = true;
    }
    for (const section of app.querySelectorAll<HTMLElement>("[data-commercial]")) {
      section.classList.add("locked");
    }
  }
}

function showStatus(message: string, error = false): void {
  window.clearTimeout(statusTimer);
  const element = document.querySelector<HTMLDivElement>("#save-status");
  if (!element) return;
  element.textContent = message;
  element.className = `visible${error ? " error" : ""}`;
  statusTimer = window.setTimeout(() => { element.className = ""; }, error ? 5_000 : 1_600);
}

function setPath(target: unknown, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = target as Record<string, unknown>;
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = cursor[parts[index]] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function queueUpdate(mutate: (estimate: EstimateDocument) => void, summary = "Updated estimate"): void {
  mutationQueue = mutationQueue.then(async () => {
    if (!snapshot) return;
    const estimate = structuredClone(snapshot.estimate);
    mutate(estimate);
    showStatus("Saving…");
    try {
      snapshot = await gadget.updateEstimate({
        expectedRevision: snapshot.revision,
        estimate,
        summary,
      }) as Snapshot;
      render();
      showStatus("Saved");
    } catch (caught) {
      snapshot = await gadget.getEstimate() as Snapshot;
      render();
      showStatus(caught instanceof Error ? caught.message : "Could not save estimate.", true);
    }
  });
}

function numberValue(element: HTMLInputElement): number | null {
  if (element.value === "") return null;
  const value = Number(element.value);
  return Number.isFinite(value) ? value : 0;
}

app.addEventListener("change", (event) => {
  const element = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const path = element.dataset.path;
  if (!path) return;
  const value = element.dataset.lines === "true"
    ? element.value.split("\n").map((line) => line.trim()).filter(Boolean)
    : element instanceof HTMLInputElement && element.type === "number"
      ? numberValue(element)
      : element.value;
  queueUpdate((estimate) => setPath(estimate, path, value), `Updated ${path}`);
});

app.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button) return;
  const tab = button.dataset.tab as Tab | undefined;
  if (tab) {
    activeTab = tab;
    render();
    document.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.focus();
    return;
  }
  const action = button.dataset.action;
  const index = Number(button.dataset.index);
  if (action === "add-workstream") queueUpdate((estimate) => estimate.workstreams.push({ id: crypto.randomUUID(), name: "New workstream", description: "", lowHours: 0, likelyHours: 0, highHours: 0 }), "Added workstream");
  if (action === "remove-workstream") queueUpdate((estimate) => estimate.workstreams.splice(index, 1), "Removed workstream");
  if (action === "add-team") queueUpdate((estimate) => {
    if (!snapshot) return;
    const used = new Set(estimate.team.map((role) => role.roleId));
    const role = snapshot.policy.roles.find((candidate) => !used.has(candidate.id));
    if (role) estimate.team.push({ roleId: role.id, allocationPct: 0, rationale: "" });
  }, "Added team role");
  if (action === "remove-team") queueUpdate((estimate) => estimate.team.splice(index, 1), "Removed team role");
  if (action === "add-cost") queueUpdate((estimate) => estimate.thirdPartyCosts.push({ id: crypto.randomUUID(), name: "New direct cost", amount: 0 }), "Added direct cost");
  if (action === "remove-cost") queueUpdate((estimate) => estimate.thirdPartyCosts.splice(index, 1), "Removed direct cost");
  if (action === "add-comparable") queueUpdate((estimate) => estimate.comparables.push({ id: crypto.randomUUID(), name: "New comparable", referencePrice: 0, referenceDate: "", similarityScore: 3, notes: "" }), "Added comparable");
  if (action === "remove-comparable") queueUpdate((estimate) => estimate.comparables.splice(index, 1), "Removed comparable");
  if (action === "add-risk") queueUpdate((estimate) => estimate.risks.push({ id: crypto.randomUUID(), description: "New risk", probabilityPct: 25, impactCost: 0, mitigation: "", mitigationEffectivenessPct: 0, owner: "" }), "Added risk");
  if (action === "remove-risk") queueUpdate((estimate) => estimate.risks.splice(index, 1), "Removed risk");
  if (action === "set-commercial-status") {
    const status = button.dataset.status as EstimateDocument["commercialStatus"];
    if (status === "signed" && !window.confirm(
      "Mark this estimate signed? Its commercial baseline cannot be reopened or edited afterward.",
    )) return;
    if (status === "draft" && !window.confirm(
      "Reopen this approved estimate? It will require approval again after commercial changes.",
    )) return;
    if (status === "approved" && snapshot && snapshot.calculation.approvals.length > 0 &&
        !window.confirm(
          `Approve while acknowledging ${snapshot.calculation.approvals.length} visible policy exception(s)?`,
        )) return;
    queueUpdate(
      (estimate) => { estimate.commercialStatus = status; },
      `Marked estimate ${COMMERCIAL_STATUS_LABELS[status].toLowerCase()}`,
    );
  }
  if (action === "approve-proposal" || action === "reject-proposal") {
    mutationQueue = mutationQueue.then(async () => {
      try {
        snapshot = await (action === "approve-proposal"
          ? gadget.approveProposal({ id: button.dataset.id })
          : gadget.rejectProposal({ id: button.dataset.id })) as Snapshot;
        render();
        showStatus(action === "approve-proposal" ? "Proposal applied" : "Proposal rejected");
      } catch (caught) {
        showStatus(caught instanceof Error ? caught.message : "Could not resolve proposal.", true);
      }
    });
  }
});

class EstimateSubscription extends RpcTarget {
  update(next: Snapshot): void {
    snapshot = next;
    render();
  }

  [Symbol.dispose](): void {
    window.setTimeout(() => void subscribe(), 1_000);
  }
}

async function subscribe(): Promise<void> {
  try {
    const initial = await gadget.subscribe(new EstimateSubscription()) as Snapshot;
    snapshot = initial;
    render();
  } catch {
    window.setTimeout(() => void subscribe(), 1_500);
  }
}

render();
void subscribe();
