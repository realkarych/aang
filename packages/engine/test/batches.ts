import {
  CollectedRecord,
  type CollectorBatch,
  EpochNs,
  type FileCursor,
  type RegistrationTag,
  type Runtime,
  type SpoolEnv,
  type StreamKey,
} from '@aang/contract'
import { contentHash } from '@aang/contract/ids'

const arrivedAt = 1_790_856_592_228_739_000n

const instant = (offset: number): EpochNs => EpochNs.parse(arrivedAt + BigInt(offset))

export const batchOf = (parts: Partial<CollectorBatch>): CollectorBatch => ({
  records: parts.records ?? [],
  cursors: parts.cursors ?? [],
  gaps: parts.gaps ?? [],
})

export const joinBatches = (...batches: readonly CollectorBatch[]): CollectorBatch => ({
  records: batches.flatMap((batch) => batch.records),
  cursors: batches.flatMap((batch) => batch.cursors),
  gaps: batches.flatMap((batch) => batch.gaps),
})

export interface JsonlFile {
  readonly path: string
  readonly lines: readonly string[]
  readonly batch: (from: number, to: number, stream?: StreamKey | null) => CollectorBatch
  readonly cursor: (to: number, stream?: StreamKey | null) => FileCursor
}

export interface JsonlFileOptions {
  readonly runtime: Runtime
  readonly path: string
  readonly lines: readonly string[]
  readonly ino: bigint
}

const ordinalOf = (line: string): number | null => {
  const value: unknown = JSON.parse(line)
  return typeof value === 'object' && value !== null && 'ordinal' in value && typeof value.ordinal === 'number'
    ? value.ordinal
    : null
}

export const jsonlFile = ({ runtime, path, lines, ino }: JsonlFileOptions): JsonlFile => {
  const offsets = lines.reduce<number[]>(
    (ends, line) => [...ends, (ends.at(-1) ?? 0) + Buffer.byteLength(line) + 1],
    [0],
  )
  const offsetAfter = (line: number): number => offsets[line] ?? 0
  const cursor = (to: number, stream: StreamKey | null = null): FileCursor => ({
    path,
    dev: 1n,
    ino,
    stream,
    offset: offsetAfter(to),
    line: to,
    size: offsetAfter(to),
    last_ordinal: runtime === 'codex' && to > 0 ? ordinalOf(lines[to - 1] ?? '{}') : null,
  })
  const record = (line: number, stream: StreamKey | null): CollectedRecord =>
    CollectedRecord.parse({
      channel: runtime === 'claude' ? 'transcript' : 'rollout',
      runtime,
      stream,
      position: { kind: 'line', path, offset: offsetAfter(line - 1), line },
      hook: null,
      observed_at: instant(line),
      payload: lines[line - 1],
    })
  return {
    path,
    lines,
    cursor,
    batch: (from, to, stream = null) =>
      batchOf({
        records: Array.from({ length: to - from + 1 }, (_, index) => record(from + index, stream)),
        cursors: [cursor(to, stream)],
      }),
  }
}

export interface HookDelivery {
  readonly file: string
  readonly payload: string
  readonly runtime?: Runtime
  readonly registration?: RegistrationTag
  readonly env?: SpoolEnv
  readonly arrival?: number
}

export const hookRecord = ({
  file,
  payload,
  runtime = 'claude',
  registration = 'plugin',
  env = {},
  arrival = 0,
}: HookDelivery): CollectedRecord =>
  CollectedRecord.parse({
    channel: 'hook',
    runtime,
    stream: null,
    position: { kind: 'spool', file },
    hook: { registration, env },
    observed_at: instant(arrival),
    payload,
  })

export const hookBatch = (...deliveries: readonly HookDelivery[]): CollectorBatch =>
  batchOf({ records: deliveries.map(hookRecord) })

export interface SnapshotDelivery {
  readonly path: string
  readonly content: unknown
  readonly arrival?: number
}

export const snapshotBatch = (...snapshots: readonly SnapshotDelivery[]): CollectorBatch =>
  batchOf({
    records: snapshots.map(({ path, content, arrival = 0 }) => {
      const payload = JSON.stringify(content)
      return CollectedRecord.parse({
        channel: 'transcript',
        runtime: 'claude',
        stream: null,
        position: { kind: 'file', path, content_hash: contentHash(payload) },
        hook: null,
        observed_at: instant(arrival),
        payload,
      })
    }),
  })
