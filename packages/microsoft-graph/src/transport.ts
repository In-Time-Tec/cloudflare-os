// The single place this package talks HTTP to Microsoft Graph.
//
// Everything above this module works with decoded values and tagged failures; everything below is
// `fetch` against https://graph.microsoft.com/v1.0. The transport owns:
//   - bearer-token injection (via a caller-supplied TokenProvider; tokens never appear in results),
//   - constrained OData query construction (callers pass data, never URL fragments),
//   - HTTP-status -> GraphError mapping, including Conditional Access claims challenges,
//   - Retry-After-honoring bounded retries for retry-safe GETs (mutations are NEVER auto-retried),
//   - @odata.nextLink validation (same host, /v1.0/ path) before a continuation is followed,
//   - schema decoding at the provider boundary, with bounded diagnostics.
//
// Raw Graph DTOs and continuation URLs stay inside this package; operations return small
// operation-specific contracts and opaque cursors.

import { Effect, Formatter, Result, Schema } from "effect";
import {
  GraphAuthError, GraphConflictError, GraphConsentError, GraphDecodeError, GraphError,
  GraphNotFoundError, GraphThrottledError, GraphUnavailableError,
} from "./errors.js";

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;

// Bounded retry policy for retry-safe reads: at most 2 retries (3 attempts), and never sleep
// longer than this per wait even if Retry-After asks for more (we surface throttling instead).
const MAX_READ_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 8000;
const DEFAULT_RETRY_WAIT_MS = 1000;

/**
 * Supplies a usable delegated access token for one request. Returning null means the credential
 * is gone or can no longer be refreshed — the operation fails with GraphAuthError(reauthenticate).
 * The gatekeeper closes this over its account Durable Object; the token never outlives the call.
 */
export type TokenProvider = () => Promise<string | null>;

/**
 * Constrained OData options. Values are data: the transport encodes them, so callers can never
 * smuggle arbitrary query fragments or headers into a request.
 */
export type ODataQuery = {
  select?: readonly string[];
  top?: number;
  orderby?: string;
  filter?: string;
  search?: string;
  expand?: string;
  /** calendarView's required window (ISO instants), encoded as startDateTime/endDateTime. */
  window?: { start: string; end: string };
};

/**
 * An opaque continuation for one paged listing. Wraps a validated @odata.nextLink; consumers hold
 * it server-side and pass it back to the same operation. The URL inside is never exposed.
 */
export type PageCursor = { readonly __graphNextLink: string };

/** Options for one request. `consistencyLevel` opts into Graph's eventual-consistency search. */
type RequestOptions = {
  query?: ODataQuery;
  /** Extra headers the transport itself decides to send (e.g. ConsistencyLevel: eventual). */
  consistencyLevel?: "eventual";
  /** If-Match header value for optimistic-concurrency writes. */
  ifMatch?: string;
};

/**
 * The transport interface operations are written against. `get` retries per policy; `post`,
 * `patch`, and `del` never auto-retry because their outcome may be unknown after a failure.
 */
export interface GraphTransport {
  get<A>(segments: readonly string[], schema: Schema.Codec<A, any>,
         options?: RequestOptions): Effect.Effect<A, GraphError>;
  /** Follow a previously returned, already-validated continuation. */
  getPage<A>(cursor: PageCursor, schema: Schema.Codec<A, any>): Effect.Effect<A, GraphError>;
  post<A>(segments: readonly string[], body: unknown, schema: Schema.Codec<A, any>,
          options?: RequestOptions): Effect.Effect<A, GraphError>;
  patch<A>(segments: readonly string[], body: unknown, schema: Schema.Codec<A, any>,
           options?: RequestOptions): Effect.Effect<A, GraphError>;
  /** DELETE; Graph returns 204 with no body, so there is nothing to decode. */
  del(segments: readonly string[], options?: RequestOptions): Effect.Effect<void, GraphError>;
  /**
   * GET a raw (non-JSON) body as text, following Graph's content redirect, refusing bodies larger
   * than `maxBytes`. For text-y file content only.
   */
  getText(segments: readonly string[], maxBytes: number): Effect.Effect<string, GraphError>;
}

