import type {
  AnthropicMessagesCompat, Api, Model, SimpleStreamOptions, StreamFunction,
} from "@earendil-works/pi-ai";
import { stream as anthropicMessagesStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as googleGenerativeAiStream } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as openaiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as openaiResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { bridgePdfAttachments } from "@gadgets/agent-core";
import type { ModelHandle, ModelStreamOptions } from "@gadgets/workshop-shared/agent-types";
import type { OrbTurnRecord } from "@gadgets/workshop-shared/orb-harness";

const API_STREAMS: Record<string, StreamFunction<Api, SimpleStreamOptions>> = {
  "anthropic-messages": anthropicMessagesStream as StreamFunction<Api, SimpleStreamOptions>,
  "openai-responses": openaiResponsesStream as StreamFunction<Api, SimpleStreamOptions>,
  "openai-completions": openaiCompletionsStream as StreamFunction<Api, SimpleStreamOptions>,
  "google-generative-ai": googleGenerativeAiStream as StreamFunction<Api, SimpleStreamOptions>,
};

export function makeProxyHandle(turn: OrbTurnRecord): ModelHandle {
  const streamFn = API_STREAMS[turn.model.api];
  if (!streamFn) {
    throw new Error(`Unsupported model API "${turn.model.api}".`);
  }
  const anthropicCompat = turn.model.compat as AnthropicMessagesCompat | undefined;
  const apiExtras: Record<string, unknown> =
      turn.model.api === "anthropic-messages"
          ? (anthropicCompat?.forceAdaptiveThinking === true ? { thinkingEnabled: true } : {}) :
      turn.model.api === "openai-responses" || turn.model.provider === "openrouter"
          ? { reasoningEffort: "medium" } : {};

  const handle: ModelHandle = {
    model: turn.model as Model<Api>,
    aiGatewayLogRoute: turn.aiGatewayLogRoute as ModelHandle["aiGatewayLogRoute"],
    stream: (model, context, { thinking = true, ...options } = {}) => {
      handle.lastResponse = undefined;
      const merged: SimpleStreamOptions = {
        ...(thinking
            ? apiExtras
            : turn.model.api === "anthropic-messages" ? { thinkingEnabled: false } : {}),
        ...options,
        apiKey: "orb-grant",
        headers: {
          ...options.headers,
          Authorization: `Bearer ${turn.grantJwt}`,
        },
        onResponse: async (response, responseModel) => {
          handle.lastResponse = {
            status: response.status,
            aiGatewayLogId: header(response.headers, "cf-aig-log-id"),
          };
          await options.onResponse?.(response, responseModel);
        },
        onPayload: async (payload, payloadModel) => {
          const replaced = await options.onPayload?.(payload, payloadModel);
          return bridgePdfAttachments(turn.model.api, replaced ?? payload) ?? replaced;
        },
      };
      return streamFn(model, context, merged);
    },
  };
  return handle;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export type { ModelStreamOptions };
