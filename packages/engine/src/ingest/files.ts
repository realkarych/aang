import type { CollectedGap, CollectedRecord, FileCursor, RecordOwner, SessionKey, StreamKey } from '@aang/contract'
import { type Adapters, type Owned, ownedRecord } from './records.js'

export interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

export interface HeldFile {
  readonly kind: 'held'
  readonly path: string
  readonly cursor: FileCursor
  readonly stream: StreamKey | null
  readonly session: SessionKey | null
  readonly lines: readonly Owned[]
  readonly bytes: number
  readonly full: boolean
  readonly since: number
  readonly gaps: readonly CollectedGap[]
}

export interface CommittedFile {
  readonly kind: 'committed'
  readonly path: string
  readonly identity: FileIdentity
  readonly stream: StreamKey | null
}

export interface LaggingFile {
  readonly kind: 'lagging'
  readonly path: string
  readonly identity: FileIdentity
  readonly stream: StreamKey
}

export type TrackedFile = HeldFile | CommittedFile | LaggingFile

export type FileStep =
  | {
      readonly kind: 'append'
      readonly file: CommittedFile
      readonly stream: StreamKey
      readonly cursor: FileCursor
      readonly lines: readonly CollectedRecord[]
    }
  | {
      readonly kind: 'nameless'
      readonly path: string
      readonly cursor: FileCursor
      readonly lines: readonly CollectedRecord[]
      readonly first: CollectedRecord | null
      readonly gaps: readonly CollectedGap[]
    }
  | { readonly kind: 'lagging'; readonly skipped: number }
  | {
      readonly kind: 'held'
      readonly file: HeldFile
      readonly sightings: readonly RecordOwner[]
      readonly skipped: number
    }

const streamProbeLines = 16

const identityOf = (file: TrackedFile): FileIdentity => (file.kind === 'held' ? file.cursor : file.identity)

const sameFile = (left: FileIdentity, right: FileIdentity): boolean => left.dev === right.dev && left.ino === right.ino

const progressed = (file: TrackedFile): boolean => file.kind !== 'held' || file.cursor.offset > 0

const readsFromStart = (arrived: readonly CollectedRecord[]): boolean => {
  const position = arrived[0]?.position
  return position?.kind === 'line' && position.offset === 0
}

const continuing = (
  prior: TrackedFile | undefined,
  cursor: FileCursor,
  arrived: readonly CollectedRecord[],
): TrackedFile | null =>
  prior !== undefined && sameFile(identityOf(prior), cursor) && !(readsFromStart(arrived) && progressed(prior))
    ? prior
    : null

const freshFile = (path: string, cursor: FileCursor, since: number, gaps: readonly CollectedGap[]): HeldFile => ({
  kind: 'held',
  path,
  cursor,
  stream: cursor.stream,
  session: null,
  lines: [],
  bytes: 0,
  full: false,
  since,
  gaps,
})

type Probe =
  | { readonly kind: 'named'; readonly stream: StreamKey }
  | { readonly kind: 'unnamed' }
  | { readonly kind: 'nameless'; readonly first: CollectedRecord }

const probeStream = (adapters: Adapters, lines: readonly Owned[]): Probe => {
  const [first] = lines
  if (first === undefined) {
    return { kind: 'unnamed' }
  }
  const probe = lines.slice(0, streamProbeLines).map(({ record }) => record.payload)
  const stream = adapters[first.record.runtime].streamKey(probe)
  if (stream !== null) {
    return { kind: 'named', stream }
  }
  return lines.length >= streamProbeLines ? { kind: 'nameless', first: first.record } : { kind: 'unnamed' }
}

interface Naming {
  readonly lines: readonly Owned[]
  readonly session: SessionKey | null
  readonly sightings: readonly RecordOwner[]
}

