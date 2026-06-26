import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { Provider } from "./provider"
import { ProviderTransform } from "./transform"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }): number {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function withUsable(input: { cfg: ConfigV1.Info; provider: Provider.Info; outputTokenMax?: number }): Provider.Info {
  return {
    ...input.provider,
    models: Object.fromEntries(
      Object.entries(input.provider.models).map(([id, model]) => [
        id,
        {
          ...model,
          limit: {
            ...model.limit,
            usable: usable({ cfg: input.cfg, model, outputTokenMax: input.outputTokenMax }),
          },
        },
      ]),
    ),
  }
}

export * as ProviderContextLimit from "./context-limit"
