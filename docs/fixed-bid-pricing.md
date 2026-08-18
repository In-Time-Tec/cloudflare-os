# Fixed-bid pricing

The deployment ships `intimetec.fixed-bid-pricing` as a bundled Template. It creates an independent,
durable estimate Gadget for each engagement and exposes that Gadget's RPC methods to the workspace
agent through the ordinary Cloudflare OS Gadget binding. It requires no MCP server and adds no
pricing behavior to the Workshop kernel.

The executable owner is [`packages/fixed-bid-pricing/src/pricing.ts`](../packages/fixed-bid-pricing/src/pricing.ts).
This document explains the policy model and maintenance workflow; it is not a second calculator.

## Commercial premise

A fixed bid prices the delivery obligation and risk retained by the vendor. Hours and role economics
remain necessary internal evidence, but the customer-facing price is not `rate × headcount`.

The engine calculates three confidence scenarios and chooses the largest applicable floor:

```text
delivery cost =
  role-weighted internal labor
  + third-party costs
  + residual risk reserve
  + warranty reserve

scenario price = max(
  delivery cost / (1 - target margin),
  market credibility reference,
  inflation-adjusted close-comparable floor,
  engagement-class minimum
)
```

P80 is the default recommendation. P50 is the low-confidence bound, not a negotiation discount, and
P90 is the higher-confidence bound. A one-off proposed price does not change the deterministic
recommendation; it exposes margin and approval consequences beside it.

## Six pillars

The pillars are not six stacked price multipliers:

| Pillar | Policy role |
| --- | --- |
| Speed | Adjusts delivery economics for compression, parallel work, ramp-up, and response commitments. |
| Complexity | Widens or narrows the effort confidence range. |
| Experience | Close successful analogs change confidence, not expected effort or an automatic premium. |
| Expertise | Adjusts the market credibility reference for scarce specialization and domain value. |
| Risk | Sets a minimum reserve and requires an explicit probability/impact/mitigation register. |
| Team Composition | Supplies role-weighted internal economics and changes confidence based on delivery resilience. |

Complexity, Experience, and Team Composition describe correlated uncertainty in the same estimate.
The engine combines their deltas once instead of multiplying them together.

## Guardrails

The deterministic engine returns explicit states rather than only a number:

- fixed-bid eligibility and blocking reasons;
- mandatory paid-discovery triggers;
- minimum sustainable P80 price at policy minimum margin;
- a comparable-market credibility floor;
- an inflation-adjusted floor from the median of engagements explicitly scored 4–5 for similarity;
- an engagement-class minimum;
- leadership approvals for below-policy margin or one-off price exceptions; and
- assumptions, exclusions, dependencies, acceptance, payment, warranty, and change-control inputs.

The estimate lifecycle is `draft → approved → signed`. Advancing is blocked while fixed-bid
eligibility or paid-discovery gates are open. Approval locks commercial inputs until a person
explicitly reopens the estimate; signing makes the commercial baseline permanent. Actual delivery
and outcome data remains writable after signing because it does not alter the accepted baseline.

Actual hours, costs, warranty consumption, contracted value, outcome, and win/loss notes are stored
separately for back-testing. They never rewrite the signed estimate.

## Initial defaults and calibration

Policy `itt-fixed-bid-2026.1` is deliberately marked **initial**, not proven. Its starting ranges use:

- [GSA CALC+](https://buy.gsa.gov/pricing/qr/know-more) awarded-contract labor ceilings as broad
  market references rather than a promise of commercial realized rates;
- [BLS Employer Costs for Employee Compensation](https://www.bls.gov/ecec/tables.htm) evidence to
  distinguish wages from total employer cost; and
- 2.95% annual labor escalation, the calculated change from 171.042 in Q2 2025 to 176.093 in Q2
  2026 for the BLS professional, scientific, and technical-services total-compensation ECI
  [series](https://fred.stlouisfed.org/series/CIS2015400000000I). The underlying
  [June 2026 BLS release](https://www.bls.gov/news.release/eci.nr0.htm) reported 3.3% annual total
  private-industry compensation growth overall.

These sources do not establish In Time Tec's profitability. Leadership should calibrate the policy
with normalized company data for actual fully burdened cost, effort variance, rework, warranty usage,
realized margin, collections timing, and win/loss reasons. Do not put customer identities, contract
text, or raw confidential SOWs into a bundled Template or an external model prompt.

Individual estimates may record normalized comparable references in their own durable Gadget state.
Only references scored 4–5 for similarity affect pricing. Their reference prices are escalated to
the planned delivery start, and 80% of their median becomes one credibility floor. This ratio is an
initial policy value to calibrate with outcomes, not a claim that every historical bid was correct.

## Agent interaction

Agents read `getEstimate()` or `getPricingSummary()`. To change an estimate, an agent submits typed
operations to `proposeChanges()`. The Gadget calculates and stores a before/after preview. A person
applies or rejects it in the UI.

Agents cannot propose commercial changes to an approved or signed estimate. A person must first
reopen an approved estimate in the UI; signed estimates cannot be reopened.

`updateEstimate()` and `approveProposal()` support the interactive UI and are not the agent workflow.
The bundled Gadget README includes the exact operation forms so a workspace agent does not have to
infer them.

## Versioning and existing estimates

Each estimate records its policy version. Updating the repository and bundled Template updates what
new Gadget instances receive; Cloudflare OS intentionally does not overwrite existing Template
instances. That behavior protects approved and signed estimates from silent policy changes.

A later centrally managed policy service may be justified when enough calibration data and migration
requirements exist. It should still create explicit new estimate revisions rather than changing old
calculations in place.

For the source-to-archive build and release procedure, see
[`packages/fixed-bid-pricing/README.md`](../packages/fixed-bid-pricing/README.md).
