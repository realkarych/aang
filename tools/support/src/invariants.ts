import {
  Action,
  Agent,
  ArtifactVersion,
  ChangeSeq,
  type Fact,
  type FactOf,
  Gap,
  GitSnapshot,
  ModelEntity,
  Question,
  Run,
  Session,
  type TokenUsage,
  UsageRecord,
} from '@aang/contract'
import type { Store } from '@aang/store'
import type { z } from 'zod'
import { unparsedRecords } from './record-types.js'
import { mapIds } from './references.js'

const everything = 1_000_000_000

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

const unresolvedReferences = (store: Store, facts: readonly Fact[]): string[] => {
  const sessions = store.observations.sessions()
  const ofSessions = <T>(read: (session: (typeof sessions)[number]['id']) => T[]): T[] => sessions.flatMap(({ id }) => read(id))
  const agents = ofSessions(store.observations.agents)
  const actions = ofSessions(store.observations.actions)
  const questions = ofSessions(store.observations.questions)
  const usage = ofSessions(store.observations.usageRecords)
  const runs = store.model.runs()
  const versions = runs.flatMap(({ id }) => store.artifacts.versions(id))
  const snapshots = runs.flatMap(({ id }) => store.artifacts.snapshots(id))
  const entities = runs.flatMap(({ id }) => store.model.entities(id))
  const calls = runs.flatMap(({ id }) => store.observerCalls.ofRun(id))
  const gaps = store.changes.after(ChangeSeq.parse(0), everything).flatMap((change) => (change.layer === 'gap' ? [change.gap] : []))
  const known = new Set<string>([
    ...[...facts, ...sessions, ...agents, ...actions, ...questions, ...usage, ...versions, ...snapshots, ...gaps, ...runs, ...calls].map(({ id }) => id),
    ...versions.map(({ artifact }) => artifact),
    ...entities.flatMap(({ value }) => ('id' in value ? [value.id] : [])),
  ])
  const problems = new Set<string>()
  const check = (owner: string, schema: z.ZodType, items: readonly unknown[]): void => {
    for (const item of items) {
      mapIds(schema, item, (id, path) => {
        if (!known.has(id)) {
          problems.add(`${path} refers to ${id}, which is not stored`)
        }
        return id
      }, owner)
    }
  }
  check('session', Session, sessions)
  check('agent', Agent, agents)
  check('action', Action, actions)
  check('question', Question, questions)
  check('usage', UsageRecord, usage)
  check('artifact_version', ArtifactVersion, versions)
  check('git_snapshot', GitSnapshot, snapshots)
  check('gap', Gap, gaps)
  check('run', Run, runs)
  for (const entity of entities) {
    check(entity.kind, ModelEntity, [entity])
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
  const changes = store.changes.after(ChangeSeq.parse(0), everything)
  const records = changes.flatMap((change) => (change.layer === 'raw_record' ? [change.record] : []))
  const facts = changes.flatMap((change) => (change.layer === 'fact' ? [change.fact] : []))
  return [...unparsedRecords(records), ...duplicateFacts(facts), ...unresolvedReferences(store, facts), ...threadUsage(facts)]
}
