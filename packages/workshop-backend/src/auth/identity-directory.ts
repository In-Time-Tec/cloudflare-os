// The provider-neutral identity directory: maps a provider-verified external identity
// `(issuer, subject)` to an opaque internal user.
//
// Each `(issuer, subject)` pair owns exactly one IdentityDirectory Durable Object, addressed by
// `identityDirectoryId()`. The DO stores the internal user's DurableObjectId string, so lookup and
// first-login creation are a single atomic read-modify-write inside one DO — no global registry,
// no cross-DO races, and the same subject under two different issuers can never collide (they are
// different DOs).
//
// Email is deliberately absent from the mapping: it is mutable profile metadata, never identity
// authority. The internal user id is minted with `newUniqueId()`, so no user is addressable by
// email or any other provider claim.

import { DurableObject } from "cloudflare:workers";
import { AuthenticatedIdentity } from "@gadgets/workshop-shared/gatekeeper";

/**
 * The issuer recorded for password-authenticated sessions. Password accounts are deployment-local:
 * the username is the subject and the user DO is addressed by `idFromName(username)` directly, so
 * they need no directory entry.
 */
export const PASSWORD_ISSUER = "password";

/**
 * The verified external principal recorded on a session at login. Roles are the provider's
 * verified assertions as relayed by the gatekeeper; they carry no authority by themselves.
 */
export type SessionPrincipal = {
  issuer: string;
  subject: string;
  roles?: string[];
};

// Versioned record stored by each directory DO. The DO's own name is derived from
// (issuer, subject) and unrecoverable from the id, so the record repeats them for audit/debugging.
type DirectoryRecord = {
  version: 1;
  issuer: string;
  subject: string;
  userId: string;   // UserDurableObject id (hex string from newUniqueId())
  createdAt: Date;
};

/**
 * Compute the directory DO id for an external identity. The NUL separator cannot appear in an
 * issuer URL or a provider subject, so distinct (issuer, subject) pairs can never alias.
 */
export function identityDirectoryId(
    ns: DurableObjectNamespace<IdentityDirectory>,
    identity: Pick<AuthenticatedIdentity, "issuer" | "subject">): DurableObjectId {
  return ns.idFromName(`${identity.issuer}\u0000${identity.subject}`);
}

/** One (issuer, subject) mapping. See the module comment. */
export class IdentityDirectory extends DurableObject<Cloudflare.Env> {
  /**
   * Resolve this identity to its internal user id, creating the user on first sign-in when
   * `allowCreate` is set (deployment signups open). Returns null when the identity is unknown and
   * creation is not allowed. `created` tells the caller this login created the account.
   */
  async resolveUser(identity: Pick<AuthenticatedIdentity, "issuer" | "subject">,
                    allowCreate: boolean): Promise<{ userId: string; created: boolean } | null> {
    const existing = this.ctx.storage.kv.get<DirectoryRecord>("record");
    if (existing) return { userId: existing.userId, created: false };
    if (!allowCreate) return null;

    const userId = this.ctx.exports.UserDurableObject.newUniqueId().toString();
    this.ctx.storage.kv.put<DirectoryRecord>("record", {
      version: 1,
      issuer: identity.issuer,
      subject: identity.subject,
      userId,
      createdAt: new Date(),
    });
    return { userId, created: true };
  }
}
