import { describe, expect, it, vi, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { UserAccount } from "../src/microsoft.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_ACCOUNT: DurableObjectNamespace<UserAccount>;
  }
}

beforeEach(() => vi.unstubAllGlobals());

describe("UserAccount (full mode)", () => {
  it("returns the cached token while fresh and refreshes through the token endpoint after", async () => {
    const tokenCalls: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      tokenCalls.push(new URLSearchParams(init?.body as string));
      return Response.json({
        access_token: "refreshed-token", refresh_token: "rotated-refresh",
        expires_in: 3600, scope: "Mail.ReadWrite",
      });
    });

    const stub = env.TEST_USER_ACCOUNT.getByName("account-refresh");
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.kv.put("accessToken", { token: "fresh", expires: Date.now() + 3600_000 });
      state.storage.kv.put("refreshToken", "old-refresh");
    });
    expect(await stub.getAccessToken()).toBe("fresh");
    expect(tokenCalls).toHaveLength(0);

    // Expire the cache: the next read refreshes and rotates the stored refresh token.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.kv.put("accessToken", { token: "stale", expires: Date.now() - 1000 });
    });
    expect(await stub.getAccessToken()).toBe("refreshed-token");
    expect(tokenCalls[0].get("grant_type")).toBe("refresh_token");
    expect(tokenCalls[0].get("refresh_token")).toBe("old-refresh");
    await runInDurableObject(stub, async (_i, state) => {
      expect(state.storage.kv.get("refreshToken")).toBe("rotated-refresh");
      expect(state.storage.kv.get<string[]>("grantedScopes")).toEqual(["Mail.ReadWrite"]);
    });
  });

  it("yields null (reconnect) when the refresh is rejected", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 400 }));
    const stub = env.TEST_USER_ACCOUNT.getByName("account-revoked");
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.kv.put("accessToken", { token: "stale", expires: Date.now() - 1000 });
      state.storage.kv.put("refreshToken", "revoked");
    });
    expect(await stub.getAccessToken()).toBeNull();
  });

  it("revoke wipes all credentials", async () => {
    const stub = env.TEST_USER_ACCOUNT.getByName("account-revoke");
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.kv.put("refreshToken", "r");
      state.storage.kv.put("accessToken", { token: "t", expires: Date.now() + 3600_000 });
      state.storage.kv.put("identity", { issuer: "i", oid: "o" });
    });
    await stub.revoke();
    await runInDurableObject(stub, async (_i, state) => {
      expect([...state.storage.kv.list()]).toEqual([]);
    });
  });
});
