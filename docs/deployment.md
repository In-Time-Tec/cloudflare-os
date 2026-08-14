# In Time Tec deployment

This fork deploys Cloudflare OS to a temporary `workers.dev` environment after the `CI` workflow
succeeds for a push to `main`. The canonical release operation is the
root `pnpm deploy` command. The [`Deploy workers.dev`](../.github/workflows/deploy.yml) workflow
installs the repository and calls that same command; developers do not deploy individual packages
or Workers.

## Release flow

```text
push or merge to main
        |
        v
Blacksmith CI (lint, build, test)
        |
        v
Deploy workers.dev workflow
        |
        v
pnpm deploy
        |
        v
Cloudflare Workers + KV + R2
```

[`scripts/deploy.mjs`](../scripts/deploy.mjs) owns the complete operation: it validates deployment
configuration, reconciles stable KV and R2 resources, builds the required packages, derives
production Wrangler configurations from each package's checked-in base config, deploys private
dependencies in order, and publishes the router last. This code lives in the fork instead of
modifying upstream application packages or patching an external deployment repository. The
temporary environment uses Cloudflare OS's built-in password accounts; Microsoft Entra ID will
replace them in Phase 1.

## Deployment identities and state

[`workers-dev.jsonc`](../deployment/workers-dev.jsonc) owns the non-secret deployment
configuration:

| Capability | Stable identity |
| --- | --- |
| Public router | `intimetec-cloudflare-os` |
| Workshop backend | `intimetec-cloudflare-os-backend` |
| Context Gatekeeper | `intimetec-cloudflare-os-context` |
| Scheduler Gatekeeper | `intimetec-cloudflare-os-scheduler` |
| Context sharing domain | `intimetec-workers-dev` |
| Managed AI provider | OpenRouter |
| Default model | GPT 5.6 Luna (`openai/gpt-5.6-luna`) |
| Blueprint metadata KV | `intimetec-cloudflare-os-backend-blueprints` |
| Avatar KV | `intimetec-cloudflare-os-backend-avatars` |
| Blueprint content R2 | `intimetec-cloudflare-os-backend-blueprint-content` |
| Context collections KV | `intimetec-cloudflare-os-context-context-collections` |

The deploy command looks up each resource by its stable name, creates only what is missing, and
writes the resolved KV IDs and R2 bucket name into its temporary Wrangler configurations. This
keeps stateless CI retries safe after partial deployments and preserves user, Durable Object, KV,
and R2 state. Do not rename these Workers or resources, change the Context sharing domain, or
replace resource bindings as routine release work; that creates or points at a different deployment
identity.

The evaluation administrator is the built-in username `dallenpyrah`. On the first visit, create an
account using exactly that username to receive `/admin` access. Account signup is initially open so
the first account can be created. Close signups in `/admin` after creating the intended evaluation
accounts.

AI is deployment-funded for every account. The backend exposes a curated OpenRouter catalog in the
model picker, with GPT 5.6 Luna first and therefore selected by default when a user has no saved
choice. The catalog currently contains GPT 5.6 Luna/Sol/Terra, Claude Sonnet 5, Claude Opus 5,
Gemini 3.6 Flash, and Kimi K2.7 Code. These entries were selected from OpenRouter's live catalog
because they advertise tool calling and image input; batch, specialized, and tool-less models are
not exposed to agents.

Users can select among those models but cannot add, delete, or route through personal model
providers while managed AI is enabled. The backend enforces that boundary, so hiding the UI is not
the security control. Model records returned over RPC contain an empty token; inference replaces it
with the backend Worker secret only after the model has been resolved against the managed catalog.
Microsoft Graph and Entra ID capabilities remain separate Phase 1 work.

## GitHub and Cloudflare configuration

The repository requires these GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Workers, KV, R2, Browser Rendering, Workers AI,
  and Dynamic Worker Loader deployment permissions.
- `CLOUDFLARE_ACCOUNT_ID`: account that owns all Workers and provisioned resources.
- `OPENROUTER_API_TOKEN`: shared OpenRouter key used to fund inference for every application user.
  Give this key an OpenRouter credit limit appropriate for the deployment.

The account must be on the **Workers Paid** plan because Cloudflare OS uses Dynamic Workers to run
agent- and user-authored code in isolated Workers. Dynamic Workers cannot be deployed on the Workers
Free plan. R2 must also be enabled for the account before the first deployment. Both actions accept
Cloudflare's service or billing terms, so they are account-owner prerequisites rather than automated
CI actions.

Secrets are passed only at workflow runtime. `pnpm deploy` gives the OpenRouter key to the backend
Worker's `wrangler deploy --secrets-file` operation through a temporary owner-readable file, then
removes that file. Code, configuration, and secrets therefore publish as one Worker version. The
key must not appear in deployment JSON, generated Wrangler variables, command arguments, logs,
frontend bundles, RPC results, or per-user Durable Object storage. Update the GitHub secret and
rerun the deployment workflow to rotate it. The Blacksmith GitHub App must include this repository
because both CI and deployment use `blacksmith-*-ubuntu-2404` runners.

Use the workflow's manual **Run workflow** action only to retry the current `main` commit after an
external failure. Normal releases always follow successful CI. Deployment concurrency is serialized
so two releases cannot update the same Worker identities simultaneously.

## Verification and operations

Every deployment:

1. Validates the deployment contract tested by the normal `CI` workflow.
2. Builds Context, Scheduler, frontend, Workshop backend, and router packages.
3. Deploys private Gatekeepers and the backend before the public router.
4. Requests the emitted `workers.dev` URL and requires a successful HTML response.
5. Records the URL and source commit in the GitHub Actions job summary.

After an infrastructure or application change, also open the URL and verify account login,
`/admin`, workspace creation, GPT 5.6 Luna appearing first in the model picker, switching to another
managed model, and a simple agent response that uses a tool. Confirm that onboarding and the AI
providers page offer no action to add a personal provider. Inspect runtime events with Workers Logs
or `pnpm exec wrangler tail intimetec-cloudflare-os`.

For a failed release, read the failed workflow step first and retry only after correcting its cause.
Wrangler deployments are versioned; roll the public Worker back with
`pnpm exec wrangler rollback --name intimetec-cloudflare-os` when a newly deployed application is
unusable. Because Context, Scheduler, and the backend deploy first, verify their versions too before
deciding whether only the public router should be rolled back.

## Upgrades and production transition

When an upstream merge changes a deployable package's Wrangler configuration, update
`scripts/deploy.mjs` only if the new binding or deployment behavior needs account-specific values.
Run `CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm deploy -- --check` to build every deployable component
and execute Wrangler dry runs without changing Cloudflare. The normal deployment tests also verify
the generated service topology and resolved resource bindings in CI.

Before production use, replace `workers.dev` and open password signup with the company domain and
Microsoft Entra ID, enable the desired production observability/error destination, rotate the
deployment API token, and review Cloudflare plan and data-governance requirements.
