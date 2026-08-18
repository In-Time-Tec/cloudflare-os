# Fixed-bid pricing Template

This package owns the deterministic pricing domain and the source of the bundled **Fixed-Bid SOW
Pricing** Gadget. It does not depend on the Workshop kernel and does not contain customer SOWs or
historical contract text.

## Ownership

- `src/pricing.ts` owns the versioned policy, input normalization, calculations, guardrails, and typed
  proposal operations. It also owns the draft → approved → signed lifecycle invariant.
- `gadget/server.ts` owns durable estimate state, optimistic revision checks, proposal preview/apply,
  audit history, and the Gadget RPC surface.
- `gadget/client.ts` owns the interactive estimator UI.
- `gadget/README.md` is bundled into every instance and tells workspace agents how to use the RPC
  surface safely.
- `scripts/build-template.mjs` reproducibly bundles those sources into
  `../workshop-backend/format-templates/fixed-bid-pricing.template`.

The checked-in archive remains compatible with Cloudflare OS's ordinary bundled-Template installer,
while source and tests remain reviewable in this package.

Approved estimates must be explicitly reopened before commercial inputs can change. Signed
estimates cannot be reopened; only their post-engagement actuals remain writable. The Gadget server
enforces this invariant for both direct UI updates and agent proposals.

## Commands

```sh
pnpm --filter @intimetec/fixed-bid-pricing test
pnpm --filter @intimetec/fixed-bid-pricing build
pnpm --filter @intimetec/fixed-bid-pricing build:template
```

`build` fails when the checked-in `.template` does not match source. Run `build:template` after an
intentional source change, then review and commit both source and archive.

When changing code or policy after deployment:

1. update and test the TypeScript source;
2. increment `version` and `lastUpdated` in `template.json`;
3. increment `revision` in the Template sidecar;
4. run `build:template`; and
5. deploy normally.

Do not change the sidecar's `templateId`; it is the stable installation key.
