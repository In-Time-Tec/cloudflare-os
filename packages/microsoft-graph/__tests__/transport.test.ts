import { describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { buildUrl, makeTransport, validateNextLink } from "../src/transport.js";
import type { GraphError } from "../src/errors.js";

const TOKEN = async () => "test-token";
const S = Schema.Struct({ ok: Schema.Boolean });

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "request-id": "req-1" },
    ...init,
  });
}

async function failureOf<A>(effect: Effect.Effect<A, GraphError>): Promise<GraphError> {
  const flipped = await Effect.runPromise(Effect.flip(effect));
  return flipped;
}

describe("buildUrl", () => {
  it("encodes path segments and query values", () => {
    const url = buildUrl(["me", "messages", "id/with?chars"], {
      select: ["id", "subject"], top: 10, search: 'quarter "Q3" report',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://graph.microsoft.com");
    expect(parsed.pathname).toBe("/v1.0/me/messages/id%2Fwith%3Fchars");
    expect(parsed.searchParams.get("$select")).toBe("id,subject");
    expect(parsed.searchParams.get("$top")).toBe("10");
    // Embedded quotes in a search term are escaped, not query-breaking.
    expect(parsed.searchParams.get("$search")).toBe('"quarter \\"Q3\\" report"');
  });

  it("encodes the calendarView window", () => {
    const url = new URL(buildUrl(["me", "calendarView"], {
      window: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" },
    }));
    expect(url.searchParams.get("startDateTime")).toBe("2026-01-01T00:00:00Z");
    expect(url.searchParams.get("endDateTime")).toBe("2026-01-02T00:00:00Z");
  });
});

describe("validateNextLink", () => {
  it("accepts same-origin /v1.0/ links and rejects everything else", () => {
    expect(validateNextLink("https://graph.microsoft.com/v1.0/me/messages?$skip=25"))
        .not.toBeNull();
    expect(validateNextLink("https://evil.example.com/v1.0/me/messages")).toBeNull();
    expect(validateNextLink("https://graph.microsoft.com/beta/me/messages")).toBeNull();
    expect(validateNextLink("not a url")).toBeNull();
  });
});

describe("error mapping", () => {
  async function statusFailure(status: number, headers: Record<string, string> = {}) {
    const fetchMock = vi.fn(async () => new Response("{}", { status, headers }));
    const transport = makeTransport(TOKEN, fetchMock as typeof fetch);
    return failureOf(transport.get(["me"], S));
  }

  it("maps 401 to reauthenticate and claims challenges distinctly", async () => {
    expect((await statusFailure(401))._tag).toBe("GraphAuthError");
    const claims = await statusFailure(401, {
      "WWW-Authenticate": 'Bearer realm="", error="insufficient_claims", claims="eyJhY2Nlc3M..."',
    });
    expect(claims._tag).toBe("GraphAuthError");
    expect((claims as { reason: string }).reason).toBe("claims_challenge");
  });

  it("maps 403/404/409/412/500", async () => {
    expect((await statusFailure(403))._tag).toBe("GraphConsentError");
    expect((await statusFailure(404))._tag).toBe("GraphNotFoundError");
    expect((await statusFailure(409))._tag).toBe("GraphConflictError");
    expect((await statusFailure(412))._tag).toBe("GraphConflictError");
    expect((await statusFailure(500))._tag).toBe("GraphUnavailableError");
  });

  it("fails with GraphAuthError when the token provider returns null", async () => {
    const fetchMock = vi.fn();
    const transport = makeTransport(async () => null, fetchMock as unknown as typeof fetch);
    const failure = await failureOf(transport.get(["me"], S));
    expect(failure._tag).toBe("GraphAuthError");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails with GraphDecodeError when the body does not match the schema", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: "not-a-boolean" }));
    const transport = makeTransport(TOKEN, fetchMock as typeof fetch);
    const failure = await failureOf(transport.get(["me"], S));
    expect(failure._tag).toBe("GraphDecodeError");
    expect((failure as { requestId?: string }).requestId).toBe("req-1");
  });
});

describe("retry policy", () => {
  it("retries throttled GETs per Retry-After and then succeeds", async () => {
    const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "0" } }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const transport = makeTransport(TOKEN, fetchMock as typeof fetch);
    const result = await Effect.runPromise(transport.get(["me"], S));
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded retry budget", async () => {
    const fetchMock = vi.fn(async () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "0" } }));
    const transport = makeTransport(TOKEN, fetchMock as typeof fetch);
    const failure = await failureOf(transport.get(["me"], S));
    expect(failure._tag).toBe("GraphThrottledError");
    expect(fetchMock).toHaveBeenCalledTimes(3);  // 1 attempt + 2 retries
  });

  it("NEVER retries a POST, even when throttled", async () => {
    const fetchMock = vi.fn(async () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "0" } }));
    const transport = makeTransport(TOKEN, fetchMock as typeof fetch);
    const failure = await failureOf(transport.post(["me", "messages"], { a: 1 }, S));
    expect(failure._tag).toBe("GraphThrottledError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("request shape", () => {
  it("sends the bearer token and JSON body; DELETE decodes nothing", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return init.method === "DELETE"
          ? new Response(null, { status: 204 })
          : jsonResponse({ ok: true });
    });
    const transport = makeTransport(TOKEN, fetchMock as unknown as typeof fetch);

    await Effect.runPromise(transport.post(["me", "events"], { subject: "x" }, S));
    await Effect.runPromise(transport.del(["me", "events", "e1"]));

    expect((calls[0].init.headers as Record<string, string>)["Authorization"])
        .toBe("Bearer test-token");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ subject: "x" });
    expect(calls[1].init.method).toBe("DELETE");
  });

  it("getText enforces the byte limit", async () => {
    const fetchMock = vi.fn(async () => new Response("x".repeat(100)));
    const transport = makeTransport(TOKEN, fetchMock as typeof fetch);
    expect(await Effect.runPromise(transport.getText(["f"], 1000))).toBe("x".repeat(100));
    const failure = await failureOf(transport.getText(["f"], 10));
    expect(failure._tag).toBe("GraphDecodeError");
  });
});