/** Build the request URL from path segments (each encoded) and constrained query options. */
export function buildUrl(segments: readonly string[], query?: ODataQuery): string {
  const path = segments.map(encodeURIComponent).join("/");
  const url = new URL(`${GRAPH_BASE}/${path}`);
  if (query?.select?.length) url.searchParams.set("$select", query.select.join(","));
  if (query?.top !== undefined) url.searchParams.set("$top", String(Math.floor(query.top)));
  if (query?.orderby) url.searchParams.set("$orderby", query.orderby);
  if (query?.filter) url.searchParams.set("$filter", query.filter);
  if (query?.search) url.searchParams.set("$search", `"${query.search.replaceAll('"', '\\"')}"`);
  if (query?.expand) url.searchParams.set("$expand", query.expand);
  if (query?.window) {
    url.searchParams.set("startDateTime", query.window.start);
    url.searchParams.set("endDateTime", query.window.end);
  }
  return url.toString();
}

/**
 * Validate a @odata.nextLink before it becomes a PageCursor. Only same-origin /v1.0/ URLs are
 * followed; anything else is provider contract drift (or an injection attempt) and is rejected.
 */
export function validateNextLink(link: string): PageCursor | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith("/v1.0/")) return null;
  return { __graphNextLink: url.toString() };
}

function requestIdOf(response: Response): string | undefined {
  return response.headers.get("request-id") ?? undefined;
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("Retry-After");
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_RETRY_WAIT_MS;
}

/** Map a non-2xx Graph response to its tagged failure. Bodies are drained but never logged. */
async function mapFailure(response: Response, resource: string): Promise<GraphError> {
  const requestId = requestIdOf(response);
  response.body?.cancel();
  switch (response.status) {
    case 401: {
      const www = response.headers.get("WWW-Authenticate") ?? "";
      return new GraphAuthError({
        reason: www.includes("claims=") ? "claims_challenge" : "reauthenticate",
        requestId,
      });
    }
    case 403:
      return new GraphConsentError({ requestId });
    case 404:
      return new GraphNotFoundError({ resource, requestId });
    case 409:
    case 412:
      return new GraphConflictError({ etag: response.headers.get("ETag") ?? undefined, requestId });
    case 429:
    case 503:
      return new GraphThrottledError({ retryAfterMs: retryAfterMs(response), requestId });
    default:
      return new GraphUnavailableError({ status: response.status, requestId });
  }
}

function decodeBody<A>(schema: Schema.Codec<A, any>, body: unknown,
                       requestId: string | undefined): Effect.Effect<A, GraphDecodeError> {
  const result = Schema.decodeUnknownResult(schema)(body);
  if (Result.isSuccess(result)) return Effect.succeed(result.success);
  // Bounded diagnostic: the formatter output identifies the failing path/expectation without
  // reproducing the response body.
  const detail = Formatter.format(result.failure.issue).slice(0, 500);
  return Effect.fail(new GraphDecodeError({ detail, requestId }));
}

/**
 * Create a transport bound to one credential. `fetchImpl` is injectable for tests; production
 * uses the platform fetch.
 */
