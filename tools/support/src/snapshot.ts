import {
  Action,
  Agent,
  ArtifactVersion,
  ChangeSeq,
  Fact,
  Gap,
  GitSnapshot,
  ModelEntity,
  ObservationRemoval,
  Question,
  type RawRecord,
  Run,
  RunId,
  Session,
  UsageRecord,
} from '@aang/contract'
import type { Store } from '@aang/store'
import { z } from 'zod'
import { recordType } from './record-types.js'
import { mapIds } from './references.js'

export type SnapshotValue = null | boolean | number | string | readonly SnapshotValue[] | { readonly [key: string]: SnapshotValue }

export interface RecordCount {
  readonly channel: string
  readonly type: string
  readonly parse_state: string
  readonly count: number
}

export interface ContractSnapshot {
  readonly records: readonly RecordCount[]
  readonly facts: SnapshotValue
  readonly sessions: SnapshotValue
  readonly agents: SnapshotValue
  readonly actions: SnapshotValue
  readonly questions: SnapshotValue
  readonly usage: SnapshotValue
  readonly artifacts: SnapshotValue
  readonly gaps: SnapshotValue
  readonly removals: SnapshotValue
  readonly runs: SnapshotValue
}

const everything = 1_000_000_000

const timeMarker = '<time>'

const StoredRemoval = z.intersection(ObservationRemoval, z.strictObject({ run: RunId.nullable() }))

class Reference {
  readonly id: string

  constructor(id: string) {
    this.id = id
  }
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const marked = (schema: z.ZodType, items: readonly unknown[]): unknown[] =>
  items.map((item) => mapIds(schema, item, (id) => new Reference(id), ''))

const omittedKeys = new Set(['change_seq'])

const recordCounts = (records: readonly RawRecord[]): RecordCount[] => {
  const counts = new Map<string, RecordCount>()
  for (const record of records) {
    const entry = { channel: record.channel, type: recordType(record), parse_state: record.parse_state }
    const key = JSON.stringify(entry)
    counts.set(key, { ...entry, count: (counts.get(key)?.count ?? 0) + 1 })
  }
  return [...counts.values()].sort((left, right) => {
    const [a, b] = [JSON.stringify([left.channel, left.type, left.parse_state]), JSON.stringify([right.channel, right.type, right.parse_state])]
    return a < b ? -1 : a > b ? 1 : 0
  })
}

interface Canonicalizer {
  readonly value: (value: unknown) => SnapshotValue
  readonly sorted: <T>(items: readonly T[], by?: (item: T) => unknown) => T[]
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const createCanonicalizer = (base: string, spoolNames: readonly string[]): Canonicalizer => {
  const labels = new Map<string, string>()
  const spoolLabels = new Map(spoolNames.map((name, index) => [name, `spool#${String(index + 1)}`]))
  const spoolPattern = spoolNames.length === 0 ? null : new RegExp(spoolNames.map(escapeRegExp).join('|'), 'g')
  const basePatterns = [base, base.replaceAll('\\', '\\\\'), base.replaceAll('\\', '/')]
    .filter((variant, index, all) => all.indexOf(variant) === index)
    .map((variant) => new RegExp(`${escapeRegExp(variant)}((?:[\\\\/]+[^\\\\/"\\s]+)*)`, 'g'))

  const stable = (value: string): string => {
    let result = spoolPattern === null ? value : value.replace(spoolPattern, (name) => spoolLabels.get(name) ?? name)
    for (const pattern of basePatterns) {
      result = result.replace(pattern, (_, rest: string) => `<base>${rest.replace(/[\\/]+/g, '/')}`)
    }
    return result
  }

  const label = (id: string): string => {
    const assigned = labels.get(id) ?? `#${String(labels.size + 1)}`
    labels.set(id, assigned)
    return assigned
  }

  const labelOrder = (label: SnapshotValue): number => (typeof label === 'string' ? Number(label.slice(1)) : 0)

  const references = (member: unknown): member is Reference[] =>
    Array.isArray(member) && member.every((item) => item instanceof Reference)

  const value = (input: unknown): SnapshotValue => {
    if (input instanceof Reference) {
      return label(input.id)
    }
    if (typeof input === 'bigint') {
      return timeMarker
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'number') {
      return input
    }
    if (typeof input === 'string') {
      return stable(input)
    }
    if (Array.isArray(input)) {
      const items = input.map(value)
      return references(input) ? items.toSorted((left, right) => labelOrder(left) - labelOrder(right)) : items
    }
    if (typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([key, member]) => !omittedKeys.has(key) && member !== undefined)
          .map(([key, member]) => [key, value(member)]),
      )
    }
    throw new Error(`unexpected snapshot value of type ${typeof input}`)
  }

