import type { CostStatePayload, FactDraft, TokenUsage } from '@aang/contract'
import { z } from 'zod'
import { fact, type FactOrigin } from './facts.js'
import { name } from './fields.js'
import { usageKey } from './keys.js'

const tokenCount = z.int().nonnegative()

const cost = z.number().nonnegative()

export const MessageUsage = z.looseObject({
  input_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount.nullish(),
  cache_read_input_tokens: tokenCount.nullish(),
  output_tokens: tokenCount,
  output_tokens_details: z.looseObject({ thinking_tokens: tokenCount.nullish() }).nullish(),
})
type MessageUsage = z.infer<typeof MessageUsage>

const ModelUsage = z.looseObject({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadInputTokens: tokenCount.nullish(),
  cacheCreationInputTokens: tokenCount.nullish(),
  thinkingTokens: tokenCount.nullish(),
  costUSD: cost.nullish(),
})

export const CostState = z.looseObject({
  totalCostUSD: cost.nullish(),
  totalDuration: tokenCount.nullish(),
  modelUsage: z.record(name, ModelUsage).nullish(),
  hasUnknownModelCost: z.boolean().nullish(),
})
type CostState = z.infer<typeof CostState>

export interface ApiMessage {
  readonly id: string
  readonly model?: string | null | undefined
  readonly stop_reason?: string | null | undefined
  readonly usage?: MessageUsage | null | undefined
}

const syntheticModel = '<synthetic>'

const messageTokens = (usage: MessageUsage): TokenUsage => ({
  uncached_input_tokens: usage.input_tokens,
  cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  cache_write_input_tokens: usage.cache_creation_input_tokens ?? 0,
  output_tokens: usage.output_tokens,
  reasoning_output_tokens: usage.output_tokens_details?.thinking_tokens ?? null,
})

export const messageUsage = (origin: FactOrigin, session: string, message: ApiMessage): FactDraft[] => {
  const { usage } = message
  if (usage === null || usage === undefined) {
    return []
  }
  const synthetic = message.model === syntheticModel
  return [
    fact(
      origin,
      {
        kind: 'usage',
        entity_key: usageKey(session, message.id),
        speaker: 'runtime',
        urgent: false,
        payload: {
          model: message.model ?? null,
          tokens: messageTokens(usage),
          stop_reason: message.stop_reason ?? null,
          synthetic,
        },
      },
      { verified: !synthetic },
    ),
  ]
}

export const costStatePayload = (state: CostState): CostStatePayload => {
  const reported = (value: number | null | undefined) =>
    state.hasUnknownModelCost === true ? null : (value ?? null)
  return {
    total_cost_usd: reported(state.totalCostUSD),
    total_duration_ms: state.totalDuration ?? null,
    models: Object.entries(state.modelUsage ?? {}).map(([model, usage]) => ({
      model,
      tokens: {
        uncached_input_tokens: usage.inputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
        cache_write_input_tokens: usage.cacheCreationInputTokens ?? 0,
        output_tokens: usage.outputTokens,
        reasoning_output_tokens: usage.thinkingTokens ?? null,
      },
      cost_usd: reported(usage.costUSD),
    })),
  }
}
