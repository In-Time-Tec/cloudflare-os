# MCP gatekeeper

Connects any [Model Context Protocol](https://modelcontextprotocol.io) server as a Gadgets
capability. The user pastes an endpoint URL, the gatekeeper runs the OAuth discovery chain against
it, and each of the server's tools becomes a typed method on the session. One Worker covers every
MCP server, so a server needs no Gadgets-specific work to be usable from a Gadget. Runs as its own
Cloudflare Worker and is auto-discovered by the backend from its `GATEKEEPER_MCP` binding.

If your organization runs an MCP server portal, use
[`gatekeeper-mcp-portal`](../gatekeeper-mcp-portal/README.md) instead: it takes one
administrator-configured URL, needs no user to paste an endpoint, and scopes a grant to a single
upstream server behind the portal.

## What it provides

One resource type, **Any MCP server**, at two grant breadths:

| Granularity | Resource URL | Session type |
| --- | --- | --- |
| **Server** — every tool the endpoint offers, including ones it adds later | `<endpoint>` | `Mcp<Name><tag>Session` |
| **Named tools** — only the listed tools; anything else is refused | `<endpoint>#tool=a&tool=b` | `Mcp<Name><tag>Session` |

A `#server=` fragment is refused here; scoping to one server behind a portal is the MCP Server Portals
connector's grammar. `@gadgets/mcp-shared/scope` owns the grammar and the enforcement.

`<Name>` comes from the endpoint's host and is for reading, not identity — `acme.com` and `acme.io`
both give `Acme`. `<tag>` is four hex characters derived from the resource URL above, so two grants
that differ in what they may call get different type names. The agent is shown each binding's types
in its own block with no way to compare them, so a shared name would present two unrelated tool
surfaces as one.

The session carries a named method per tool, generated from the server's own `inputSchema`:

The binding is named after the endpoint's host, so `https://mcp.linear.app/mcp` suggests
`MCP_LINEAR` (see `server-id.ts`):

```ts
// Read-only tool: resolves immediately, recorded as an observation.
let search = await env.MCP_LINEAR.searchIssues({ query: "state:open" });
if (search.status !== "ok") throw new Error(search.message);
let { text } = search;

// Anything else: runs immediately, recorded as an action with its outcome.
let created = await env.MCP_LINEAR.createIssue({ title: "Fix the thing" });

// The same call by its exact wire name, for a tool whose name cannot be a method.
await env.MCP_LINEAR.callTool("search_issues", { query: "state:open" });
```

Each generated method is a one-line delegate to `callTool`, so the scope check and the
observation/action record stay in one place. Tools whose names the RPC layer cannot deliver (`then`, `map`,
`dup`), names that are not identifiers (`2fa`), and both sides of a case collision (`list_issues`
and `listIssues`) get no method and remain callable through `callTool`.

The agent discovers tools statically: `describeGatekeeper()` sends it the binding name and the full
generated `.d.ts`, where each method carries the tool's own description as JSDoc and states whether
calling it is recorded as an observation or as an action. `listTools()` exists for runtime enumeration but is rarely needed.

See `src/types.d.ts` in `@gadgets/mcp-shared` for the base session API.

## Configuration

| Variable | Meaning |
| --- | --- |
| `BASE_URL` | Public base URL of this Worker, for OAuth redirects. |
| `MCP_CLIENT_NAME` | Client name sent in `initialize` and dynamic client registration. |
| `MCP_ALLOW_INSECURE` | `"true"` to disable the endpoint checks entirely: permits `http://` **and** private, loopback, link-local, and cloud-metadata hosts, on the endpoint and on every OAuth URL discovered from it. Local dev only. |

There is nothing to configure per server: users supply endpoints, and an administrator's only lever
is whether this connector is offered at all, in the Gatekeepers admin panel. There is no server
catalog — a deployment that wants to offer a chosen set of servers should front them with a portal
and use [`gatekeeper-mcp-portal`](../gatekeeper-mcp-portal/README.md).

For local development no credentials are needed. Set `MCP_ALLOW_INSECURE=true` in the repo-root
`.dev.vars` to connect a server running on localhost.

## How the connect flow works

1. The user starts a connection and gets a form asking for the server's endpoint URL. The URL is
   validated against the host blocklist in `endpoint.ts` (no private, loopback, or metadata hosts;
   HTTPS required unless `MCP_ALLOW_INSECURE`). The form says plainly that connecting a server is a
   decision to trust it, since the server's own annotation decides which of its tools count as
   reads (see below).
2. The gatekeeper opens a Streamable HTTP session and calls `initialize`. A server that completes
   the handshake unauthenticated is recorded as public and no token is demanded of it later.
3. A `401` starts the official MCP client's OAuth flow:

   ```
   401 + WWW-Authenticate  ->  protected resource metadata   (RFC 9728)
                           ->  authorization server metadata (RFC 8414)
                           ->  dynamic client registration   (RFC 7591)
                           ->  authorization code + PKCE     (RFC 7636)
                               + resource indicator          (RFC 8707)
   ```

   The SDK falls back to the conventional
   paths (`/authorize`, `/token`, `/register`) that the Workers OAuth provider and most MCP servers
   use. That means a server which does not implement dynamic client registration is not detected as
   such up front — the synthesized `/register` is tried and refuses, so the failure reads as a
   rejected registration rather than a missing capability. The remedy is the same either way:
   connect a server that supports registration, or reach it through a portal an administrator has
   configured with a preissued token.
4. Tokens are stored in the `McpAccount` Durable Object and refreshed proactively, before the
   recorded expiry. Nothing outside this Worker can obtain one.

   A `401` mid-session is not a refresh trigger: it means the server rejected a token this Worker
   believed was valid, so the account is marked as needing attention and the user is asked to
   reconnect. Refreshing in response would paper over a revoked or repudiated grant. Refresh
   failures are classified — only the authorization server's own verdict on the credential
   (`invalid_grant` and friends) marks the account expired, while transport and unrecognised failures
   leave it alone to be retried.

The endpoint is fixed at first connect. Reconnecting an account cannot point it at a different
server, since the binding's props still name the original. (The MCP Server Portals connector is the
exception: its endpoint comes from deployment configuration rather than a form, so a reconnect there
may adopt a repointed gateway. See its README.)