export function makeTransport(
  tokenProvider: TokenProvider,
  fetchImpl: typeof fetch = fetch,
): GraphTransport {
  function request<A>(method: "GET" | "POST" | "PATCH" | "DELETE",
                      url: string, resource: string,
                      schema: Schema.Codec<A, any> | null,
                      body: unknown | undefined,
                      options: RequestOptions | undefined,
                      retriesLeft: number): Effect.Effect<A, GraphError> {
    return Effect.gen(function* () {
      const token = yield* Effect.tryPromise({
        try: () => tokenProvider(),
        catch: () => new GraphAuthError({ reason: "reauthenticate" }),
      });
      if (token === null) {
        return yield* Effect.fail(new GraphAuthError({ reason: "reauthenticate" }));
      }

      const headers: Record<string, string> = { "Authorization": `Bearer ${token}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (options?.consistencyLevel) headers["ConsistencyLevel"] = options.consistencyLevel;
      if (options?.ifMatch) headers["If-Match"] = options.ifMatch;

      const response = yield* Effect.tryPromise({
        try: () => fetchImpl(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        catch: () => new GraphUnavailableError({ status: 0 }),
      });

      if (!response.ok) {
        const failure = yield* Effect.tryPromise({
          try: () => mapFailure(response, resource),
          catch: () => new GraphUnavailableError({ status: response.status }),
        });
        // Retry only throttle-class failures, only for GETs, only within the bounded budget.
        if (failure._tag === "GraphThrottledError" && method === "GET" && retriesLeft > 0) {
          yield* Effect.sleep(Math.min(failure.retryAfterMs, MAX_RETRY_WAIT_MS));
          return yield* request<A>(method, url, resource, schema, body, options, retriesLeft - 1);
        }
        return yield* Effect.fail(failure);
      }

      if (schema === null) {
        response.body?.cancel();
        return undefined as A;
      }
      const requestId = requestIdOf(response);
      const json = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new GraphDecodeError({ detail: "response body was not JSON", requestId }),
      });
      return yield* decodeBody(schema, json, requestId);
    });
  }

  return {
    get(segments, schema, options) {
      return request("GET", buildUrl(segments, options?.query), segments.join("/"),
          schema, undefined, options, MAX_READ_RETRIES);
    },
    getPage(cursor, schema) {
      return request("GET", cursor.__graphNextLink, "next page", schema, undefined,
          undefined, MAX_READ_RETRIES);
    },
    post(segments, body, schema, options) {
      return request("POST", buildUrl(segments, options?.query), segments.join("/"),
          schema, body, options, 0);
    },
    patch(segments, body, schema, options) {
      return request("PATCH", buildUrl(segments, options?.query), segments.join("/"),
          schema, body, options, 0);
    },
    del(segments, options) {
      return request("DELETE", buildUrl(segments, options?.query), segments.join("/"),
          null, undefined, options, 0) as Effect.Effect<void, GraphError>;
    },
    getText(segments, maxBytes) {
      const url = buildUrl(segments);
      const resource = segments.join("/");
      return Effect.gen(function* () {
        const token = yield* Effect.tryPromise({
          try: () => tokenProvider(),
          catch: () => new GraphAuthError({ reason: "reauthenticate" }),
        });
        if (token === null) {
          return yield* Effect.fail(new GraphAuthError({ reason: "reauthenticate" }));
        }
        // fetch follows the 302 to the pre-authenticated download URL automatically; the redirect
        // target carries its own short-lived token, so the Authorization header going with it is
        // harmless and expected.
        const response = yield* Effect.tryPromise({
          try: () => fetchImpl(url, { headers: { "Authorization": `Bearer ${token}` } }),
          catch: () => new GraphUnavailableError({ status: 0 }),
        });
        if (!response.ok) {
          return yield* Effect.tryPromise({
            try: () => mapFailure(response, resource),
            catch: () => new GraphUnavailableError({ status: response.status }),
          }).pipe(Effect.flatMap(Effect.fail));
        }
        const length = Number(response.headers.get("Content-Length") ?? "0");
        if (length > maxBytes) {
          response.body?.cancel();
          return yield* Effect.fail(new GraphDecodeError({
            detail: `content is ${length} bytes; limit is ${maxBytes}`,
          }));
        }
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: () => new GraphDecodeError({ detail: "content read failed" }),
        });
        if (text.length > maxBytes) {
          return yield* Effect.fail(new GraphDecodeError({
            detail: `content exceeds the ${maxBytes}-byte limit`,
          }));
        }
        return text;
      });
    },
  };
}
