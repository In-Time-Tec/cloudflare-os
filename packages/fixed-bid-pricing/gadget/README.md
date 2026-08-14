# Fixed-Bid SOW Pricing

This Gadget creates a defensible fixed-bid range from delivery economics, market credibility,
explicit residual risk, and six pricing pillars: **Speed, Complexity, Experience, Expertise, Risk,
and Team Composition**.

The calculation is deterministic. AI can help structure evidence and propose edits, but AI does not
calculate the final price and must not silently change estimate state.

## Agent workflow

1. Call `getEstimate()` to read the current estimate, calculation, pending proposals, policy summary,
   and `revision`.
2. Ask for missing facts rather than inventing pillar evidence, effort, contract terms, costs, or
   risk values.
3. Translate requested edits into typed operations and call `proposeChanges()` with the current
   revision and a concise summary.
4. Explain the returned before/after impact. The person applies or rejects the proposal in the
   Gadget UI.

Check `estimate.commercialStatus` before proposing. Commercial proposals are accepted only while it
is `draft`. A person may reopen an `approved` estimate in the UI; a `signed` estimate is permanent
and accepts only post-engagement actuals.

**Never call `updateEstimate()` or `approveProposal()` from an agent turn.** Those methods exist for
the interactive UI. Agents use `proposeChanges()` so the user sees a preview before state changes.

Example:

```js
const current = await env.ESTIMATE.getEstimate();
const proposal = await env.ESTIMATE.proposeChanges({
  expectedRevision: current.revision,
  summary: "Add Salesforce integration and raise Complexity to 4/5",
  operations: [
    {
      type: "upsertWorkstream",
      workstream: {
        id: "salesforce-integration",
        name: "Salesforce integration",
        description: "Authenticate, synchronize agreed objects, and prove reconciliation",
        lowHours: 100,
        likelyHours: 160,
        highHours: 260,
      },
    },
    {
      type: "setPillars",
      patch: {
        complexity: { score: 4, evidence: "Adds a bidirectional production integration" },
      },
    },
  ],
});
```

Supported operations:

- `setProject` with a partial project patch
- `setPillars` with partial pillar assessments
- `upsertWorkstream` / `removeWorkstream`
- `setTeam`
- `setThirdPartyCosts`
- `setComparables`
- `upsertRisk` / `removeRisk`
- `setTerms`
- `setActuals`

Use `getPricingSummary()` when only the current project and deterministic pricing outputs are needed.

## Pricing behavior

- Workstreams use low/likely/high estimates to produce P50/P80/P90 effort.
- P80 is the default recommended fixed-bid commitment.
- Speed affects delivery economics. Complexity, Experience, and Team Composition jointly affect the
  confidence range rather than stacking correlated multipliers.
- Experience changes confidence, not the expected effort or an automatic premium.
- Expertise affects the market credibility reference.
- References scored 4–5 for similarity produce an inflation-adjusted close-comparable median and
  credibility floor; weaker analogs remain visible evidence but do not move price.
- Risk is an explicit residual reserve with a score-based minimum floor.
- Team Composition supplies the hidden internal economic mix; it is not customer-facing
  rate-times-headcount pricing.
- The selected price cannot hide minimum-margin, market-floor, discovery, or eligibility warnings.
- The commercial lifecycle is `draft → approved → signed`; eligibility and discovery gates block
  advancement, approved commercial inputs are locked until reopened, and signed inputs are
  immutable.

Every estimate is pinned to the policy version shown in the header. Repository updates create a new
Blueprint revision but do not silently rewrite an existing or signed estimate.
