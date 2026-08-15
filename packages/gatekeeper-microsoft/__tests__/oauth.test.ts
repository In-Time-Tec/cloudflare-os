import { describe, expect, it } from "vitest";
import { extractIdentity, entraIssuer } from "../src/oauth.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const ISSUER = entraIssuer(TENANT);
const NONCE = "expected-nonce";

function claims(overrides: Record<string, unknown> = {}) {
  return {
    nonce: NONCE,
    tid: TENANT,
    oid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    email: "person@example.com",
    name: "Person Example",
    ...overrides,
  };
}

describe("extractIdentity", () => {
  it("extracts the (issuer, oid) identity with profile metadata", () => {
    const identity = extractIdentity(claims(), TENANT, ISSUER, NONCE);
    expect(identity).toEqual({
      issuer: ISSUER,
      oid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      email: "person@example.com",
      displayName: "Person Example",
      roles: undefined,
    });
  });

  it("rejects a missing or mismatched nonce", () => {
    expect(() => extractIdentity(claims({ nonce: undefined }), TENANT, ISSUER, NONCE))
        .toThrow(/nonce/);
    expect(() => extractIdentity(claims({ nonce: "other" }), TENANT, ISSUER, NONCE))
        .toThrow(/nonce/);
  });

  it("rejects a wrong-tenant tid", () => {
    expect(() => extractIdentity(claims({ tid: "99999999-0000-0000-0000-000000000000" }),
        TENANT, ISSUER, NONCE)).toThrow(/tenant/);
    expect(() => extractIdentity(claims({ tid: undefined }), TENANT, ISSUER, NONCE))
        .toThrow(/tenant/);
  });

  it("rejects a missing oid", () => {
    expect(() => extractIdentity(claims({ oid: undefined }), TENANT, ISSUER, NONCE))
        .toThrow(/oid/);
    expect(() => extractIdentity(claims({ oid: "" }), TENANT, ISSUER, NONCE)).toThrow(/oid/);
  });

  it("falls back to preferred_username only when it looks like an email", () => {
    const withUpn = extractIdentity(
        claims({ email: undefined, preferred_username: "person@example.com" }),
        TENANT, ISSUER, NONCE);
    expect(withUpn.email).toBe("person@example.com");

    const withPlainUpn = extractIdentity(
        claims({ email: undefined, preferred_username: "person" }), TENANT, ISSUER, NONCE);
    expect(withPlainUpn.email).toBeUndefined();
  });

  it("keeps only string app-role claims and drops empty lists", () => {
    const withRoles = extractIdentity(
        claims({ roles: ["Workshop.Admin", 42, "Workshop.User"] }), TENANT, ISSUER, NONCE);
    expect(withRoles.roles).toEqual(["Workshop.Admin", "Workshop.User"]);

    const noRoles = extractIdentity(claims({ roles: [] }), TENANT, ISSUER, NONCE);
    expect(noRoles.roles).toBeUndefined();
  });
});
