import type { Api, Model } from "@earendil-works/pi-ai";
import type { AiGatewayLogRoute } from "@gadgets/workshop-shared/agent-types";
import type { OrbModelSnapshot } from "@gadgets/workshop-shared/orb-harness";
import { ORB_INFERENCE_PATH } from "./orb-inference.js";
import { getOrbSigningKey } from "./inference-grant.js";

export function publicOrigin(env: Cloudflare.Env): string | undefined {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

export function inferenceProxyBase(origin: string): string {
  return `${origin}${ORB_INFERENCE_PATH}`;
}

export function orbTurnUnavailableReason(env: Cloudflare.Env): string | undefined {
  if (!env.E2B_API_KEY) {
    return "This deployment cannot run agent turns: no machine (orb) is configured.";
  }
  if (!getOrbSigningKey(env)) {
    return "This deployment cannot run agent turns: orb authentication is not configured.";
  }
  if (!publicOrigin(env)) {
    return "This deployment cannot run agent turns: PUBLIC_BASE_URL is not set.";
  }
  return undefined;
}

export function snapshotOrbModel(model: Model<Api>, proxyBase: string): OrbModelSnapshot {
  const { headers: _headers, apiKey: _apiKey, ...rest } =
      model as Model<Api> & { headers?: unknown; apiKey?: unknown };
  return { ...rest, baseUrl: proxyBase };
}

export function stripLogRoute(route?: AiGatewayLogRoute)
    : { gateway: string; accountId?: string } | undefined {
  if (!route) return undefined;
  if ("accountId" in route) return { gateway: route.gateway, accountId: route.accountId };
  return { gateway: route.gateway };
}
