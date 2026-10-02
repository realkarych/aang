import type { CollectedRecord, FileCursor, StreamKey } from '@aang/contract'
import type { Adapters } from './parse.js'

export interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

export interface KnownFile extends FileIdentity {
  readonly stream: StreamKey | null
}

export interface WaitingFile {
  readonly cursor: FileCursor
  readonly stream: StreamKey | null
  readonly records: readonly CollectedRecord[]
}

export interface FileState {
  readonly known: ReadonlyMap<string, KnownFile>
  readonly waiting: ReadonlyMap<string, WaitingFile>
}

export type Naming =
  | { readonly kind: 'named'; readonly stream: StreamKey }
  | { readonly kind: 'unnamed' }
  | { readonly kind: 'nameless'; readonly first: CollectedRecord | null }

export interface FileWork {
  readonly path: string
  readonly cursor: FileCursor
  readonly records: readonly CollectedRecord[]
  readonly naming: Naming
}

const streamProbeLines = 16

const sameFile = (left: FileIdentity, right: FileIdentity): boolean => left.dev === right.dev && left.ino === right.ino

const named = (stream: StreamKey): Naming => ({ kind: 'named', stream })

const nameFromLines = (adapters: Adapters, records: readonly CollectedRecord[]): Naming => {
  const [first] = records
  if (first === undefined) {
    return { kind: 'unnamed' }
  }
  const stream = adapters[first.runtime].streamKey(records.slice(0, streamProbeLines).map(({ payload }) => payload))
  if (stream !== null) {
    return named(stream)
  }
  return records.length >= streamProbeLines ? { kind: 'nameless', first } : { kind: 'unnamed' }
}

export const knownFiles = (cursors: readonly FileCursor[]): Map<string, KnownFile> =>
  new Map(cursors.map(({ path, dev, ino, stream }) => [path, { dev, ino, stream }]))

export const fileWork = (
  adapters: Adapters,
  state: FileState,
  cursor: FileCursor,
  arrived: readonly CollectedRecord[],
): FileWork => {
  const { path } = cursor
  const waiting = state.waiting.get(path)
  const previous = waiting !== undefined && sameFile(waiting.cursor, cursor) ? waiting : undefined
  const known = state.known.get(path)
  const committed = known !== undefined && sameFile(known, cursor) ? known : undefined
  const records = [...(previous?.records ?? []), ...arrived]
  const naming = (): Naming => {
    if (cursor.stream !== null) {
      return named(cursor.stream)
    }
    if (previous !== undefined) {
      return previous.stream === null ? nameFromLines(adapters, records) : named(previous.stream)
    }
    if (committed !== undefined) {
      return committed.stream === null ? { kind: 'nameless', first: null } : named(committed.stream)
    }
    return nameFromLines(adapters, records)
  }
  return { path, cursor, records, naming: naming() }
}
