// Tagged provider failures for Microsoft Graph operations.
//
// Every public operation in this package fails with one of these, never a bare Error: the tag
// identifies the caller's next valid action (reconnect, expand consent, retry later, give up).
// The gatekeeper converts them into its session outcomes at the RPC boundary; Effect values and
// these classes never cross Cap'n Web or Workers RPC.

import { Data } from "effect";

/**
 * The delegated credential is no longer usable: the refresh token is gone/expired/revoked, or the
 * tenant issued a Conditional Access claims challenge. The caller's next action is to send the
 * user through reconnect (there is no in-place recovery).
 */
export class GraphAuthError extends Data.TaggedError("GraphAuthError")<{
  reason: "reauthenticate" | "claims_challenge";
  requestId?: string;
}> {}

/**
 * The grant lacks a delegated permission this operation needs (403), or the tenant requires admin
 * consent for it. The caller's next action is to expand consent for the missing capability.
 */
export class GraphConsentError extends Data.TaggedError("GraphConsentError")<{
  detail?: string;
  requestId?: string;
}> {}

/**
 * Graph throttled or briefly refused the request (429/503) and bounded retries were exhausted (or
 * the operation was not retry-safe). `retryAfterMs` is the provider's bounded backoff hint.
 */
export class GraphThrottledError extends Data.TaggedError("GraphThrottledError")<{
  retryAfterMs: number;
  requestId?: string;
}> {}

/** The addressed resource does not exist (404) — or the caller cannot see it, which Graph reports
 *  identically. */
export class GraphNotFoundError extends Data.TaggedError("GraphNotFoundError")<{
  resource: string;
  requestId?: string;
}> {}

/**
 * The write conflicted with a newer remote version (409, or 412 from a stale ETag). The caller
 * must re-read and reconcile before retrying.
 */
export class GraphConflictError extends Data.TaggedError("GraphConflictError")<{
  etag?: string;
  requestId?: string;
}> {}

/** Graph itself failed (5xx other than 503-throttle). Retry-safe reads were already retried. */
export class GraphUnavailableError extends Data.TaggedError("GraphUnavailableError")<{
  status: number;
  requestId?: string;
}> {}

/**
 * The response did not match the schema this package expects — provider contract drift or a
 * malformed body. Never retried; surfacing it loudly beats silently mis-decoding.
 */
export class GraphDecodeError extends Data.TaggedError("GraphDecodeError")<{
  detail: string;
  requestId?: string;
}> {}

/** The union of every failure a public Graph operation can produce. */
export type GraphError =
  | GraphAuthError
  | GraphConsentError
  | GraphThrottledError
  | GraphNotFoundError
  | GraphConflictError
  | GraphUnavailableError
  | GraphDecodeError;
