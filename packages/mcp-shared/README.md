# MCP shared

The protocol client, policy decisions, and stateful machinery common to the two MCP-speaking
gatekeepers. Not a Worker: a library both of them import.

| Package | Endpoint comes from | Grant is scoped to |
| --- | --- | --- |
| [`gatekeeper-mcp`](../gatekeeper-mcp/README.md) | a user pastes a URL | the whole server, or named tools |
| [`gatekeeper-mcp-portal`](../gatekeeper-mcp-portal/README.md) | a deployment var, `MCP_PORTAL_URL` | one upstream server behind the portal, or named tools |

Code lives here when two copies of it would eventually disagree and the disagreement would be a
security bug: tool classification, the scope grammar, the OAuth lifecycle, the action-recording
wiring. A Worker's own vendor entrypoint, Durable Object classes and migrations, `Env`, connect
form, and configurator UI stay in the connector. Where a connector must vary shared behaviour it
does so through a named hook (`staticToken`, `mintAccount`), not a private copy.

## Modules

| Module | Purpose |
| --- | --- |
| `client` | Bounded Streamable HTTP transport (`initialize`, `tools/list`, `tools/call`) using official MCP wire types |
| `oauth` | Small adapter around the official MCP client's OAuth errors and token revocation gap |
| `tools` | The trust boundary: read/action classification, action kinds, activity-log rendering, catalog fingerprinting |
| `schema-to-ts` | JSON Schema to TypeScript, one typed method per tool plus `callTool` overloads |
| `session-methods` | Installs those methods at runtime, so the generated types are not a fiction |
| `portal` | Gateway detection, tool-name to upstream-server mapping, server listing |
| `scope` | The resource-URL scope grammar, and the check every call passes through |
| `endpoint` | Validation and host blocklist for a user-supplied endpoint |
| `fetch` | Every outbound request; redirects are followed by hand and each hop re-checked, including SDK OAuth fetches |
| `account` | Durable Object base and persisted SDK OAuth state: connect, refresh, revocation |
| `facet` | Common session, catalog, action, and sharing behavior for connector-owned Durable Object facets |
| `catalog` | One binding's tool list: fetched, cached, scoped to the grant, classified |
| `connection` | `withClient` — transport sessions, retries, credential-expiry reporting |
| `session` | The Gadget-facing capability, and the one path every tool call takes |
| `sharing-policy` | The owner-only sharing rule |
| `html` | The connect-flow pages, so both connectors look like one product |
| `http` | Base-path, OAuth callback, and connect-link routing shared by both Workers |
| `log` | The field vocabulary both connectors log against |
| `user` | The common account description, revocation, and reconnect lifecycle |
| `util` | Hex encoding, host extraction, binding-name slugs; no policy |
| `types.d.ts` | Base types prepended to every generated per-server `.d.ts` |

Nothing outside `tools.ts` reads a tool's `annotations`.

## What a server gets to say about itself

MCP's guidance is that a client must treat tool annotations as untrusted. Exactly one of them is
read here: `readOnlyHint`. `true` makes a call an **observation** — it runs and is recorded as a
read. Anything else makes it an **action**, carrying the kind `actionKindFor()` derives for that
tool on that binding, which is what a user consents to at connect time and an administrator can
disable deployment-wide.

Honouring `readOnlyHint` is a tradeoff, not a free win: a tool the server mislabels is logged as a
read of the world rather than a change to it. It is accepted because a read that must be justified
as an action is a connector nobody can use, and because the owner chose to connect the server.

Annotations are optional in MCP and most servers publish none. The test is `=== true` rather than a
truthiness check, so an unannotated tool is an action — matching the spec's own default of
`readOnlyHint: false`. `destructiveHint` and `idempotentHint` are not read at all: they existed
only to gate auto-apply, which no longer exists.

A Gadget bound to any MCP endpoint is owner-only — see
[`sharing-policy.ts`](src/sharing-policy.ts).

What an account records is `provenance`, `"user"` or `"deployment"`, settled when it connects. It
decides whether a server may rename itself over an administrator's chosen label in the activity log.

## Calling a tool

The guarantee is *at most once*, not exactly once. MCP has no idempotency key that would make a
repeated call harmless and no inverse operation that would undo one, so where the two conflict this
package prefers losing a result over repeating a write. A write is therefore never retried on
session expiry, which a fronting proxy can report after the upstream already accepted the call.

`authorizeAction()` gates the call before anything is sent: it throws when the workspace is in
sharing lockdown, when an administrator has disabled the tool's kind, or when the turn's action
budget is exhausted, and nothing reaches the server. Otherwise the call runs and its outcome is
reported on the returned handle.

Failures are split by what the server is known to have done, because that is not something the
caller can work out afterwards. Only a `401` or `403` proves the tool was refused before dispatch.
Generic HTTP and JSON-RPC errors, dropped connections, malformed replies, and oversized bodies all
leave the outcome unknown, and are reported as `failed(error, mayHaveTakenEffect: true)` so the
activity log says so rather than implying nothing happened. The classification
(`callMayHaveTakenEffect`) fails safe: anything it cannot positively identify as declined counts as
possibly performed.

## Limits

Fixed rather than configurable.

| Limit | Value | Where | Why |
| --- | --- | --- | --- |
| Tools per server | 200 | `tools.ts` | A grant a person can review, and a `.d.ts` an agent can read |
| Catalog size | 96 KiB UTF-8 | `client.ts` | Leaves room below Durable Object's 128 KiB per-value limit for the cache wrapper and serialization overhead |
| Tool description | 4 KB | `client.ts` | As above, per tool, before it reaches storage |
| Tool input schema | 20 KB | `client.ts` | Dropped rather than clipped; half a schema is not a schema |
| `tools/list` pages | 50 | `client.ts` | A cursor that never ends would loop until the Worker is killed |
| Response body | 1 MiB | `fetch.ts` | Every response is buffered whole before it can be parsed, and a `tools/call` result is otherwise unbounded |
| Tool description in a log entry | 600 chars | `tools.ts` | Server-controlled text a human reads |
| Tool arguments in a log entry | 4000 chars | `tools.ts` | Agent-controlled text a human reads |
| Server name | 60 chars | `account.ts` | As above; also stripped of Markdown |
| Redirect hops | 3 | `fetch.ts` | Each one re-checked; more is a loop, not a deployment |
| Connect link | 10 min | `connect-nonce.ts` | Single-use, and consumed on success |
| Unfinished connect | 1 hour | `connect-nonce.ts` | After which a half-built account deletes itself |

## Build & test

```
pnpm --filter @gadgets/mcp-shared build   # tsc
pnpm --filter @gadgets/mcp-shared test    # vitest
```
