import {
  AiChatAuthorInfo,
  AiModelConfig,
  AiModelProvider,
  SUGGESTED_MODELS,
} from "@gadgets/workshop-shared/api";
import type { UserAiModelRecord } from "./user.js";

// The model used for quick tasks like title generation when AI Gateway mode is active.
//
// This 70B model is quite fast and cheap and produces pretty good titles. The cost is insignificant
// compared to the actual coding model so there's not much reason to use a smaller model.
const QUICK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class AiGatewayConfig {
  readonly gateway: string;
  readonly workersAiGateway?: string;
  readonly accountId: string;
  readonly apiToken: string;
  readonly providers: Set<string>;

  constructor(env: Cloudflare.Env) {
    this.gateway = env.CF_AI_GATEWAY!;
    // Inference now goes over HTTPS with tokens (pi has no Workers-binding transport), so the
    // account/token pair is required whenever gateway mode is enabled. The token-less
    // same-account mode existed only because of the Workers binding.
    if (!env.CF_AI_GATEWAY_ACCOUNT_ID || !env.CF_AI_GATEWAY_API_TOKEN) {
      throw new Error(
          "CF_AI_GATEWAY_ACCOUNT_ID and CF_AI_GATEWAY_API_TOKEN (a Run + Read token) are " +
          "required when CF_AI_GATEWAY is set.");
    }
    this.accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
    this.apiToken = env.CF_AI_GATEWAY_API_TOKEN;
    if (env.CF_AI_GATEWAY_WAI_DIRECT === "true" && env.CF_AI_GATEWAY_WAI) {
      throw new Error(
          "CF_AI_GATEWAY_WAI and CF_AI_GATEWAY_WAI_DIRECT cannot be configured together.");
    }
    this.workersAiGateway = env.CF_AI_GATEWAY_WAI_DIRECT === "true"
      ? undefined
      : env.CF_AI_GATEWAY_WAI || this.gateway;
    this.providers = new Set(
      (env.CF_AI_GATEWAY_PROVIDERS || "").split(",").map(s => s.trim()).filter(s => s !== "")
    );
  }
}

/**
 * Parse AI Gateway configuration from environment variables. Returns null if AI Gateway
 * mode is not enabled (i.e. CF_AI_GATEWAY is not set).
 */
export function getAiGatewayConfig(env: Cloudflare.Env): AiGatewayConfig | null {
  if (!env.CF_AI_GATEWAY) return null;
  return new AiGatewayConfig(env);
}

const DIRECT_MANAGED_PROVIDERS = new Set<AiModelProvider>(["openrouter"]);

function splitProviders(value: string | undefined): string[] {
  return (value || "").split(",").map(provider => provider.trim()).filter(Boolean);
}

/**
 * Owns the models funded by a deployment, whether they route through Cloudflare AI Gateway or a
 * backend-only provider credential. User-facing model records never contain those credentials.
 */
export class ManagedAiConfig {
  readonly gateway: AiGatewayConfig | null;
  readonly providers: Set<AiModelProvider>;
  readonly defaultModel: string;
  readonly allowsUserModels: boolean;
  readonly #directProviders: Set<AiModelProvider>;
  readonly #openRouterApiToken?: string;

  constructor(env: Cloudflare.Env) {
    const directProviders = splitProviders(env.DEPLOYMENT_AI_PROVIDERS);
    if (env.CF_AI_GATEWAY && directProviders.length > 0) {
      throw new Error(
          "CF_AI_GATEWAY and DEPLOYMENT_AI_PROVIDERS cannot be configured together.");
    }
    this.gateway = getAiGatewayConfig(env);
    this.providers = new Set<AiModelProvider>();
    for (const provider of this.gateway?.providers ?? []) {
      if (provider in SUGGESTED_MODELS) this.providers.add(provider as AiModelProvider);
    }

    this.#directProviders = new Set<AiModelProvider>();
    for (const provider of directProviders) {
      if (!DIRECT_MANAGED_PROVIDERS.has(provider as AiModelProvider)) {
        throw new Error(`Unsupported deployment-managed AI provider "${provider}".`);
      }
      this.providers.add(provider as AiModelProvider);
      this.#directProviders.add(provider as AiModelProvider);
    }
    this.allowsUserModels = this.#directProviders.size === 0;

    if (this.#directProviders.has("openrouter") && !env.OPENROUTER_API_TOKEN) {
      throw new Error(
          "OPENROUTER_API_TOKEN is required when DEPLOYMENT_AI_PROVIDERS includes openrouter.");
    }
    this.#openRouterApiToken = env.OPENROUTER_API_TOKEN;

    const models = this.#unorderedModelList();
    if (models.length === 0) {
      throw new Error("Deployment-managed AI has no models configured.");
    }
    this.defaultModel = env.DEPLOYMENT_AI_DEFAULT_MODEL || models[0].id;
    if (!this.resolveModel(this.defaultModel)) {
      throw new Error(
          `DEPLOYMENT_AI_DEFAULT_MODEL "${this.defaultModel}" is not available from an enabled ` +
          "deployment-managed provider.");
    }
  }

