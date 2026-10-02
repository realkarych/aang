import type { FactDraft, TokenUsage, UsageTotalSource } from '@aang/contract'
import { z } from 'zod'
import {
  fact,
  type FactSpec,
  type LineContext,
  type LineFacts,
  runtimeIds,
  threadEntity,
  usageEntity,
} from './facts.js'

const id = z.string().min(1)
const count = z.int().nonnegative()

const Tokens = z.looseObject({
  input_tokens: count,
  cached_input_tokens: count.optional(),
  cache_write_input_tokens: count.optional(),
  output_tokens: count,
  reasoning_output_tokens: count.nullish(),
})
type Tokens = z.infer<typeof Tokens>

const TokenUsageRecord = z.looseObject({
  turn_id: id.optional(),
  response_id: id,
  usage: Tokens,
  thread_token_usage: Tokens.optional(),
})

const TokenCount = z.looseObject({
  info: z.looseObject({ total_token_usage: Tokens }).nullish(),
})

const tokenUsage = (tokens: Tokens): TokenUsage | null => {
  const cacheRead = tokens.cached_input_tokens ?? 0
  const cacheWrite = tokens.cache_write_input_tokens ?? 0
  const uncached = tokens.input_tokens - cacheRead - cacheWrite
  return uncached < 0
    ? null
    : {
        uncached_input_tokens: uncached,
        cache_read_input_tokens: cacheRead,
        cache_write_input_tokens: cacheWrite,
        output_tokens: tokens.output_tokens,
        reasoning_output_tokens: tokens.reasoning_output_tokens ?? null,
      }
}

const runtimeSpec = (context: LineContext, spec: Pick<FactSpec, 'entity' | 'ids'>): FactSpec => ({
  ...spec,
  speaker: 'runtime',
  urgent: false,
  at: context.line.at,
})

const usageTotal = (context: LineContext, source: UsageTotalSource, tokens: TokenUsage, turn: string | null) =>
  fact(
    'usage_total',
    runtimeSpec(context, { entity: threadEntity(context.stream), ids: runtimeIds(context, { turn_id: turn }) }),
    { source, tokens },
  )

export const tokenUsageRecord = (context: LineContext): LineFacts => {
  const parsed = TokenUsageRecord.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const record = parsed.data
  const turn = record.turn_id ?? null
  const tokens = tokenUsage(record.usage)
  const threadTotal = record.thread_token_usage === undefined ? undefined : tokenUsage(record.thread_token_usage)
  if (tokens === null || threadTotal === null) {
    return null
  }
  const facts: FactDraft[] = [
    fact(
      'usage',
      runtimeSpec(context, {
        entity: usageEntity(context.stream, record.response_id),
        ids: runtimeIds(context, { turn_id: turn, message_id: record.response_id }),
      }),
      { model: null, tokens, stop_reason: null, synthetic: false },
    ),
  ]
  if (threadTotal !== undefined) {
    facts.push(usageTotal(context, 'thread_token_usage', threadTotal, turn))
  }
  return facts
}

export const tokenCount = (context: LineContext): LineFacts => {
  const parsed = TokenCount.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const total = parsed.data.info?.total_token_usage
  if (total === undefined) {
    return []
  }
  const tokens = tokenUsage(total)
  return tokens === null ? null : [usageTotal(context, 'token_count', tokens, null)]
}
