import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  INFERENCE_GRANT_TTL_SECONDS, InferenceGrantError, getOrbSigningKey, mintInferenceGrant,
  verifyInferenceGrant,
} from "../src/orb/inference-grant.js";
import {
  handleOrbInference, inferenceSuffixAllowed, pinInferenceModel,
} from "../src/orb/orb-inference.js";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

// The orb inference proxy is a credential boundary: an untrusted sandbox authenticates with a
// turn-scoped grant, and the deployment's provider key must never leave this Worker. These tests
// assert both halves -- that a valid grant reaches the right provider endpoint carrying the right
// server-side credential, and that tampering with the grant or the request cannot redirect it,
// escalate the model, or surface the credential.

const KEY = new TextEncoder().encode("test-signing-key-at-least-32-bytes-long");

const INITIATOR: AiChatAuthorInfo = { type: "user", id: "user-1", name: "User" };

const CLAIMS = {
  threadId: "thread-abc",
  turnId: "turn-1",
  userId: "user-1",
  model: "openai/gpt-5.6-luna",
  provider: "openrouter" as const,
  initiator: INITIATOR,
};

// A deployment funding OpenRouter directly, as production does.
function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    DEPLOYMENT_AI_PROVIDERS: "openrouter",
    DEPLOYMENT_AI_DEFAULT_MODEL: "openai/gpt-5.6-luna",
    OPENROUTER_API_TOKEN: "sk-deployment-secret",
    ORB_TOKEN_SIGNING_KEY: "test-signing-key-at-least-32-bytes-long",
    ...overrides,
  } as Cloudflare.Env;
}

type Captured = { url: string; headers: Headers; body: string };
let captured: Captured[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    captured.push({ url: request.url, headers: request.headers, body: await request.text() });
    return new Response('data: {"ok":true}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream", "cf-aig-log-id": "log-123" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(token: string | undefined, options: {
  path?: string; body?: string; method?: string; headers?: Record<string, string>;
} = {}): Request {
  // The harness's pi SDK appends the provider's action path to the proxy base URL, so the
  // suffix arrives as part of the URL path -- never a query parameter.
  const url = "https://example.workers.dev/orb-api/inference" + (options.path ?? "");
  return new Request(url, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.method === "GET" ? undefined : (options.body ?? '{"model":"x","messages":[]}'),
  });
}

describe("inference grants", () => {
  it("round-trips the claims it was minted with", async () => {
    const token = await mintInferenceGrant(KEY, CLAIMS);
    const claims = await verifyInferenceGrant(KEY, token);
    expect(claims.threadId).toBe("thread-abc");
    expect(claims.model).toBe("openai/gpt-5.6-luna");
    expect(claims.initiator.id).toBe("user-1");
  });

  it("rejects a grant signed with a different key", async () => {
    const token = await mintInferenceGrant(
        new TextEncoder().encode("a-completely-different-signing-key!!"), CLAIMS);
    await expect(verifyInferenceGrant(KEY, token)).rejects.toBeInstanceOf(InferenceGrantError);
  });

  it("rejects an expired grant", async () => {
    const longAgo = Date.now() - (INFERENCE_GRANT_TTL_SECONDS + 60) * 1000;
    const token = await mintInferenceGrant(KEY, CLAIMS, longAgo);
    await expect(verifyInferenceGrant(KEY, token)).rejects.toBeInstanceOf(InferenceGrantError);
  });

  it("rejects a token that is not a grant at all", async () => {
    // Not a compact JWT: rejected by the structural guard before jose's crypto path runs.
    await expect(verifyInferenceGrant(KEY, "not.a.jwt")).rejects.toBeInstanceOf(InferenceGrantError);
  });

  it("rejects a compact JWT forged with no valid signature", async () => {
    // Three well-formed segments with a garbage signature: jose's crypto path rejects it (the
    // same code path as the forged-key case), surfaced as one InferenceGrantError.
    const compact = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.invalid-signature";
    await expect(verifyInferenceGrant(KEY, compact)).rejects.toBeInstanceOf(InferenceGrantError);
  });

  it("has no signing key when the deployment configures none", () => {
    expect(getOrbSigningKey({} as Cloudflare.Env)).toBeUndefined();
    expect(getOrbSigningKey(env())).toBeInstanceOf(Uint8Array);
  });
});

