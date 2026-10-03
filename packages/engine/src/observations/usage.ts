import type { CostStatePayload, FactKind, RawSeq, RunId, TokenUsage, UsageKey } from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { ObservationDraft, Transaction } from '@aang/store'
import type { AgentIdentity } from './agents.js'
import { byContent, byTime, type Evidence, grouped, type KindEvidence, ofKind } from './evidence.js'

interface UsageContext {
  readonly run: RunId
  readonly identity: AgentIdentity
  readonly inherited: ReadonlySet<RawSeq>
}

const larger = (left: number | null, right: number | null): number | null =>
  left === null ? right : right === null ? left : Math.max(left, right)

export const latest = <K extends FactKind>(items: readonly KindEvidence<K>[]): KindEvidence<K> | null =>
  items.reduce<KindEvidence<K> | null>((last, item) => (last === null || item.raw.seq > last.raw.seq ? item : last), null)

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
  latest(ofKind(items, 'cost_state'))?.fact.payload ?? null

export const threadTotalOf = (items: readonly Evidence[], hidden: boolean): TokenUsage | null =>
  hidden || ofKind(items, 'usage').length > 0 ? null : (latest(ofKind(items, 'usage_total'))?.fact.payload.tokens ?? null)
