import { ChangeSeq, type Fact, type RawRecord } from '@aang/contract'
import type { Store } from '@aang/store'

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

const derivedId = /^[0-9a-f]{32}$/

const timeMarker = '<time>'

const omittedKeys = new Set(['change_seq'])

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const recordType = (record: RawRecord): string => {
  let payload: unknown
  try {
    payload = JSON.parse(record.payload)
  } catch {
    return '-'
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return '-'
  }
  const fields = payload as Readonly<Record<string, unknown>>
  const nested = fields.payload
  const detail =
    textOf(fields.subtype) ??
    (typeof nested === 'object' && nested !== null && !Array.isArray(nested) ? textOf((nested as Readonly<Record<string, unknown>>).type) : null)
  const name = textOf(fields.hook_event_name) ?? textOf(fields.type) ?? '-'
  return detail === null ? name : `${name}:${detail}`
}

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

  const text = (value: string): string => {
    if (derivedId.test(value)) {
      const label = labels.get(value) ?? `#${String(labels.size + 1)}`
      labels.set(value, label)
      return label
    }
    return stable(value)
  }

  const labelOrder = (label: SnapshotValue): number => (typeof label === 'string' ? Number(label.slice(1)) : 0)

  const value = (input: unknown): SnapshotValue => {
    if (typeof input === 'bigint') {
      return timeMarker
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'number') {
      return input
    }
    if (typeof input === 'string') {
      return text(input)
    }
    if (Array.isArray(input)) {
      const items = input.map(value)
      const ids = input.every((item) => typeof item === 'string' && derivedId.test(item))
      return ids ? items.toSorted((left, right) => labelOrder(left) - labelOrder(right)) : items
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

  const orderText = (item: unknown): string =>
    JSON.stringify(item, (_, member: unknown) =>
      typeof member === 'bigint' ? timeMarker : typeof member === 'string' ? (derivedId.test(member) ? '#' : stable(member)) : member,
    )

  const sorted = <T>(items: readonly T[], by: (item: T) => unknown = (item) => item): T[] =>
    items
      .map((item) => ({ item, order: orderText(by(item)) }))
      .sort((left, right) => (left.order < right.order ? -1 : left.order > right.order ? 1 : 0))
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

const byKey = ({ key }: { readonly key: unknown }): unknown => key

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
    facts: value(facts.toSorted((left, right) => left.seq - right.seq).map(factView)),
    sessions: value(sorted(sessions, byKey)),
    agents: value(sorted(ofSessions(store.observations.agents), byKey)),
    actions: value(sorted(ofSessions(store.observations.actions), byKey)),
    questions: value(sorted(ofSessions(store.observations.questions), byKey)),
    usage: value(sorted(ofSessions(store.observations.usageRecords), byKey)),
    artifacts: value(sorted(runs.flatMap(({ id }) => [...store.artifacts.versions(id), ...store.artifacts.snapshots(id)]), byKey)),
    gaps: value(sorted(changes.flatMap((change) => (change.layer === 'gap' ? [change.gap] : [])), byKey)),
    removals: value(sorted(changes.flatMap((change) => (change.layer === 'removal' ? [change.removal] : [])))),
    runs: value(sorted(runs).map((run) => ({ run, entities: sorted(store.model.entities(run.id)) }))),
  }
}