describe("orb inference proxy", () => {
  it("forwards to the provider with the deployment credential attached", async () => {
    const token = await mintInferenceGrant(KEY, CLAIMS);
    const response = await handleOrbInference(
        request(token, { path: "/chat/completions" }), env());

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    // The credential the sandbox never had:
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-deployment-secret");
    expect(captured[0].body).toBe('{"model":"openai/gpt-5.6-luna","messages":[]}');
  });

  it("returns the provider stream and the gateway log id, and nothing else", async () => {
    const token = await mintInferenceGrant(KEY, CLAIMS);
    const response = await handleOrbInference(request(token, { path: "/chat/completions" }), env());

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cf-aig-log-id")).toBe("log-123");
    expect(await response.text()).toBe('data: {"ok":true}\n\n');
  });

  it("never echoes the provider credential back to the caller", async () => {
    const token = await mintInferenceGrant(KEY, CLAIMS);
    const response = await handleOrbInference(request(token, { path: "/chat/completions" }), env());
    const serialized = JSON.stringify([...response.headers]) + await response.text();
    expect(serialized).not.toContain("sk-deployment-secret");
  });

  it("ignores caller-supplied auth headers rather than forwarding them", async () => {
    const token = await mintInferenceGrant(KEY, CLAIMS);
    await handleOrbInference(request(token, {
      path: "/chat/completions",
      headers: { "x-api-key": "sandbox-attacker-key", "cf-aig-authorization": "Bearer nope" },
    }), env());

    expect(captured[0].headers.get("x-api-key")).toBeNull();
    expect(captured[0].headers.get("authorization")).toBe("Bearer sk-deployment-secret");
  });

  it("pins the model to the grant, ignoring the body's model field", async () => {
    // A grant for a managed model; the body asks for something else entirely. Routing is resolved
    // from the grant, so the request still lands on the granted model's endpoint.
    const token = await mintInferenceGrant(KEY, CLAIMS);
    await handleOrbInference(request(token, {
      path: "/chat/completions",
      body: '{"model":"anthropic/claude-opus-4","messages":[]}',
    }), env());
    expect(captured[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured[0].body).toBe('{"model":"openai/gpt-5.6-luna","messages":[]}');
  });

  it("refuses a model the deployment does not manage", async () => {
    const token = await mintInferenceGrant(KEY, {
      ...CLAIMS, provider: "anthropic", model: "claude-sonnet-4-5",
    });
    const response = await handleOrbInference(request(token, { path: "/v1/messages" }), env());
    expect(response.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("refuses a request with no grant", async () => {
    const response = await handleOrbInference(request(undefined), env());
    expect(response.status).toBe(401);
    expect(captured).toHaveLength(0);
  });

  it("refuses a forged grant", async () => {
    const forged = await mintInferenceGrant(
        new TextEncoder().encode("attacker-key-attacker-key-attacker!!"), CLAIMS);
    const response = await handleOrbInference(request(forged), env());
    expect(response.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("refuses every request when no signing key is configured", async () => {
    const token = await mintInferenceGrant(KEY, CLAIMS);
    const response = await handleOrbInference(
        request(token), env({ ORB_TOKEN_SIGNING_KEY: undefined }));
    expect(response.status).toBe(503);
    expect(captured).toHaveLength(0);
  });

  it("cannot redirect the upstream request off the provider's origin", async () => {
    const token = await mintInferenceGrant(KEY, CLAIMS);
    const malformed = await handleOrbInference(
        request(token, { path: "https://attacker.example/steal" }), env());
    expect(malformed.status).toBe(404);
    expect(captured).toHaveLength(0);

    const steal = await handleOrbInference(
        request(token, { path: "/https://attacker.example/steal" }), env());
    expect(steal.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("refuses suffixes that are not the granted model's action path", async () => {
    const token = await mintInferenceGrant(KEY, CLAIMS);
    const files = await handleOrbInference(request(token, { path: "/files" }), env());
    expect(files.status).toBe(403);
    const nested = await handleOrbInference(
        request(token, { path: "/chat/completions/../files" }), env());
    expect(nested.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("only accepts POST", async () => {
    const token = await mintInferenceGrant(KEY, CLAIMS);
    const response = await handleOrbInference(request(token, { method: "GET" }), env());
    expect(response.status).toBe(405);
    expect(captured).toHaveLength(0);
  });
});

describe("pinInferenceModel", () => {
  it("overwrites a JSON body's model field", () => {
    expect(pinInferenceModel('{"model":"x","messages":[]}', "openai/gpt-5.6-luna"))
        .toBe('{"model":"openai/gpt-5.6-luna","messages":[]}');
  });

  it("leaves non-JSON bodies unchanged", () => {
    expect(pinInferenceModel("not-json", "openai/gpt-5.6-luna")).toBe("not-json");
  });
});

describe("inferenceSuffixAllowed", () => {
  it("accepts the OpenAI completions paths", () => {
    expect(inferenceSuffixAllowed("openai-completions", "/chat/completions")).toBe(true);
    expect(inferenceSuffixAllowed("openai-completions", "/v1/chat/completions")).toBe(true);
  });

  it("rejects path traversal and foreign suffixes", () => {
    expect(inferenceSuffixAllowed("openai-completions", "/files")).toBe(false);
    expect(inferenceSuffixAllowed("openai-completions", "/https://attacker.example/steal")).toBe(false);
    expect(inferenceSuffixAllowed("openai-completions", "/chat/completions/../files")).toBe(false);
    expect(inferenceSuffixAllowed("openai-completions", "//chat/completions")).toBe(false);
  });

  it("accepts Google generateContent paths", () => {
    expect(inferenceSuffixAllowed(
        "google-generative-ai", "/v1beta/models/gemini-2.0-flash:generateContent")).toBe(true);
    expect(inferenceSuffixAllowed(
        "google-generative-ai", "/v1beta/models/gemini-2.0-flash:streamGenerateContent")).toBe(true);
  });
});
