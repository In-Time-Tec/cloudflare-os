# Microsoft Gatekeeper

Sign-in with Microsoft Entra ID for Cloudflare OS. This gatekeeper currently provides
**authentication only** (`providesAuth`): its connect flow runs a single-tenant Entra OIDC
sign-in and yields a provider-verified structured identity. Microsoft 365 / Graph capabilities
will be added later as separate, explicitly consented resources.

## Identity model

- `issuer` — the tenant's v2.0 issuer, `https://login.microsoftonline.com/<TENANT_ID>/v2.0`.
- `subject` — the immutable directory object id (`oid`).
- `email`, `displayName` — mutable profile metadata from the ID token; never identity.
- `roles` — validated Entra **app role** claims from the ID token, passed through as
  provider assertions. Assign Entra groups to app roles in Entra rather than enumerating
  groups here.

The ID token is validated in full before any claim is trusted: signature (tenant JWKS),
issuer, audience, expiration, the per-flow OIDC nonce, the `tid` tenant claim, and a present
`oid`. Only the configured single tenant is accepted — `common`/`consumers`/other tenants are
structurally impossible because every endpoint URL is built from `TENANT_ID`.

Sign-in requests only `openid profile email`. No Graph scopes are requested, no tokens are
persisted (the validated identity is kept for ~2 minutes so the Workshop can read it, then the
account DO self-destructs), and nothing Microsoft-issued ever reaches the browser or a session.

## Configuration

Register a **single-tenant** application in the Microsoft Entra admin center:

1. App registrations → New registration → "Accounts in this organizational directory only".
2. Authentication → Add a platform → Web → redirect URI
   `<PUBLIC_BASE_URL>/gatekeeper/microsoft/oauth`
   (local dev: `http://localhost:8787/gatekeeper/microsoft/oauth`).
3. Certificates & secrets → New client secret.
4. (Optional) App roles → define roles and assign users/groups; they surface as validated
   `roles` claims.

Secrets/vars on the Worker:

- `CLIENT_ID` — the application (client) ID.
- `CLIENT_SECRET` — the client secret.
- `TENANT_ID` — the directory (tenant) ID.
- `BASE_URL` — public base URL of this gatekeeper
  (e.g. `https://<host>/gatekeeper/microsoft`); defaults to the local dev URL.

Enable sign-in by adding `microsoft` to the Workshop's `AUTH_GATEKEEPERS` allowlist. Admins are
granted by principal: `https://login.microsoftonline.com/<TENANT_ID>/v2.0:<oid>` in `ADMINS`.

## Offboarding

A user disabled or deleted in Entra can no longer complete a sign-in, so no new Workshop
session can be minted. Existing sessions end at their bounded lifetime, and an administrator
can revoke all of a user's sessions immediately (`AdminApi.revokeUserSessions`). There is no
Entra lifecycle-event synchronization; do not assume instantaneous offboarding beyond this.
