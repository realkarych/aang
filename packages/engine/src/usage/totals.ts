import type { TokenUsage, UsageTotals } from '@aang/contract'

export const noTokens: TokenUsage = {
  uncached_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: null,
}

export const addTokens = (sum: TokenUsage, tokens: TokenUsage): TokenUsage => ({
  uncached_input_tokens: sum.uncached_input_tokens + tokens.uncached_input_tokens,
  cache_read_input_tokens: sum.cache_read_input_tokens + tokens.cache_read_input_tokens,
  cache_write_input_tokens: sum.cache_write_input_tokens + tokens.cache_write_input_tokens,
  output_tokens: sum.output_tokens + tokens.output_tokens,
  reasoning_output_tokens:
    tokens.reasoning_output_tokens === null
      ? sum.reasoning_output_tokens
      : (sum.reasoning_output_tokens ?? 0) + tokens.reasoning_output_tokens,
})

export const addCosts = (costs: readonly (number | null)[]): number | null =>
  costs.reduce<number | null>((sum, cost) => (cost === null ? sum : (sum ?? 0) + cost), null)

export const sumTotals = (totals: readonly UsageTotals[]): UsageTotals => ({
  tokens: totals.reduce((sum, { tokens }) => addTokens(sum, tokens), noTokens),
  records: totals.reduce((sum, { records }) => sum + records, 0),
  output_lower_bound: totals.some(({ output_lower_bound: lowerBound }) => lowerBound),
  cost_usd: addCosts(totals.map(({ cost_usd: cost }) => cost)),
})