## Scoping a binding

The configurator asks how broad the grant is and, if it is pinned, which tools:

```
Tools · Choose how much of this server the Gadget may call.
( ) All tools      Every tool this server offers (14 today), including ones it adds later.
(•) Choose tools   Only the tools you tick. Anything else is refused, including tools added later.

Allowed tools · 3 selected. Read-only tools are recorded as observations; the rest as actions.
[ 🔍 Filter tools... ]
☑ Search issues                                                                        read-only
☑ Create issue                                                                              acts
```

The breadth is asked outright rather than inferred from whether every box is ticked: "all 14 ticked"
and "these 14 by name" look identical and diverge as soon as the server publishes a fifteenth. The
list stays on screen in both modes, disabled under **All tools**.

Tools named `portal_*` are never grantable on an endpoint that identifies itself as a portal, since
they let a session change which upstream servers it can reach.

## Recording and sharing

A call to a tool the server annotates `readOnlyHint: true` is recorded as an observation. Every
other call is recorded as an action carrying that tool's own action kind, which the user sees at
connect time and an administrator can disable deployment-wide. Annotations are optional in MCP and
most servers publish none; the hint is tested with `=== true`, so an unannotated tool is an action.

MCP's own guidance is that a client must treat tool annotations as untrusted. Honouring
`readOnlyHint` is a knowing departure from that rule, and the limit of what this connector can
promise: a server that labels a destructive tool `readOnlyHint: true` gets that call logged as a
read of the world rather than a change to it. Refusing the hint would mean recording every `search`
and `list` as an action against the user's grant, which makes the connector unusable for the thing
people connect it to do; and it would buy less than it looks, since a dishonest server can act on
any call.

So the trust decision is made once, by the person pasting the URL, and the connect form says so
plainly: an annotation is only as trustworthy as the server that sent it. Every call records which
side classified it (`McpToolInfo.classifiedBy`), so an audit can find each one taken on the server's
word. See `tools.ts` in `@gadgets/mcp-shared` for the rules.

A Gadget bound to an MCP server can only be opened by its owner: `addObserver` refuses
unconditionally. Being able to authenticate to a server is not evidence of being allowed to see what
the *owner* read from it, and the Gadget runs on the owner's credentials throughout. Writes still
work — the alternative, marking every observation `prohibitAllSharing`, would latch a lockdown that
blocks every action for the rest of the session. See
[`sharing-policy.ts`](../mcp-shared/src/sharing-policy.ts).

To share the work rather than the binding, publish the Gadget as a blueprint and let each person
connect their own server.

## Notes and current limitations

- **No revert.** MCP describes no inverse for a tool call, so every capability this connector
  declares carries `reversible: "no"`.
- **No hooks.** `notifications/tools/list_changed` is session-scoped; a Gadget hook is durable and
  must survive restarts.
- **No scoping below tool names.** MCP tools take arguments, not capabilities, so "this repo only"
  cannot be expressed. A list of allowed tool names is the narrowest grant available.
- **Only `tools/*`.** Prompts, resources, sampling, and elicitation are not implemented. Sampling
  and elicitation would let a server drive the agent.
- **Tool-list changes are adopted, not pinned.** A changed list is taken and logged
  (`catalog.changed`), since refusing to see new tools would break working Gadgets. A binding with a
  tool scope cannot widen this way, which is the reason to prefer **Choose tools** for anything that
  writes.
- **SSRF is enforced after DNS, not by the blocklist.** The hostname patterns in `endpoint.ts` are a
  legible refusal at connect time; they cannot see through a public hostname that resolves, or
  rebinds, to a private address. The actual boundary is the `global_fetch_strictly_public`
  compatibility flag in `wrangler.jsonc`, which makes workerd reject reserved IP ranges after
  resolution on every request and redirect hop. It does not apply under `wrangler dev`, which is
  what keeps `MCP_ALLOW_INSECURE` usable locally.
- **Sharing UI reports late.** `GadgetMetadata.sharingProhibited` derives only from
  `prohibitAllSharing`, so creating a share key appears to succeed and fails when the recipient
  opens it. Fixing this needs a kernel change.

## Layout

| File | Purpose |
| --- | --- |
| `src/mcp.ts` | Vendor, account DO, user, verifier, gatekeeper facet, session |
| `src/connect-form.ts` | The endpoint prompt served during connect |
| `src/server-id.ts` | Endpoint to display slug, for the binding name and session type |
| `src/configurator/` | The grant UI (compiled into `src/generated/`) |

The MCP client, OAuth, tool classification, generated TypeScript, and the scope grammar come from
[`@gadgets/mcp-shared`](../mcp-shared/README.md).

## Build & test

```
pnpm --filter @gadgets/mcp-gatekeeper build   # build:configurator + tsc
pnpm --filter @gadgets/mcp-gatekeeper test    # vitest
```

The Worker is run via the root `pnpm dev-server`, not directly.
