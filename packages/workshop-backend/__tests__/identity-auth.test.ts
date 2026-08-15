import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAuthErrorCode, AUTH_ERROR_CODES } from "@gadgets/workshop-shared/api";
import type { AuthenticatedIdentity } from "@gadgets/workshop-shared/gatekeeper";
import type { IdentityDirectory } from "../src/auth/identity-directory.js";
import { identityDirectoryId } from "../src/auth/identity-directory.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_IDENTITY_DIRECTORY: DurableObjectNamespace<IdentityDirectory>;
  }
}

const IDENTITY: AuthenticatedIdentity = {
  issuer: "https://accounts.example.com",
  subject: "subject-1",
  email: "person@example.com",
  displayName: "Person Example",
};

function directoryFor(identity: { issuer: string; subject: string }) {
  return env.TEST_IDENTITY_DIRECTORY.get(
      identityDirectoryId(env.TEST_IDENTITY_DIRECTORY, identity));
}

// Run authenticate() inside the DO and return its typed failure code (or "ok"). Calling through
// the RPC stub would also work, but workerd then reports the server-side throw as an uncaught
// exception, which fails the suite.
async function authOutcome(name: string, secret: string): Promise<string> {
  const stub = env.TEST_USER.getByName(name);
  return await runInDurableObject(stub, async instance => {
    try {
      await instance.authenticate(secret);
      return "ok";
    } catch (err) {
      return getAuthErrorCode(err) ?? "unexpected";
    }
  });
}

describe("IdentityDirectory", () => {
  it("mints one opaque user per identity and returns it stably", async () => {
    const first = await directoryFor(IDENTITY).resolveUser(IDENTITY, true);
    expect(first).not.toBeNull();
    expect(first!.created).toBe(true);
    // The internal id is an opaque DO id, never derived from the email or subject.
    expect(first!.userId).not.toContain(IDENTITY.email);
    expect(first!.userId).not.toContain(IDENTITY.subject);

    const again = await directoryFor(IDENTITY).resolveUser(IDENTITY, true);
    expect(again).toEqual({ userId: first!.userId, created: false });
  });

  it("never collides the same subject under different issuers", async () => {
    const tenantA = { issuer: "https://login.example.com/tenant-a", subject: "oid-123" };
    const tenantB = { issuer: "https://login.example.com/tenant-b", subject: "oid-123" };

    const a = await directoryFor(tenantA).resolveUser(tenantA, true);
    const b = await directoryFor(tenantB).resolveUser(tenantB, true);
    expect(a!.userId).not.toBe(b!.userId);
  });

  it("refuses to create when signups are closed but resolves existing users", async () => {
    const identity = { issuer: "https://accounts.example.com", subject: "closed-signups" };
    expect(await directoryFor(identity).resolveUser(identity, false)).toBeNull();

    const created = await directoryFor(identity).resolveUser(identity, true);
    expect(created!.created).toBe(true);
    const resolved = await directoryFor(identity).resolveUser(identity, false);
    expect(resolved).toEqual({ userId: created!.userId, created: false });
  });
});

describe("user sessions", () => {
  async function loginNewUser(name: string) {
    const user = env.TEST_USER.getByName(name);
    const secret = await user.loginViaGatekeeper(IDENTITY);
    return { user, secret };
  }

  it("records the verified principal and profile keyed by the opaque id", async () => {
    const { user, secret } = await loginNewUser("sessions-principal");
    const principal = await user.authenticate(secret);
    expect(principal).toEqual({
      issuer: IDENTITY.issuer,
      subject: IDENTITY.subject,
      roles: undefined,
    });

    const profile = await user.whoami();
    expect(profile.name).toBe("Person Example");
    expect(profile.id).not.toContain("@");
  });

  it("rejects garbage and unknown tokens with a typed error", async () => {
    await loginNewUser("sessions-invalid");
    expect(await authOutcome("sessions-invalid", "not-base64!!"))
        .toBe(AUTH_ERROR_CODES.invalidSessionToken);
    expect(await authOutcome("sessions-invalid", new Uint8Array(32).toBase64()))
        .toBe(AUTH_ERROR_CODES.invalidSessionToken);
  });

  it("expires sessions after the bounded lifetime with a typed error", async () => {
    const { secret } = await loginNewUser("sessions-expiry");
    expect(await authOutcome("sessions-expiry", secret)).toBe("ok");

    // Rewind the stored expiry rather than faking time: authenticate() runs inside the DO.
    const stub = env.TEST_USER.getByName("sessions-expiry");
    await runInDurableObject(stub, async (_instance, state) => {
      for (const [key, value] of state.storage.kv.list<{ expiresAt?: Date }>(
          { prefix: "sessions:" })) {
        state.storage.kv.put(key, { ...value, expiresAt: new Date(Date.now() - 1000) });
      }
    });
    expect(await authOutcome("sessions-expiry", secret)).toBe(AUTH_ERROR_CODES.sessionExpired);

    // The expired session was deleted, so the same token is now simply invalid.
    expect(await authOutcome("sessions-expiry", secret))
        .toBe(AUTH_ERROR_CODES.invalidSessionToken);
  });

  it("deletes the session on logout", async () => {
    const { user, secret } = await loginNewUser("sessions-logout");
    expect(await authOutcome("sessions-logout", secret)).toBe("ok");
    await user.deleteSession(secret);
    expect(await authOutcome("sessions-logout", secret))
        .toBe(AUTH_ERROR_CODES.invalidSessionToken);
  });

  it("revokes every session for the principal at once", async () => {
    const user = env.TEST_USER.getByName("sessions-revoke-all");
    const secretA = await user.loginViaGatekeeper(IDENTITY);
    const secretB = await user.loginViaGatekeeper(IDENTITY);
    expect(await authOutcome("sessions-revoke-all", secretA)).toBe("ok");
    expect(await authOutcome("sessions-revoke-all", secretB)).toBe("ok");

    await user.revokeAllSessions();
    for (const secret of [secretA, secretB]) {
      expect(await authOutcome("sessions-revoke-all", secret))
          .toBe(AUTH_ERROR_CODES.invalidSessionToken);
    }
  });
});
