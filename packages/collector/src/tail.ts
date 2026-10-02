import type { BigIntStats } from 'node:fs'
import { open as openFile, stat } from 'node:fs/promises'
import type { CollectedGap, CollectedRecord, CollectorBatch, FileCursor, Runtime } from '@aang/contract'
import { absent, isMissing } from './errors.js'
import type { Failure, Retrier } from './retry.js'
import { epochNs } from './time.js'
import type { TreeRoot } from './tree.js'
import type { Wakeup } from './wakeup.js'

export interface TailRoot {
  readonly root: TreeRoot
  readonly runtime: Runtime
  readonly channel: 'transcript' | 'rollout'
}

export interface TailOptions {
  readonly roots: readonly TailRoot[]
  readonly retrier: Retrier
}

export interface TailSource {
  readonly open: (cursors: readonly FileCursor[]) => void
  readonly changed: (root: TreeRoot, path: string) => void
  readonly listed: (root: TreeRoot, paths: readonly string[]) => Promise<void>
  readonly take: () => Promise<CollectorBatch | null>
  readonly close: () => void
}

interface TrackedFile {
  readonly path: string
  readonly root: TailRoot
  cursor: FileCursor | null
  failure: Failure | null
}

interface ReadOutcome {
  readonly records: readonly CollectedRecord[]
  readonly cursor: FileCursor | null
  readonly gaps: readonly CollectedGap[]
  readonly bytes: number
  readonly more: boolean
}

interface Chunk {
  readonly bytes: Buffer
  readonly available: number
}

const fileExtension = '.jsonl'
const lineFeed = 0x0a
const carriageReturn = 0x0d
const readChunkBytes = 1024 ** 2
const maxBytesPerBatch = 8 * 1024 ** 2
const maxRecordsPerBatch = 4096

const nothing: ReadOutcome = { records: [], cursor: null, gaps: [], bytes: 0, more: false }

const freshCursor = (path: string, stats: BigIntStats): FileCursor => ({
  path,
  dev: stats.dev,
  ino: stats.ino,
  stream: null,
  offset: 0,
  line: 0,
  size: 0,
  last_ordinal: null,
})

const sameFile = (cursor: FileCursor, stats: BigIntStats): boolean => cursor.dev === stats.dev && cursor.ino === stats.ino

const continuation = (file: TrackedFile, stats: BigIntStats): FileCursor =>
  file.cursor !== null && sameFile(file.cursor, stats) && stats.size >= BigInt(file.cursor.offset)
    ? file.cursor
    : freshCursor(file.path, stats)

const hasNewData = (cursor: FileCursor | null, stats: BigIntStats): boolean =>
  cursor === null || !sameFile(cursor, stats) || stats.size !== BigInt(cursor.size)

const rolloutOrdinal = (payload: string): number | null => {
  try {
    const value: unknown = JSON.parse(payload)
    if (typeof value === 'object' && value !== null && 'ordinal' in value) {
      const { ordinal } = value
      return typeof ordinal === 'number' && Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : null
    }
    return null
  } catch {
    return null
  }
}

const readChunk = async (path: string, offset: number, size: number): Promise<Chunk> => {
  const handle = await openFile(path, 'r')
  try {
    const available = size - offset
    let length = Math.min(available, readChunkBytes)
    for (;;) {
      const bytes = Buffer.alloc(length)
      const { bytesRead } = await handle.read(bytes, 0, length, offset)
      const chunk = bytes.subarray(0, bytesRead)
      if (bytesRead < length || length === available || chunk.includes(lineFeed)) {
        return { bytes: chunk, available }
      }
      length = Math.min(available, length * 2)
    }
  } finally {
    await handle.close()
  }
}

