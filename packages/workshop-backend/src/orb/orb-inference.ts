import { resolveModelRouting, type UserGatewayRouting } from "../ai-models.js";
import { createWorkshopLogger } from "../observability.js";
import {
  InferenceGrantError, getOrbSigningKey, verifyInferenceGrant,
} from "./inference-grant.js";

const logger = createWorkshopLogger("workshop.orb.inference");

export const ORB_INFERENCE_PATH = "/orb-api/inference";

const FORWARDED_RESPONSE_HEADERS = ["content-type", "cf-aig-log-id"];

const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization", "x-api-key", "x-goog-api-key", "cf-aig-authorization", "cf-aig-metadata",
  "host", "content-length", "cookie", "x-forwarded-for",
]);

export type OrbInferenceAuthorization = {
  userGateway?: UserGatewayRouting;
  sessionAffinity?: string;
};

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function pinInferenceModel(body: string, model: string): string {
  try {
    const json = JSON.parse(body) as unknown;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      (json as { model: string }).model = model;
      return JSON.stringify(json);
    }
  } catch {
  }
  return body;
}

export function rewriteGoogleInferenceSuffix(suffix: string, model: string): string | undefined {
  const match = suffix.match(
      /^(\/v1beta|\/v1)\/models\/[^/]+:(streamGenerateContent|generateContent)$/);
  if (!match) return undefined;
  return `${match[1]}/models/${encodeURIComponent(model)}:${match[2]}`;
}

export function inferenceSuffixAllowed(api: string, suffix: string): boolean {
  if (!suffix.startsWith("/") || suffix.includes("//") || suffix.includes("..")) return false;
  switch (api) {
    case "openai-completions":
      return suffix === "/chat/completions" || suffix === "/v1/chat/completions";
    case "openai-responses":
      return suffix === "/responses" || suffix === "/v1/responses";
    case "anthropic-messages":
      return suffix === "/v1/messages" || suffix === "/messages";
    case "google-generative-ai":
      return rewriteGoogleInferenceSuffix(suffix, "x") !== undefined;
    default:
      return false;
  }
}

async function authorizeLiveTurn(
    ctx: ExecutionContext | undefined, threadId: string, turnId: string, token: string,
): Promise<OrbInferenceAuthorization | undefined> {
  const namespace = ctx?.exports.OverseerDurableObject;
  if (!namespace) return {};
  try {
    const overseer = namespace.get(namespace.idFromString(threadId));
    return await overseer.authorizeOrbInference(turnId, token);
  } catch (error) {
    logger.warn("orb inference turn authorization failed", {
      event: "orb.inference.authorize.failed", durableObjectId: threadId, error,
    });
    return undefined;
  }
}

export async function handleOrbInference(
    req: Request, env: Cloudflare.Env, ctx?: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") {
    return errorResponse(405, "The inference proxy only accepts POST.");
  }

  const key = getOrbSigningKey(env);
  if (!key) {
    return errorResponse(503, "This deployment has no orb token signing key configured.");
  }

  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) {
    return errorResponse(401, "An inference grant is required.");
  }

  let claims;
  try {
    claims = await verifyInferenceGrant(key, token);
  } catch (error) {
    if (error instanceof InferenceGrantError) return errorResponse(403, error.message);
    throw error;
  }

  const live = await authorizeLiveTurn(ctx, claims.threadId, claims.turnId, token);
  if (!live) {
    return errorResponse(403, "Inference grant is not valid for an active turn.");
  }

  let routing;
  try {
    routing = resolveModelRouting(
        env,
        { provider: claims.provider, model: claims.model, apiToken: "" },
        claims.initiator,
        {
          sessionAffinity: live.sessionAffinity ?? claims.threadId,
          userGateway: live.userGateway,
          metadata: { source: "chat", artifactId: claims.threadId },
        });
  } catch (error) {
    return errorResponse(403, error instanceof Error ? error.message : "Model is not available.");
  }

  const { pathname, search } = new URL(req.url);
  if (pathname !== ORB_INFERENCE_PATH && !pathname.startsWith(ORB_INFERENCE_PATH + "/")) {
    return errorResponse(404, "Not an inference request.");
  }
  let suffix = pathname.slice(ORB_INFERENCE_PATH.length);
  if (suffix && !suffix.startsWith("/")) {
    return errorResponse(400, "The inference path suffix must start with '/'.");
  }
  if (!inferenceSuffixAllowed(routing.model.api, suffix)) {
    return errorResponse(403, "This inference path is not allowed for the granted model.");
  }
  if (routing.model.api === "google-generative-ai") {
    suffix = rewriteGoogleInferenceSuffix(suffix, claims.model) ?? suffix;
  }
  const target = `${routing.model.baseUrl}${suffix}${search}`;

  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(routing.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  if (routing.apiKey !== undefined) {
    if (routing.model.api === "google-generative-ai") {
      headers.set("x-goog-api-key", routing.apiKey);
    } else if (routing.model.api === "anthropic-messages" &&
        routing.model.provider !== "openrouter" &&
        !headers.has("cf-aig-authorization")) {
      headers.set("x-api-key", routing.apiKey);
    } else if (!headers.has("authorization") && !headers.has("cf-aig-authorization")) {
      headers.set("Authorization", `Bearer ${routing.apiKey}`);
    }
  }
  if (routing.gatewayMetadata) {
    headers.set("cf-aig-metadata", JSON.stringify(routing.gatewayMetadata));
  }

  const pinnedBody = pinInferenceModel(await req.text(), claims.model);

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: "POST", headers, body: pinnedBody });
  } catch (error) {
    logger.warn("orb inference request failed", {
      event: "orb.inference.failed", durableObjectId: claims.threadId, error,
    });
    return errorResponse(502, "The inference provider could not be reached.");
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