  #unorderedModelList(): AiChatAuthorInfo[] {
    const result: AiChatAuthorInfo[] = [];
    for (const [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (!this.providers.has(provider as AiModelProvider)) continue;
      for (const [id, model] of Object.entries(models)) {
        result.push({ type: "agent", id, name: model.name });
      }
    }
    return result;
  }

  /** Return deployment-managed models with the configured default first. */
  getModelList(): AiChatAuthorInfo[] {
    const models = this.#unorderedModelList();
    const defaultIndex = models.findIndex(model => model.id === this.defaultModel);
    if (defaultIndex > 0) models.unshift(...models.splice(defaultIndex, 1));
    return models;
  }

  /** Resolve a deployment-managed model without exposing its backend credential. */
  resolveModel(modelId: string): UserAiModelRecord | undefined {
    for (const [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider as AiModelProvider) && modelId in models) {
        return {
          profile: { type: "agent", id: modelId, name: models[modelId].name },
          config: { provider: provider as AiModelProvider, model: modelId, apiToken: "" },
        };
      }
    }
    return undefined;
  }

  /** Return the deployment's lightweight model configuration. */
  getQuickModelConfig(): AiModelConfig | undefined {
    if (this.gateway) {
      return { provider: "cloudflare", model: QUICK_MODEL_ID, apiToken: "" };
    }
    return this.resolveModel(this.defaultModel)?.config;
  }

  /** Return a direct provider credential for backend inference only. Never expose over RPC. */
  getDirectApiToken(provider: AiModelProvider): string | undefined {
    if (!this.#directProviders.has(provider)) return undefined;
    if (provider === "openrouter") return this.#openRouterApiToken;
    return undefined;
  }
}

/** Parse deployment-managed AI configuration, or return null when no provider is managed. */
export function getManagedAiConfig(env: Cloudflare.Env): ManagedAiConfig | null {
  if (!env.CF_AI_GATEWAY && splitProviders(env.DEPLOYMENT_AI_PROVIDERS).length === 0) return null;
  return new ManagedAiConfig(env);
}

/** Identifies the Gateway and credentials needed to retrieve an inference log. */
export type AiGatewayLogRoute =
  | { gateway: string }
  | { gateway: string; accountId: string; apiToken: string };

/** Indicates a transient AI Gateway log lookup failure that should be retried. */
export class AiGatewayLogRetryableError extends Error {}

function validateLogCost(cost: unknown): number {
  if (cost === undefined || cost === null) {
    throw new AiGatewayLogRetryableError("AI Gateway log cost is not available yet.");
  }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error("AI Gateway log response contained an invalid cost.");
  }
  return cost;
}

/** Retrieve the cost recorded for an AI Gateway log. */
export async function getAiGatewayLogCost(
    env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string): Promise<number> {
  if (!("accountId" in route)) {
    let log: AiGatewayLog;
    try {
      log = await env.WORKERS_AI.gateway(route.gateway).getLog(logId);
    } catch (error) {
      throw new AiGatewayLogRetryableError("AI Gateway binding log request failed.", {
        cause: error,
      });
    }
    return validateLogCost(log.cost);
  }

  let url = "https://api.cloudflare.com/client/v4/accounts/" +
      `${encodeURIComponent(route.accountId)}/ai-gateway/gateways/` +
      `${encodeURIComponent(route.gateway)}/logs/${encodeURIComponent(logId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${route.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log request failed.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 408 || response.status === 429 ||
        response.status >= 500) {
      throw new AiGatewayLogRetryableError(
          `AI Gateway log request failed with status ${response.status}.`);
    }
    throw new Error(`AI Gateway log request failed with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log response could not be read.", {
      cause: error,
    });
  }
  if (typeof body !== "object" || body === null || !("success" in body) ||
      body.success !== true || !("result" in body) ||
      typeof body.result !== "object" || body.result === null) {
    throw new Error("AI Gateway log response was malformed.");
  }

  let cost = "cost" in body.result ? body.result.cost : undefined;
  return validateLogCost(cost);
}
