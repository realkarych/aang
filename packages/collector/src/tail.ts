import type { BigIntStats } from 'node:fs'
import { open as openFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CollectedGap, CollectedRecord, CollectorBatch, EpochNs, FileCursor, Runtime } from '@aang/contract'
import { absent, describeError, isMissing } from './errors.js'
import { epochNs, millisecondsToNs, nowNs } from './time.js'
import type { Wakeup } from './wakeup.js'
import { type DirectoryWatch, watchDirectory } from './watch.js'

export interface TailRoot {
  readonly runtime: Runtime
  readonly channel: 'transcript' | 'rollout'
  readonly directory: string
}

export const tailRoots = (roots: Readonly<Record<Runtime, string>>): readonly TailRoot[] => [
  { runtime: 'claude', channel: 'transcript', directory: join(roots.claude, 'projects') },
  { runtime: 'codex', channel: 'rollout', directory: join(roots.codex, 'sessions') },
  { runtime: 'codex', channel: 'rollout', directory: join(roots.codex, 'archived_sessions') },
]

export interface ReadRetry {
  readonly pauseMs: number
  readonly gapAfterMs: number
}

export interface TailOptions {
  readonly roots: readonly TailRoot[]
  readonly fsWatch: boolean
  readonly scanIntervalMs: number
  readonly readRetry: ReadRetry
}

export interface TailSource {
  readonly open: (cursors: readonly FileCursor[]) => void
  readonly take: () => Promise<CollectorBatch | null>
  readonly close: () => Promise<void>
}

interface Failure {
  readonly since: EpochNs
  attempts: number
  gap: CollectedGap | null
  timer: NodeJS.Timeout | undefined
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

const listFiles = async (directory: string): Promise<string[]> => {
  const found: string[] = []
  const pending = [directory]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of await readdir(next, { withFileTypes: true }).catch(() => [])) {
      const path = join(next, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile() && entry.name.endsWith(fileExtension)) {
        found.push(path)
      }
    }
  }
  return found
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
  const files = new Map<string, TrackedFile>()
  const known = new Map<string, FileCursor>()
  const dirty = new Map<string, TrackedFile>()
  const watches = new Map<TailRoot, DirectoryWatch>()
  let scanRequested = false
  let scanning: Promise<void> | null = null
  let timer: NodeJS.Timeout | undefined
  let closed = false

  const track = (root: TailRoot, path: string): TrackedFile => {
    const existing = files.get(path)
    if (existing !== undefined) {
      return existing
    }
    const file: TrackedFile = { path, root, cursor: known.get(path) ?? null, failure: null }
    files.set(path, file)
    return file
  }

  const scan = async (): Promise<void> => {
    for (const root of options.roots) {
      watches.get(root)?.ensure()
      for (const path of await listFiles(root.directory)) {
        const file = track(root, path)
        const stats = await stat(path, { bigint: true }).catch(absent)
        if (stats !== null && hasNewData(file.cursor, stats)) {
          dirty.set(path, file)
        }
      }
    }
  }

  const runScans = async (): Promise<void> => {
    while (scanRequested && !closed) {
      scanRequested = false
      await scan()
      wakeup.notify()
    }
    scanning = null
    timer = closed ? undefined : setTimeout(requestScan, options.scanIntervalMs)
  }

  const requestScan = (): void => {
    scanRequested = true
    if (scanning === null) {
      clearTimeout(timer)
      scanning = runScans()
    }
  }

  const retryLater = (file: TrackedFile, failure: Failure): void => {
    clearTimeout(failure.timer)
    const pause = Math.min(options.readRetry.pauseMs * 2 ** (failure.attempts - 1), options.scanIntervalMs)
    failure.timer = setTimeout(() => {
      dirty.set(file.path, file)
      wakeup.notify()
    }, pause).unref()
  }

  const failed = (file: TrackedFile, error: unknown): ReadOutcome => {
    const now = nowNs()
    const failure = file.failure ?? { since: now, attempts: 0, gap: null, timer: undefined }
    file.failure = failure
    failure.attempts += 1
    retryLater(file, failure)
    if (failure.gap !== null || now - failure.since < millisecondsToNs(options.readRetry.gapAfterMs)) {
      return nothing
    }
    failure.gap = {
      key: { kind: 'gap', gap: 'read_failed', subject: file.path },
      stream: file.cursor?.stream ?? null,
      details: describeError(error),
      detected_at: failure.since,
      closed_at: null,
    }
    return { ...nothing, gaps: [failure.gap] }
  }

  const recovered = (file: TrackedFile): CollectedGap[] => {
    const gap = file.failure?.gap ?? null
    clearTimeout(file.failure?.timer)
    file.failure = null
    if (gap === null) {
      return []
    }
    const now = nowNs()
    return [{ ...gap, closed_at: now > gap.detected_at ? now : gap.detected_at }]
  }

  const read = async (file: TrackedFile): Promise<ReadOutcome> => {
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
    const gaps = recovered(file)
    const records: CollectedRecord[] = []
    const observedAt = epochNs(stats.mtimeNs)
    let lineStart = 0
    let line = start.line
    let lastOrdinal = start.last_ordinal
    for (let lineEnd = chunk.bytes.indexOf(lineFeed); lineEnd >= 0; lineEnd = chunk.bytes.indexOf(lineFeed, lineStart)) {
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
    const cursor: FileCursor = {
      ...start,
      offset: start.offset + lineStart,
      line,
      size: Number(stats.size),
      last_ordinal: lastOrdinal,
    }
    file.cursor = cursor
    return {
      records,
      cursor: lineStart > 0 ? cursor : null,
      gaps,
      bytes: chunk.bytes.length,
      more: chunk.bytes.length < chunk.available,
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
      const outcome = await read(file)
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

  const watchRoot = (root: TailRoot): DirectoryWatch =>
    watchDirectory(root.directory, true, {
      changed: (name) => {
        if (!name.endsWith(fileExtension)) {
          return
        }
        const path = join(root.directory, name)
        dirty.set(path, track(root, path))
        wakeup.notify()
      },
      lost: requestScan,
    })

  const open = (cursors: readonly FileCursor[]): void => {
    for (const cursor of cursors) {
      known.set(cursor.path, cursor)
    }
    if (options.fsWatch) {
      for (const root of options.roots) {
        watches.set(root, watchRoot(root))
      }
    }
    requestScan()
  }

  const close = async (): Promise<void> => {
    closed = true
    clearTimeout(timer)
    for (const watch of watches.values()) {
      watch.close()
    }
    for (const file of files.values()) {
      clearTimeout(file.failure?.timer)
    }
    await scanning
  }

  return { open, take, close }
}
