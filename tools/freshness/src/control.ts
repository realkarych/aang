import { join } from 'node:path'
import { ChangeSeq, type FactId, type RawRecord, type RawSeq, type RunId } from '@aang/contract'
import type { Store } from '@aang/store'
import { type PlayedStep, type PlayerRoots, type PlayerStep, type RecordShift, shifted, type Target } from '@aang/testkit'
import type { Recording } from './recording.js'

export interface Played {
  readonly recording: Recording
  readonly shift: RecordShift
  readonly startsAt: number
  readonly steps: readonly PlayedStep[]
}

export interface IndexedRecord {
  readonly raw: RawRecord
  readonly facts: ReadonlySet<FactId>
  readonly runs: ReadonlySet<RunId>
}

export interface RecordIndex {
  readonly deliveries: ReadonlyMap<string, readonly IndexedRecord[]>
  readonly lines: ReadonlyMap<string, readonly IndexedRecord[]>
}

export interface ControlRecords {
  readonly observedAt: bigint | null
  readonly sourceAt: bigint | null
  readonly facts: ReadonlySet<FactId>
  readonly runs: readonly RunId[]
}

const pageSize = 1_000

const deliveryKey = (...parts: readonly string[]): string => JSON.stringify(parts)

const recordKey = ({ channel, runtime, hook, position, payload }: RawRecord): string | null =>
  channel === 'hook' && runtime !== null && hook !== null
    ? deliveryKey('hook', runtime, hook.registration, payload)
    : position.kind === 'file'
      ? deliveryKey('file', position.path, payload)
      : null

const pathOf = (roots: PlayerRoots, target: Target): string => join(roots[target.root], ...target.path.split('/'))

const rawRecords = (store: Store): RawRecord[] => {
  const records: RawRecord[] = []
  for (let position = ChangeSeq.parse(0); ; ) {
    const changes = store.changes.after(position, pageSize)
    const last = changes.at(-1)
    if (last === undefined) {
      return records
    }
    records.push(...changes.flatMap((change) => (change.layer === 'raw_record' ? [change.record] : [])))
    position = last.change_seq
  }
}

const byObservation = ({ raw: left }: IndexedRecord, { raw: right }: IndexedRecord): number =>
  left.observed_at === right.observed_at ? left.seq - right.seq : left.observed_at < right.observed_at ? -1 : 1

const add = (groups: Map<string, IndexedRecord[]>, key: string, record: IndexedRecord): void => {
  const group = groups.get(key)
  if (group === undefined) {
    groups.set(key, [record])
  } else {
    group.push(record)
  }
}

export const indexRecords = (store: Store): RecordIndex => {
  const attributed = new Map<RawSeq, { facts: Set<FactId>; runs: Set<RunId> }>()
  for (const run of store.model.runs()) {
    for (const { fact } of store.facts.ofRun(run.id, ChangeSeq.parse(0))) {
      const entry = attributed.get(fact.seq) ?? { facts: new Set(), runs: new Set() }
      entry.facts.add(fact.id)
      entry.runs.add(run.id)
      attributed.set(fact.seq, entry)
    }
  }
  const deliveries = new Map<string, IndexedRecord[]>()
  const lines = new Map<string, IndexedRecord[]>()
  for (const raw of rawRecords(store)) {
    const record: IndexedRecord = { raw, ...(attributed.get(raw.seq) ?? { facts: new Set(), runs: new Set() }) }
    const key = recordKey(raw)
    if (key !== null) {
      add(deliveries, key, record)
    }
    if (raw.position.kind === 'line') {
      add(lines, raw.position.path, record)
    }
  }
  for (const group of deliveries.values()) {
    group.sort(byObservation)
  }
  return { deliveries, lines }
}

export const deliveryKeys = ({ recording, shift }: Played, roots: PlayerRoots): (string | null)[] => {
  const content = (source: string): string =>
    shifted(recording.playback.sources.get(source) ?? Buffer.alloc(0), shift).toString('utf8')
  return recording.playback.steps.map((step: PlayerStep): string | null => {
    switch (step.kind) {
      case 'hook':
        return deliveryKey('hook', step.runtime, step.registration, content(step.source))
      case 'write':
        return deliveryKey('file', pathOf(roots, step.target), content(step.source))
      default:
        return null
    }
  })
}

const minimum = (values: readonly bigint[]): bigint | null =>
  values.reduce<bigint | null>((least, value) => (least === null || value < least ? value : least), null)

const delivered = (
  index: RecordIndex,
  played: Played,
  keys: readonly (string | null)[],
  position: number,
  roots: PlayerRoots,
): IndexedRecord[] => {
  const step = played.recording.playback.steps[position]
  const appended = played.steps[position]?.appended ?? null
  if (step?.kind === 'append' && appended !== null) {
    const end = appended.offset + appended.bytes
    return (index.lines.get(pathOf(roots, step.target)) ?? []).filter(
      ({ raw: { position: line } }) => line.kind === 'line' && line.offset >= appended.offset && line.offset < end,
    )
  }
  const key = keys[position] ?? null
  if (key === null) {
    return []
  }
  const occurrence = keys.slice(0, position).filter((earlier) => earlier === key).length
  const record = index.deliveries.get(key)?.[occurrence]
  return record === undefined ? [] : [record]
}

export const controlRecords = (
  index: RecordIndex,
  played: Played,
  keys: readonly (string | null)[],
  position: number,
  roots: PlayerRoots,
): ControlRecords => {
  const matched = delivered(index, played, keys, position, roots).filter(({ runs }) => runs.size > 0)
  return {
    observedAt: minimum(matched.map(({ raw }) => raw.observed_at)),
    sourceAt: minimum(matched.flatMap(({ raw }) => (raw.source_ts === null ? [] : [raw.source_ts]))),
    facts: new Set(matched.flatMap(({ facts }) => [...facts])),
    runs: [...new Set(matched.flatMap(({ runs }) => [...runs]))],
  }
}
