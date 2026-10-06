import { join } from 'node:path'
import { ChangeSeq, type FactId, type RawRecord, type RawSeq, type RunId } from '@aang/contract'
import type { Store } from '@aang/store'
import { type PlayedStep, type PlayerRoots, playbackShift, shifted, type Target } from '@aang/testkit'
import type { ControlStep, Recording } from './recording.js'

export type Delivery =
  | { readonly kind: 'hook'; readonly payload: string }
  | { readonly kind: 'lines'; readonly path: string; readonly lines: ReadonlySet<string> }
  | { readonly kind: 'file'; readonly path: string; readonly payload: string }

export interface IndexedRecord {
  readonly raw: RawRecord
  readonly facts: ReadonlySet<FactId>
  readonly runs: ReadonlySet<RunId>
}

export interface ControlRecords {
  readonly observedAt: bigint | null
  readonly sourceAt: bigint | null
  readonly facts: ReadonlySet<FactId>
  readonly runs: readonly RunId[]
}

const nanosecondsPerMillisecond = 1_000_000n
const clockToleranceMs = 100

const completeLines = (chunk: string): Set<string> =>
  new Set(
    chunk
      .split('\n')
      .slice(0, -1)
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line !== ''),
  )

export const deliveryOf = (recording: Recording, step: ControlStep, roots: PlayerRoots, startsAt: number): Delivery => {
  const { sources } = recording.playback
  const content = shifted(sources.get(step.source) ?? Buffer.alloc(0), playbackShift(sources.values(), startsAt)).toString('utf8')
  const pathOf = (target: Target): string => join(roots[target.root], ...target.path.split('/'))
  switch (step.kind) {
    case 'hook':
      return { kind: 'hook', payload: content }
    case 'write':
      return { kind: 'file', path: pathOf(step.target), payload: content }
    case 'append':
      return { kind: 'lines', path: pathOf(step.target), lines: completeLines(content) }
  }
}

export const indexRecords = (store: Store): IndexedRecord[] => {
  const records = new Map<RawSeq, { raw: RawRecord | null; facts: Set<FactId>; runs: Set<RunId> }>()
  for (const run of store.model.runs()) {
    for (const { fact } of store.facts.ofRun(run.id, ChangeSeq.parse(0))) {
      const entry = records.get(fact.seq) ?? { raw: store.rawRecords.get(fact.seq), facts: new Set(), runs: new Set() }
      entry.facts.add(fact.id)
      entry.runs.add(run.id)
      records.set(fact.seq, entry)
    }
  }
  return [...records.values()].flatMap(({ raw, facts, runs }) => (raw === null ? [] : [{ raw, facts, runs }]))
}

const carries = (delivery: Delivery, { channel, position, payload }: RawRecord): boolean => {
  switch (delivery.kind) {
    case 'hook':
      return channel === 'hook' && payload === delivery.payload
    case 'file':
      return position.kind === 'file' && position.path === delivery.path && payload === delivery.payload
    case 'lines':
      return position.kind === 'line' && position.path === delivery.path && delivery.lines.has(payload)
  }
}

const earliest = (records: readonly IndexedRecord[]): IndexedRecord[] =>
  [...Map.groupBy(records, ({ raw }) => raw.payload).values()].map((group) =>
    group.reduce((first, record) => (record.raw.observed_at < first.raw.observed_at ? record : first)),
  )

const minimum = (values: readonly bigint[]): bigint | null =>
  values.reduce<bigint | null>((least, value) => (least === null || value < least ? value : least), null)

export const controlRecords = (
  index: readonly IndexedRecord[],
  delivery: Delivery,
  previous: PlayedStep | undefined,
  startsAt: number,
): ControlRecords => {
  const bound = BigInt((previous?.playedAt ?? startsAt) - clockToleranceMs) * nanosecondsPerMillisecond
  const matched = earliest(index.filter(({ raw }) => raw.observed_at >= bound && carries(delivery, raw)))
  return {
    observedAt: minimum(matched.map(({ raw }) => raw.observed_at)),
    sourceAt: minimum(matched.flatMap(({ raw }) => (raw.source_ts === null ? [] : [raw.source_ts]))),
    facts: new Set(matched.flatMap(({ facts }) => [...facts])),
    runs: [...new Set(matched.flatMap(({ runs }) => [...runs]))],
  }
}
