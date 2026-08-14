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
configuration, builds the required packages, derives production Wrangler configurations from each
package's checked-in base config, deploys private dependencies in order, and publishes the router
last. This code lives in the fork instead of modifying upstream application packages or patching an
external deployment repository. The temporary environment uses Cloudflare OS's built-in password
accounts; Microsoft Entra ID will replace them in Phase 1.

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

Wrangler automatically provisions the Workshop blueprint and avatar KV namespaces, blueprint R2
bucket, and Context KV namespace on the first deployment. Later deployments reconnect resources by
binding and Worker identity, preserving user, Durable Object, KV, and R2 state. Do not rename these
Workers, change the Context sharing domain, or replace resource bindings as routine release work;
that creates or points at a different deployment identity.

The evaluation administrator is the built-in username `dallenpyrah`. On the first visit, create an
account using exactly that username to receive `/admin` access. Account signup is initially open so
the first account can be created. Close signups in `/admin` after creating the intended evaluation
accounts.

No deployment-funded model catalog is configured. Each evaluator connects a supported model
provider through the application. Microsoft Graph and Entra ID capabilities are separate Phase 1
work and are not implied by this deployment.

## GitHub and Cloudflare configuration

The repository requires these GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Workers, KV, R2, Browser Rendering, Workers AI,
  and Dynamic Worker Loader deployment permissions.
- `CLOUDFLARE_ACCOUNT_ID`: account that owns all Workers and provisioned resources.

Secrets are passed only to Wrangler at workflow runtime. They must not appear in the deployment
JSON, workflow commands, logs, or application configuration. The Blacksmith GitHub App must include
this repository because both CI and deployment use `blacksmith-*-ubuntu-2404` runners.

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
`/admin`, workspace creation, model connection, and a simple agent response. Inspect runtime events
with Workers Logs or `pnpm exec wrangler tail intimetec-cloudflare-os`.

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
the generated service topology and automatic resource bindings in CI.

Before production use, replace `workers.dev` and open password signup with the company domain and
Microsoft Entra ID, enable the desired production observability/error destination, rotate the
deployment API token, and review Cloudflare plan and data-governance requirements.
