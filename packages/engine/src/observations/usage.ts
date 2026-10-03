import type { CostStatePayload, RawSeq, RunId, TokenUsage, UsageKey } from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { ObservationDraft, Transaction } from '@aang/store'
import type { AgentIdentity } from './agents.js'
import { byContent, byTime, compareText, type Evidence, grouped, type KindEvidence, ofKind } from './evidence.js'

interface UsageContext {
  readonly run: RunId
  readonly identity: AgentIdentity
  readonly inherited: ReadonlySet<RawSeq>
}

const larger = (left: number | null, right: number | null): number | null =>
  left === null ? right : right === null ? left : Math.max(left, right)

type Order<T> = (left: T, right: T) => number

const byValue = (left: number | null, right: number | null): number => (left ?? -1) - (right ?? -1)

const lineOf = ({ raw }: Evidence): number => (raw.position.kind === 'line' ? raw.position.line : 0)

const lastOf = <T extends Evidence>(items: readonly T[], order: Order<T>): T | null =>
  items.reduce<T | null>(
    (last, item) => (last === null || (order(item, last) || compareText(item.fact.id, last.fact.id)) > 0 ? item : last),
    null,
  )

export const byAccumulation: Order<KindEvidence<'cost_state'>> = (left, right) =>
  byValue(left.fact.payload.total_duration_ms, right.fact.payload.total_duration_ms) ||
  byValue(left.fact.payload.total_cost_usd, right.fact.payload.total_cost_usd) ||
  lineOf(left) - lineOf(right)

const byOrdinal: Order<KindEvidence<'usage_total'>> = (left, right) =>
  byValue(left.fact.runtime_ids.ordinal, right.fact.runtime_ids.ordinal)

export const lastCostState = (items: readonly Evidence[]): KindEvidence<'cost_state'> | null =>
  lastOf(ofKind(items, 'cost_state'), byAccumulation)

const recordTokens = (content: readonly KindEvidence<'usage'>[], first: KindEvidence<'usage'>): TokenUsage => ({
  ...first.fact.payload.tokens,
  output_tokens: Math.max(...content.map(({ fact }) => fact.payload.tokens.output_tokens)),
  reasoning_output_tokens: content.reduce<number | null>(
    (value, { fact }) => larger(value, fact.payload.tokens.reasoning_output_tokens),
    null,
  ),
})

const projectRecord = (
  transaction: Transaction,
  key: UsageKey,
  items: readonly [KindEvidence<'usage'>, ...KindEvidence<'usage'>[]],
  { run, identity, inherited }: UsageContext,
): string => {
  const content = items.toSorted(byContent)
  const first = content[0] ?? items[0]
  const draft: ObservationDraft = {
    id: objectId(key),
    key,
    session: objectId({ kind: 'session', runtime: key.runtime, session: key.session }),
    agent: objectId(identity.of(first.fact)),
    run,
    model: content.find(({ fact }) => fact.payload.model !== null)?.fact.payload.model ?? null,
    tokens: recordTokens(content, first),
    output_lower_bound: key.runtime === 'claude' && content.every(({ fact }) => fact.payload.stop_reason === null),
    synthetic: content.some(({ fact }) => fact.payload.synthetic),
    inherited: content.every(({ raw }) => inherited.has(raw.seq)),
    at: (items.toSorted(byTime)[0] ?? first).fact.at,
  }
  return transaction.observations.save(draft).id
}

export const projectUsage = (
  transaction: Transaction,
  evidence: readonly Evidence[],
  context: UsageContext,
): string[] =>
  [...grouped(ofKind(evidence, 'usage'), ({ fact }) => canonicalJson(fact.entity_key)).values()].flatMap((items) => {
    const key = items[0].fact.entity_key
    return key.kind === 'usage' ? [projectRecord(transaction, key, items, context)] : []
  })

export const costStateOf = (items: readonly Evidence[]): CostStatePayload | null =>
  lastCostState(items)?.fact.payload ?? null

export const threadTotalOf = (items: readonly Evidence[], hidden: boolean): TokenUsage | null =>
  hidden || ofKind(items, 'usage').length > 0
    ? null
    : (lastOf(ofKind(items, 'usage_total'), byOrdinal)?.fact.payload.tokens ?? null)
