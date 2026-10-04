import { ChangeSeq, type Fact, type FactOf, type TokenUsage } from '@aang/contract'
import type { Store } from '@aang/store'

const everything = 1_000_000_000

const derivedId = /^[0-9a-f]{32}$/

const notReferences = new Set(['id', 'artifact'])

const tokenFields = [
  'uncached_input_tokens',
  'cache_read_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
] as const satisfies readonly (keyof TokenUsage)[]

const canonicalText = (value: unknown): string =>
  JSON.stringify(value, (_, member: unknown) => (typeof member === 'bigint' ? member.toString() : member))

const duplicateFacts = (facts: readonly Fact[]): string[] => {
  const seen = new Map<string, Fact>()
  const problems: string[] = []
  for (const fact of facts) {
    const { kind, entity_key, at, runtime_ids, payload } = fact
    const text = canonicalText({ kind, entity_key, at, runtime_ids, payload })
    const first = seen.get(text)
    if (first === undefined) {
      seen.set(text, fact)
    } else {
      problems.push(`duplicate ${kind} fact of ${canonicalText(entity_key)} from records ${String(first.seq)} and ${String(fact.seq)}`)
    }
  }
  return problems
}

const referencesIn = (value: unknown, path: string, found: (path: string, id: string) => void): void => {
  if (typeof value === 'string') {
    if (derivedId.test(value)) {
      found(path, value)
    }
  } else if (Array.isArray(value)) {
    value.forEach((item: unknown) => { referencesIn(item, `${path}[]`, found) })
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      if (!notReferences.has(key)) {
        referencesIn(member, `${path}.${key}`, found)
      }
    }
  }
}

const unresolvedReferences = (store: Store, facts: readonly Fact[]): string[] => {
  const sessions = store.observations.sessions()
  const objects = sessions.flatMap(({ id }) => [
    ...store.observations.agents(id),
    ...store.observations.actions(id),
    ...store.observations.questions(id),
    ...store.observations.usageRecords(id),
  ])
  const runs = store.model.runs()
  const artifacts = runs.flatMap(({ id }) => [...store.artifacts.versions(id), ...store.artifacts.snapshots(id)])
  const entities = runs.flatMap(({ id }) => store.model.entities(id))
  const known = new Set<string>([
    ...facts.map(({ id }) => id),
    ...[...sessions, ...objects, ...artifacts, ...runs].map(({ id }) => id),
    ...entities.flatMap(({ value }) => (typeof value === 'object' && 'id' in value ? [String(value.id)] : [])),
  ])
  const gaps = store.changes.after(ChangeSeq.parse(0), everything).flatMap((change) => (change.layer === 'gap' ? [change.gap] : []))
  const problems = new Set<string>()
  const check = (owner: string, value: unknown): void => {
    referencesIn(value, owner, (path, id) => {
      if (!known.has(id)) {
        problems.add(`${path} refers to ${id}, which is not stored`)
      }
    })
  }
  for (const item of [...sessions, ...objects, ...artifacts, ...gaps]) {
    check(item.key.kind, item)
  }
  for (const run of runs) {
    check('run', run)
  }
  for (const entity of entities) {
    check(entity.kind, entity.value)
  }
  return [...problems].sort()
}

const sumOf = (usages: Iterable<TokenUsage>): Record<(typeof tokenFields)[number], number> => {
  const total = Object.fromEntries(tokenFields.map((field) => [field, 0])) as Record<(typeof tokenFields)[number], number>
  for (const usage of usages) {
    for (const field of tokenFields) {
      total[field] += usage[field] ?? 0
    }
  }
  return total
}

const isKind = <K extends Fact['kind']>(kind: K) => (fact: Fact): fact is FactOf<K> => fact.kind === kind

const threadUsage = (facts: readonly Fact[]): string[] => {
  const codex = facts.filter((fact) => fact.entity_key.runtime === 'codex')
  const forked = new Set(
    codex.filter(isKind('session_start')).flatMap((fact) => (fact.payload.forked_from === null ? [] : [fact.entity_key.session])),
  )
  const records = new Map<string, Map<string, TokenUsage>>()
  for (const fact of codex.filter(isKind('usage'))) {
    const thread = fact.runtime_ids.thread_id
    if (thread !== null && fact.entity_key.kind === 'usage') {
      const usages = records.get(thread) ?? new Map<string, TokenUsage>()
      usages.set(fact.entity_key.usage, fact.payload.tokens)
      records.set(thread, usages)
    }
  }
  const totals = new Map<string, TokenUsage>()
  for (const fact of codex.filter(isKind('usage_total'))) {
    if (fact.payload.source === 'thread_token_usage' && fact.runtime_ids.thread_id !== null) {
      totals.set(fact.runtime_ids.thread_id, fact.payload.tokens)
    }
  }
  return [...totals].flatMap(([thread, total]) => {
    const usages = records.get(thread)
    if (usages === undefined || forked.has(thread)) {
      return []
    }
    const [sum, last] = [sumOf(usages.values()), sumOf([total])]
    return canonicalText(sum) === canonicalText(last)
      ? []
      : [`thread ${thread}: token_usage_record sum ${canonicalText(sum)} differs from the last thread_token_usage ${canonicalText(last)}`]
  })
}

export const invariantViolations = (store: Store): string[] => {
  const facts = store.changes.after(ChangeSeq.parse(0), everything).flatMap((change) => (change.layer === 'fact' ? [change.fact] : []))
  return [...duplicateFacts(facts), ...unresolvedReferences(store, facts), ...threadUsage(facts)]
}
