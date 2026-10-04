import type {
  CallsUsage,
  CallUsage,
  EpochNs,
  Latency,
  ObserverUsage,
  RunId,
  TokenUsage,
  UsageTotals,
} from '@aang/contract'
import type { ObserverCallReader, StoredChatCall } from '@aang/store'
import { type UsagePeriod, within } from './period.js'
import { addCosts, addTokens, noTokens } from './totals.js'

export interface SpentCall {
  readonly started_at: EpochNs
  readonly ended_at: EpochNs
  readonly usages: readonly CallUsage[]
  readonly lag_ms: number | null
}

const nanosPerMs = 1_000_000n

const millisBetween = (from: EpochNs, to: EpochNs): number => Number((to - from) / nanosPerMs)

const tokensOf = (usages: readonly CallUsage[]): TokenUsage[] =>
  usages.flatMap(({ tokens }) => (tokens === null ? [] : [tokens]))

export const combinedUsage = (usages: readonly CallUsage[]): CallUsage | null => {
  if (usages.length === 0) {
    return null
  }
  const tokens = tokensOf(usages)
  return {
    model: usages.findLast(({ model }) => model !== null)?.model ?? null,
    tokens: tokens.length === 0 ? null : tokens.reduce(addTokens, noTokens),
    cost_usd: addCosts(usages.map(({ cost_usd: cost }) => cost)),
  }
}

const callTotals = (usages: readonly CallUsage[]): UsageTotals => ({
  tokens: tokensOf(usages).reduce(addTokens, noTokens),
  records: usages.length,
  output_lower_bound: false,
  cost_usd: addCosts(usages.map(({ cost_usd: cost }) => cost)),
})

const rank = (sorted: readonly number[], share: number): number =>
  sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? 0

export const latencyOf = (values: readonly number[]): Latency | null => {
  const sorted = values.toSorted((left, right) => left - right)
  const max = sorted.at(-1)
  return max === undefined ? null : { p50: rank(sorted, 0.5), p95: rank(sorted, 0.95), max }
}

export const callsUsage = (calls: readonly SpentCall[]): CallsUsage => ({
  calls: calls.length,
  totals: callTotals(calls.flatMap(({ usages }) => usages)),
  latency_ms: latencyOf(calls.map(({ started_at: started, ended_at: ended }) => millisBetween(started, ended))),
})

export const observerUsage = (calls: readonly SpentCall[]): ObserverUsage => ({
  ...callsUsage(calls),
  lag_ms: latencyOf(calls.flatMap(({ lag_ms: lag }) => (lag === null ? [] : [lag]))),
})

const usagesOf = (calls: readonly { readonly usage: CallUsage | null }[]): CallUsage[] =>
  calls.flatMap(({ usage }) => (usage === null ? [] : [usage]))

const chainOf = (first: StoredChatCall, followers: ReadonlyMap<string, StoredChatCall>): StoredChatCall[] => {
  const chain = [first]
  for (let next = followers.get(first.id); next !== undefined; next = followers.get(next.id)) {
    chain.push(next)
  }
  return chain
}

export const chatCalls = (calls: ObserverCallReader, run: RunId, period: UsagePeriod): SpentCall[] => {
  const stored = calls.chats(run)
  const followers = new Map(stored.flatMap((call) => (call.previous === null ? [] : [[call.previous, call] as const])))
  return stored.flatMap((first): SpentCall[] => {
    if (first.previous !== null) {
      return []
    }
    const chain = chainOf(first, followers)
    const last = chain.at(-1) ?? first
    return within(period, last.finished_at)
      ? [{ started_at: first.started_at, ended_at: last.finished_at, usages: usagesOf(chain), lag_ms: null }]
      : []
  })
}

export const probeCalls = (calls: ObserverCallReader, period: UsagePeriod): SpentCall[] =>
  calls.checks().flatMap(({ kind, started_at: started, finished_at: ended, usage }): SpentCall[] =>
    kind === 'probe' && within(period, ended)
      ? [{ started_at: started, ended_at: ended, usages: usage === null ? [] : [usage], lag_ms: null }]
      : [],
  )
