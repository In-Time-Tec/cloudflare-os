# Microsoft Gatekeeper

Microsoft Entra ID sign-in plus delegated Microsoft 365 capabilities for Cloudflare OS:
Outlook Mail, Outlook Calendar, OneDrive/SharePoint files, and Microsoft Teams. Graph access
is implemented in `@gadgets/microsoft-graph` (an Effect v4 client); this Worker owns Entra
OAuth, token lifecycle, resource grants, observations, and recorded actions.

## Two account modes, one Entra app

| Mode | Started by | Scopes | Persistence |
|---|---|---|---|
| Sign-in | login page (`scopes:"auth"`) | `openid profile email` | transient; DO self-destructs |
| Capability connection | Connectors page (`scopes:"full"`) | OIDC + `offline_access` + per-resource Graph scopes | persistent `UserAccount` DO |

Sign-in never mints a Graph grant. Connecting requests only the delegated scopes for the
resource types the user enables (incremental consent; see `resources.ts`):

| Resource | Delegated scopes |
|---|---|
| Outlook Mailbox | `Mail.ReadWrite`, `Mail.Send` |
| Outlook Calendar | `Calendars.ReadWrite`, `Calendars.Read.Shared` |
| OneDrive & SharePoint Files | `Files.ReadWrite.All`, `Sites.ReadWrite.All` |
| Microsoft Teams | `Chat.ReadWrite`, `Chat.Create`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `ChannelMessage.Send` |

The refresh token lives only in the `UserAccount` Durable Object. Sessions borrow short-lived
access tokens; no token, raw Graph request, or continuation URL ever reaches a gadget, agent,
or browser.

## Security model

- Every read is authorized through `authorizeObservation()` before data is returned.
- Every write is authorized through `authorizeAction()`, performed against Graph inline, and its
  outcome reported on the returned handle, so a session returns real provider ids. Write action
  kinds, each declared in `getActionCatalog()` with its risk:

  | Kind | Covers |
  |---|---|
  | `microsoft.mail.draft.create` | createDraft, createReplyDraft |
  | `microsoft.mail.send` | sendMail, sendDraft, reply, replyAll, forward |
  | `microsoft.calendar.event.create` | createEvent |
  | `microsoft.calendar.event.modify` | updateEvent, cancelEvent |
  | `microsoft.calendar.event.respond` | accept / decline / tentative |
  | `microsoft.files.write` | createFolder, uploadFile, replaceFileContent |
  | `microsoft.files.delete` | deleteFile |
  | `microsoft.teams.message.post` | postToChat, postToChannel |
  | `microsoft.teams.chat.create` | createChat |

  Deletes are a separate kind from other file writes so a deployment can disable deletion while
  allowing edits.
- All four capabilities expose broad personal data, so `addObserver` always throws: a
  workspace bound to a Microsoft resource cannot be shared.
- Bounded content: attachments and binary downloads ≤ 3 MB, text reads ≤ 512 KB, uploads
  ≤ 4 MB (single-request PUT).

## Entra app registration

Single-tenant app (see the identity model below), plus these **delegated** Graph permissions
for capability connections: `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
`Calendars.ReadWrite`, `Calendars.Read.Shared`, `Files.ReadWrite.All`, `Sites.ReadWrite.All`,
`Chat.ReadWrite`, `Chat.Create`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`,
`ChannelMessage.Read.All`, `ChannelMessage.Send`, `offline_access`. Users consent per connection; grant admin consent in
the tenant if your policy requires it.

1. App registrations → New registration → "Accounts in this organizational directory only".
2. Authentication → Web platform → redirect URI `<PUBLIC_BASE_URL>/gatekeeper/microsoft/oauth`
   (local dev: `http://localhost:8787/gatekeeper/microsoft/oauth`).
3. Certificates & secrets → New client secret.
4. API permissions → add the delegated permissions above.
5. (Optional) App roles → define/assign; they surface as validated `roles` claims at sign-in.

Secrets/vars on the Worker: `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`, `BASE_URL`.

## Identity model (sign-in)

- `issuer` — the tenant's v2.0 issuer, `https://login.microsoftonline.com/<TENANT_ID>/v2.0`.
- `subject` — the immutable directory object id (`oid`).
- Email/display name are mutable metadata; `roles` are validated Entra app-role claims.

The ID token is validated in full (signature via tenant JWKS, issuer, audience, expiry,
per-flow nonce, `tid`, `oid`) before any claim is trusted. Only the configured tenant is
accepted. Enable sign-in with `AUTH_GATEKEEPERS=microsoft`; grant admin by principal
`https://login.microsoftonline.com/<TENANT_ID>/v2.0:<oid>` in `ADMINS`.

## Offboarding

A user disabled in Entra cannot complete a new sign-in or token refresh; existing capability
connections fail into the reconnect state on their next refresh. Workshop sessions end at
their bounded lifetime or via `AdminApi.revokeUserSessions`. There is no lifecycle-event
synchronization; do not assume instantaneous offboarding beyond this.