const nameLines = (adapters: Adapters, file: HeldFile, stream: StreamKey, lines: readonly Owned[]): Naming => {
  const named = lines.map((line) => ownedRecord(adapters, { ...line.record, stream }))
  const sightings = named.flatMap(({ owner }) => (owner === null ? [] : [owner]))
  return { lines: named, session: file.session ?? sightings[0]?.session ?? null, sightings }
}

const unowned = (record: CollectedRecord): Owned => ({ record, owner: null, bytes: Buffer.byteLength(record.payload) })

const totalBytes = (lines: readonly Owned[]): number => lines.reduce((total, line) => total + line.bytes, 0)

const advanceHeld = (
  adapters: Adapters,
  held: HeldFile,
  cursor: FileCursor,
  arrived: readonly CollectedRecord[],
): FileStep => {
  if (held.full) {
    return { kind: 'held', file: { ...held, cursor }, sightings: [], skipped: arrived.length }
  }
  const added = arrived.map(unowned)
  const bytes = held.bytes + totalBytes(added)
  if (held.stream !== null) {
    const { sightings, ...named } = nameLines(adapters, held, held.stream, added)
    const file = { ...held, ...named, cursor, bytes, lines: [...held.lines, ...named.lines] }
    return { kind: 'held', file, sightings, skipped: 0 }
  }
  const lines = [...held.lines, ...added]
  const probe = probeStream(adapters, lines)
  switch (probe.kind) {
    case 'nameless':
      return {
        kind: 'nameless',
        path: held.path,
        cursor,
        lines: lines.map(({ record }) => record),
        first: probe.first,
        gaps: held.gaps,
      }
    case 'unnamed':
      return { kind: 'held', file: { ...held, cursor, lines, bytes }, sightings: [], skipped: 0 }
    case 'named': {
      const { sightings, ...named } = nameLines(adapters, held, probe.stream, lines)
      return { kind: 'held', file: { ...held, ...named, cursor, bytes, stream: probe.stream }, sightings, skipped: 0 }
    }
  }
}

export const advanceFile = (
  adapters: Adapters,
  prior: TrackedFile | undefined,
  cursor: FileCursor,
  arrived: readonly CollectedRecord[],
  now: number,
): FileStep => {
  const base =
    continuing(prior, cursor, arrived) ?? freshFile(cursor.path, cursor, now, prior?.kind === 'held' ? prior.gaps : [])
  switch (base.kind) {
    case 'committed':
      return base.stream === null
        ? { kind: 'nameless', path: base.path, cursor, lines: arrived, first: null, gaps: [] }
        : {
            kind: 'append',
            file: base,
            stream: base.stream,
            cursor,
            lines: arrived.map((record) => ({ ...record, stream: base.stream })),
          }
    case 'lagging':
      return { kind: 'lagging', skipped: arrived.length }
    case 'held':
      return advanceHeld(adapters, base, cursor, arrived)
  }
}

export const trackedFiles = (cursors: readonly FileCursor[]): Map<string, TrackedFile> =>
  new Map(
    cursors.map(({ path, dev, ino, stream }) => [path, { kind: 'committed', path, identity: { dev, ino }, stream }]),
  )

export const committedFile = (cursor: FileCursor, stream: StreamKey | null): CommittedFile => ({
  kind: 'committed',
  path: cursor.path,
  identity: { dev: cursor.dev, ino: cursor.ino },
  stream,
})

export const laggingFile = (cursor: FileCursor, stream: StreamKey): LaggingFile => ({
  kind: 'lagging',
  path: cursor.path,
  identity: { dev: cursor.dev, ino: cursor.ino },
  stream,
})

export const trimmed = (file: HeldFile, budget: number): { readonly file: HeldFile; readonly dropped: number } => {
  if (file.bytes <= budget) {
    return { file, dropped: 0 }
  }
  let bytes = 0
  let kept = 0
  for (const line of file.lines) {
    if (bytes + line.bytes > budget) {
      break
    }
    bytes += line.bytes
    kept += 1
  }
  return { file: { ...file, lines: file.lines.slice(0, kept), bytes, full: true }, dropped: file.lines.length - kept }
}
