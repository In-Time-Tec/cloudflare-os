import { describe, expect, it } from "vitest";
import {
  mintOrbSession, verifyOrbSession, OrbSessionError,
} from "../src/orb/session-token.js";
import { orbTurnUnavailableReason, snapshotOrbModel, stripLogRoute } from "../src/orb/orb-turn.js";
import type { Model, Api } from "@earendil-works/pi-ai";

const KEY = new TextEncoder().encode("test-signing-key-at-least-32-bytes-long");

describe("orb session tokens", () => {
  it("round-trips claims", async () => {
    const token = await mintOrbSession(KEY, {
      threadId: "thread-1",
      userId: "user-1",
      gen: 3,
    });
    await expect(verifyOrbSession(KEY, token)).resolves.toEqual({
      threadId: "thread-1",
      userId: "user-1",
      gen: 3,
    });
  });

  it("rejects the wrong audience", async () => {
    const token = await mintOrbSession(KEY, {
      threadId: "thread-1",
      userId: "user-1",
      gen: 1,
    });
    const parts = token.split(".");
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    payload.aud = "gadgets:orb-inference";
    const tampered = `${parts[0]}.${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}.${parts[2]}`;
    await expect(verifyOrbSession(KEY, tampered)).rejects.toBeInstanceOf(OrbSessionError);
  });
});

describe("orb turn snapshots", () => {
  it("strips headers and apiKey from the model descriptor", () => {
    const model = {
      id: "openai/gpt-5.6-luna",
      name: "gpt",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      headers: { Authorization: "Bearer secret" },
      apiKey: "sk-secret",
    } as unknown as Model<Api>;
    const snap = snapshotOrbModel(model, "https://example.workers.dev/orb-api/inference");
    expect(snap.baseUrl).toBe("https://example.workers.dev/orb-api/inference");
    expect("headers" in snap).toBe(false);
    expect("apiKey" in snap).toBe(false);
  });

  it("strips apiToken from an AI Gateway log route", () => {
    expect(stripLogRoute({
      gateway: "gw",
      accountId: "acc",
      apiToken: "secret",
    })).toEqual({ gateway: "gw", accountId: "acc" });
  });
});

describe("orbTurnUnavailableReason", () => {
  it("fails closed unless the orb, signing key, and public origin are all set", () => {
    expect(orbTurnUnavailableReason({} as Cloudflare.Env))
        .toMatch(/no machine/);
    expect(orbTurnUnavailableReason({ E2B_API_KEY: "k" } as Cloudflare.Env))
        .toMatch(/authentication/);
    expect(orbTurnUnavailableReason({
      E2B_API_KEY: "k",
      ORB_TOKEN_SIGNING_KEY: "test-signing-key-at-least-32-bytes-long",
    } as Cloudflare.Env)).toMatch(/PUBLIC_BASE_URL/);
    expect(orbTurnUnavailableReason({
      E2B_API_KEY: "k",
      ORB_TOKEN_SIGNING_KEY: "test-signing-key-at-least-32-bytes-long",
      PUBLIC_BASE_URL: "https://example.com/",
    } as Cloudflare.Env)).toBeUndefined();
  });

  it("rejects a loopback PUBLIC_BASE_URL the sandbox cannot call", () => {
    const ready = {
      E2B_API_KEY: "k",
      ORB_TOKEN_SIGNING_KEY: "test-signing-key-at-least-32-bytes-long",
    };
    expect(orbTurnUnavailableReason({
      ...ready,
      PUBLIC_BASE_URL: "http://localhost:8787",
    } as Cloudflare.Env)).toMatch(/public http\(s\) origin/);
    expect(orbTurnUnavailableReason({
      ...ready,
      PUBLIC_BASE_URL: "http://127.0.0.1",
    } as Cloudflare.Env)).toMatch(/public http\(s\) origin/);
  });
});