export const createTailSource = (options: TailOptions, wakeup: Wakeup): TailSource => {
  const sources = new Map(options.roots.map((source) => [source.root, source]))
  const files = new Map<string, TrackedFile>()
  const known = new Map<string, FileCursor>()
  const dirty = new Map<string, TrackedFile>()

  const track = (root: TailRoot, path: string): TrackedFile => {
    const existing = files.get(path)
    if (existing !== undefined) {
      return existing
    }
    const file: TrackedFile = { path, root, cursor: known.get(path) ?? null, failure: null }
    files.set(path, file)
    return file
  }

  const changed = (root: TreeRoot, path: string): void => {
    const source = sources.get(root)
    if (source === undefined || !path.endsWith(fileExtension)) {
      return
    }
    dirty.set(path, track(source, path))
    wakeup.notify()
  }

  const listed = async (root: TreeRoot, paths: readonly string[]): Promise<void> => {
    const source = sources.get(root)
    if (source === undefined) {
      return
    }
    for (const path of paths.filter((candidate) => candidate.endsWith(fileExtension))) {
      const file = track(source, path)
      const stats = await stat(path, { bigint: true }).catch(absent)
      if (stats !== null && hasNewData(file.cursor, stats)) {
        dirty.set(path, file)
      }
    }
  }

  const failed = (file: TrackedFile, error: unknown): ReadOutcome => ({
    ...nothing,
    gaps: options.retrier.failed(file, file.cursor?.stream ?? null, error, () => {
      dirty.set(file.path, file)
      wakeup.notify()
    }),
  })

  const read = async (file: TrackedFile, budget: number): Promise<ReadOutcome> => {
    let stats: BigIntStats
    let start: FileCursor
    let chunk: Chunk
    try {
      stats = await stat(file.path, { bigint: true })
      if (!stats.isFile()) {
        return nothing
      }
      start = continuation(file, stats)
      chunk = await readChunk(file.path, start.offset, Number(stats.size))
    } catch (error) {
      return isMissing(error) ? nothing : failed(file, error)
    }
    const gaps = options.retrier.recovered(file)
    const records: CollectedRecord[] = []
    const observedAt = epochNs(stats.mtimeNs)
    let lineStart = 0
    let line = start.line
    let lastOrdinal = start.last_ordinal
    for (
      let lineEnd = chunk.bytes.indexOf(lineFeed);
      lineEnd >= 0 && records.length < budget;
      lineEnd = chunk.bytes.indexOf(lineFeed, lineStart)
    ) {
      const contentEnd = lineEnd > lineStart && chunk.bytes[lineEnd - 1] === carriageReturn ? lineEnd - 1 : lineEnd
      line += 1
      if (contentEnd > lineStart) {
        const payload = chunk.bytes.toString('utf8', lineStart, contentEnd)
        if (file.root.channel === 'rollout') {
          lastOrdinal = rolloutOrdinal(payload) ?? lastOrdinal
        }
        records.push({
          channel: file.root.channel,
          runtime: file.root.runtime,
          stream: start.stream,
          position: { kind: 'line', path: file.path, offset: start.offset + lineStart, line },
          hook: null,
          observed_at: observedAt,
          payload,
        })
      }
      lineStart = lineEnd + 1
    }
    const examined = records.length < budget ? chunk.bytes.length : lineStart
    const cursor: FileCursor = {
      ...start,
      offset: start.offset + lineStart,
      line,
      size: start.offset + examined,
      last_ordinal: lastOrdinal,
    }
    file.cursor = cursor
    return {
      records,
      cursor: lineStart > 0 ? cursor : null,
      gaps,
      bytes: lineStart,
      more: examined < chunk.available,
    }
  }

  const take = async (): Promise<CollectorBatch | null> => {
    const records: CollectedRecord[] = []
    const cursors: FileCursor[] = []
    const gaps: CollectedGap[] = []
    let bytes = 0
    for (const [path, file] of [...dirty]) {
      if (bytes >= maxBytesPerBatch || records.length >= maxRecordsPerBatch) {
        break
      }
      dirty.delete(path)
      const outcome = await read(file, maxRecordsPerBatch - records.length)
      records.push(...outcome.records)
      gaps.push(...outcome.gaps)
      if (outcome.cursor !== null) {
        cursors.push(outcome.cursor)
      }
      bytes += outcome.bytes
      if (outcome.more) {
        dirty.set(path, file)
      }
    }
    if (records.length === 0 && cursors.length === 0 && gaps.length === 0) {
      return null
    }
    return { records, cursors, gaps }
  }

  const open = (cursors: readonly FileCursor[]): void => {
    for (const cursor of cursors) {
      known.set(cursor.path, cursor)
    }
  }

  const close = (): void => {
    for (const file of files.values()) {
      clearTimeout(file.failure?.timer)
    }
  }

  return { open, changed, listed, take, close }
}
