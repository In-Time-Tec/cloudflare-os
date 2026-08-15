// @gadgets/microsoft-graph — a focused, Workers-native Effect client over Microsoft Graph v1.0.
//
// Deep workload operations only: there is deliberately no `request(path)` escape hatch. Raw Graph
// DTOs stay private; operations return small operation-specific contracts and fail with the tagged
// errors in ./errors.js so callers always know their next valid action.

export * from "./errors.js";
export {
  makeTransport, buildUrl, validateNextLink,
  type GraphTransport, type TokenProvider, type ODataQuery, type PageCursor,
} from "./transport.js";

// Workload modules, namespaced by capability.
export * as mail from "./mail.js";
export * as calendar from "./calendar.js";
export * as files from "./files.js";
export * as teams from "./teams.js";
export * as profile from "./profile.js";
export * as subscriptions from "./subscriptions.js";
