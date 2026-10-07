import { join } from 'node:path'
import { ChangeSeq, type FactId, type RawRecord, type RawSeq, type RunId } from '@aang/contract'
import type { Store } from '@aang/store'
import { type PlayedStep, type PlayerRoots, type RecordShift, shifted, type Target } from '@aang/testkit'
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

export type StepRecords = ReadonlyMap<Played, ReadonlyMap<number, readonly IndexedRecord[]>>

export interface ControlRecords {
  readonly observedAt: bigint | null
  readonly sourceAt: bigint | null
  readonly facts: ReadonlySet<FactId>
  readonly runs: readonly RunId[]
}

interface Slot {
  readonly playback: Played
  readonly position: number
  readonly key: string
  readonly from: bigint
  readonly until: bigint
}

interface Chunk {
  readonly position: number
  readonly path: string
  readonly openLine: number | null
  readonly offset: number
  readonly lastLineEnd: number | null
}

interface FileState {
  readonly end: number
  readonly lineStart: number | null
}

const pageSize = 1_000
const nanosecondsPerMillisecond = 1_000_000n
const clockLagNs = 50n * nanosecondsPerMillisecond
const lineFeed = 0x0a

const deliveryKey = (...parts: readonly string[]): string => JSON.stringify(parts)

const recordKey = ({ channel, runtime, hook, position, payload }: RawRecord): string | null =>
  channel === 'hook' && runtime !== null && hook !== null
    ? deliveryKey('hook', runtime, hook.registration, payload)
    : position.kind === 'file'
      ? deliveryKey('file', position.path, payload)
      : null

const pathOf = (roots: PlayerRoots, target: Target): string => join(roots[target.root], ...target.path.split('/'))

const nanoseconds = (ms: number): bigint => BigInt(ms) * nanosecondsPerMillisecond

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

const add = <K, V>(groups: Map<K, V[]>, key: K, value: V): void => {
  const group = groups.get(key)
  if (group === undefined) {
    groups.set(key, [value])
  } else {
    group.push(value)
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
  return { deliveries, lines }
}

const replay = (playback: Played, roots: PlayerRoots): { slots: Slot[]; chunks: Chunk[] } => {
  const { recording, shift, startsAt, steps: played } = playback
  const contents = new Map<string, Buffer>()
  const content = (source: string): Buffer => {
    const loaded = contents.get(source) ?? shifted(recording.playback.sources.get(source) ?? Buffer.alloc(0), shift)
    contents.set(source, loaded)
    return loaded
  }
  const consumed = new Map<string, number>()
  const files = new Map<string, FileState>()
  const slots: Slot[] = []
  const chunks: Chunk[] = []
  recording.playback.steps.forEach((step, position) => {
    const done = played[position]
    if (done === undefined) {
      return
    }
    const slot = (key: string): Slot => ({
      playback,
      position,
      key,
      from: nanoseconds(played[position - 1]?.playedAt ?? startsAt) - clockLagNs,
      until: nanoseconds(done.playedAt + 1),
    })
    switch (step.kind) {
      case 'hook':
        slots.push(slot(deliveryKey('hook', step.runtime, step.registration, content(step.source).toString('utf8'))))
        return
      case 'write': {
        const path = pathOf(roots, step.target)
        const written = content(step.source)
        files.set(path, { end: written.length, lineStart: written.lastIndexOf(lineFeed) + 1 })
        slots.push(slot(deliveryKey('file', path, written.toString('utf8'))))
        return
      }
      case 'append': {
        if (done.appended === null) {
          return
        }
        const { offset, bytes } = done.appended
        const start = consumed.get(step.source) ?? 0
        consumed.set(step.source, start + bytes)
        const appended = content(step.source).subarray(start, start + bytes)
        const path = pathOf(roots, step.target)
        const before = files.get(path)
        const openLine = before?.end === offset ? before.lineStart : offset === 0 ? 0 : null
        const lastLineFeed = appended.lastIndexOf(lineFeed)
        files.set(path, { end: offset + appended.length, lineStart: lastLineFeed < 0 ? openLine : offset + lastLineFeed + 1 })
        chunks.push({ position, path, openLine, offset, lastLineEnd: lastLineFeed < 0 ? null : offset + lastLineFeed })
        return
      }
      case 'move': {
        const from = pathOf(roots, step.target)
        const moved = files.get(from)
        files.delete(from)
        if (moved !== undefined) {
          files.set(pathOf(roots, step.to), moved)
        }
        return
      }
      case 'archive':
      case 'remove':
        files.delete(pathOf(roots, step.target))
        return
      case 'otlp':
        return
    }
  })
  return { slots, chunks }
}

const assign = (index: RecordIndex, slots: readonly Slot[]): Map<Slot, IndexedRecord[]> => {
  const byKey = new Map<string, Slot[]>()
  for (const slot of slots) {
    add(byKey, slot.key, slot)
  }
  const taken = new Map<Slot, IndexedRecord[]>()
  for (const [key, keyed] of byKey) {
    for (const record of index.deliveries.get(key) ?? []) {
      const at = record.raw.observed_at
      const containing = keyed.filter(({ from, until }) => at >= from && at < until)
      const [first] = containing
      if (first !== undefined && containing.every(({ playback }) => playback === first.playback)) {
        add(taken, first, record)
      }
    }
  }
  return taken
}

const completedLines = (index: RecordIndex, { path, openLine, offset, lastLineEnd }: Chunk): IndexedRecord[] =>
  lastLineEnd === null
    ? []
    : (index.lines.get(path) ?? []).filter(
        ({ raw: { position: line } }) =>
          line.kind === 'line' && (line.offset === openLine || (line.offset >= offset && line.offset <= lastLineEnd)),
      )

export const stepRecords = (index: RecordIndex, played: readonly Played[], roots: PlayerRoots): StepRecords => {
  const replayed = played.map((playback) => ({ playback, ...replay(playback, roots) }))
  const taken = assign(index, replayed.flatMap(({ slots }) => slots))
  return new Map(
    replayed.map(({ playback, slots, chunks }) => [
      playback,
      new Map([
        ...slots.map((slot): [number, readonly IndexedRecord[]] => {
          const records = taken.get(slot) ?? []
          return [slot.position, records.length === 1 ? records : []]
        }),
        ...chunks.map((chunk): [number, readonly IndexedRecord[]] => [chunk.position, completedLines(index, chunk)]),
      ]),
    ]),
  )
}

const minimum = (values: readonly bigint[]): bigint | null =>
  values.reduce<bigint | null>((least, value) => (least === null || value < least ? value : least), null)

export const controlRecords = (delivered: readonly IndexedRecord[]): ControlRecords => {
  const matched = delivered.filter(({ runs }) => runs.size > 0)
  return {
    observedAt: minimum(matched.map(({ raw }) => raw.observed_at)),
    sourceAt: minimum(matched.flatMap(({ raw }) => (raw.source_ts === null ? [] : [raw.source_ts]))),
    facts: new Set(matched.flatMap(({ facts }) => [...facts])),
    runs: [...new Set(matched.flatMap(({ runs }) => [...runs]))],
  }
}
