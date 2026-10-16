import { OpenRouter } from "@openrouter/sdk";
import type { AppConfig } from "../../../config/env.js";

export type OpenRouterRuntime = {
  client: OpenRouter;
  models: readonly string[];
};

export function createOpenRouterRuntime(
  config: NonNullable<AppConfig["openRouter"]>,
): OpenRouterRuntime {
  return {
    client: new OpenRouter({
      apiKey: config.apiKey,
      serverURL: config.baseUrl,
      timeoutMs: config.timeoutMs,
    }),
    models: Object.freeze(config.models.slice(0, config.maxModelAttempts)),
  };
}