  const orderText = (item: unknown, reference: (id: string) => string): string =>
    JSON.stringify(item, (_, member: unknown) =>
      references(member)
        ? member.map(({ id }) => reference(id)).toSorted((left, right) => labelOrder(left) - labelOrder(right))
        : member instanceof Reference ? reference(member.id) : typeof member === 'bigint' ? timeMarker : typeof member === 'string' ? stable(member) : member,
    )

  const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

  const sorted = <T>(items: readonly T[], by: (item: T) => unknown = (item) => item): T[] =>
    items
      .map((item) => ({
        item,
        order: orderText(by(item), () => '#'),
        labelled: orderText(by(item), (id) => labels.get(id) ?? '#'),
      }))
      .sort((left, right) => compareText(left.order, right.order) || compareText(left.labelled, right.labelled))
      .map(({ item }) => item)

  return { value, sorted }
}

const spoolNamesOf = (records: readonly RawRecord[]): string[] =>
  records.flatMap((record) => (record.position.kind === 'spool' ? [record.position.file] : []))

const factView = ({ id, kind, entity_key, speaker, urgent, at, runtime_ids, runtime_env, format_verified, redelivery_key, payload }: Fact) => ({
  id,
  kind,
  entity_key,
  speaker,
  urgent,
  at,
  runtime_ids,
  runtime_env,
  format_verified,
  redelivery_key,
  payload,
})

const byKey = (item: unknown): unknown => (isObject(item) ? item.key : undefined)

export const takeSnapshot = (store: Store, base: string): ContractSnapshot => {
  const changes = store.changes.after(ChangeSeq.parse(0), everything)
  const records = changes.flatMap((change) => (change.layer === 'raw_record' ? [change.record] : []))
  const facts = changes.flatMap((change) => (change.layer === 'fact' ? [change.fact] : []))
  const { value, sorted } = createCanonicalizer(base, spoolNamesOf(records))
  const sessions = store.observations.sessions()
  const ofSessions = <T>(read: (session: (typeof sessions)[number]['id']) => T[]): T[] =>
    sessions.flatMap(({ id }) => read(id))
  const runs = store.model.runs()
  return {
    records: recordCounts(records),
    facts: value(marked(Fact, facts.toSorted((left, right) => left.seq - right.seq).map(factView))),
    sessions: value(sorted(marked(Session, sessions), byKey)),
    agents: value(sorted(marked(Agent, ofSessions(store.observations.agents)), byKey)),
    actions: value(sorted(marked(Action, ofSessions(store.observations.actions)), byKey)),
    questions: value(sorted(marked(Question, ofSessions(store.observations.questions)), byKey)),
    usage: value(sorted(marked(UsageRecord, ofSessions(store.observations.usageRecords)), byKey)),
    artifacts: value(
      sorted(
        runs.flatMap(({ id }) => [...marked(ArtifactVersion, store.artifacts.versions(id)), ...marked(GitSnapshot, store.artifacts.snapshots(id))]),
        byKey,
      ),
    ),
    gaps: value(sorted(marked(Gap, changes.flatMap((change) => (change.layer === 'gap' ? [change.gap] : []))), byKey)),
    removals: value(sorted(marked(StoredRemoval, changes.flatMap((change) => (change.layer === 'removal' ? [change.removal] : []))))),
    runs: value(
      sorted(runs.map((run) => ({ run: marked(Run, [run])[0], entities: sorted(marked(ModelEntity, store.model.entities(run.id))) }))),
    ),
  }
}
