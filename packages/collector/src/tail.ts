import type { BigIntStats } from 'node:fs'
import { open as openFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { AdapterRegistry, CollectedGap, CollectedRecord, CollectorBatch, EpochNs, FileCursor, Runtime, StreamKey } from '@aang/contract'
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
  readonly adapters: AdapterRegistry
  readonly lookbackDays: number
}

export interface TailSource {
  readonly open: (cursors: readonly FileCursor[]) => void
  readonly take: () => Promise<CollectorBatch | null>
  readonly close: () => Promise<void>
  readonly rescan: (streams: readonly StreamKey[]) => void
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
  replay: boolean
  examined: number | null
}

interface Recovery {
  readonly file: TrackedFile
  gap: CollectedGap | null
  pending: boolean
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

const invalidated = (cursor: FileCursor, stats: BigIntStats): boolean =>
  !sameFile(cursor, stats) || stats.size < BigInt(cursor.size)

const hasNewData = (file: TrackedFile, stats: BigIntStats): boolean =>
  file.cursor === null || !sameFile(file.cursor, stats) || stats.size !== BigInt(file.cursor.size)
  || BigInt(file.examined ?? file.cursor.offset) < stats.size

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

const accepts = (root: TailRoot, name: string): boolean =>
  name.endsWith(fileExtension) || (root.runtime === 'claude' && name.includes('.jsonl.superseded-'))

const contains = (root: TailRoot, path: string): boolean => {
  const within = relative(root.directory, path)
  return within !== '' && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)
}

const listFiles = async (root: TailRoot): Promise<string[]> => {
  const found: string[] = []
  const pending = [root.directory]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const entries = await readdir(next, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) {
        return []
      }
      throw error
    })
    for (const entry of entries) {
      const path = join(next, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.isFile() && accepts(root, entry.name)) {
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
  const dirty = new Map<string, TrackedFile>()
  const watches = new Map<TailRoot, DirectoryWatch>()
  const recoveries = new Map<StreamKey, Recovery>()
  const rescans = new Set<StreamKey>()
  let scanRequested = false
  let taking: Promise<CollectorBatch | null> | null = null
  let timer: NodeJS.Timeout | undefined
  let closed = false

  const track = (root: TailRoot, path: string): TrackedFile => {
    const existing = files.get(path)
    if (existing !== undefined) {
      return existing
    }
    const file: TrackedFile = { path, root, cursor: null, failure: null, replay: false, examined: null }
    files.set(path, file)
    return file
  }

  const scan = async (): Promise<void> => {
    const seen = new Set<string>()
    for (const root of options.roots) {
      watches.get(root)?.ensure()
      for (const path of await listFiles(root).catch(() => [])) {
        seen.add(path)
        const file = track(root, path)
        const stats = await stat(path, { bigint: true }).catch(absent)
        if (stats === null || hasNewData(file, stats)) {
          dirty.set(path, file)
        }
      }
    }
    for (const file of files.values()) {
      if (file.cursor !== null && !seen.has(file.path)) {
        dirty.set(file.path, file)
      }
    }
    for (const recovery of recoveries.values()) {
      recovery.pending = true
    }
    clearTimeout(timer)
    timer = closed ? undefined : setTimeout(requestScan, options.scanIntervalMs)
  }

  const requestScan = (): void => {
    scanRequested = true
    wakeup.notify()
  }

  const retryLater = (file: TrackedFile, failure: Failure): void => {
    clearTimeout(failure.timer)
    const pause = Math.min(options.readRetry.pauseMs * 2 ** (failure.attempts - 1), options.scanIntervalMs)
    failure.timer = setTimeout(() => {
      dirty.set(file.path, file)
      for (const recovery of recoveries.values()) {
        if (recovery.file === file) {
          recovery.pending = true
        }
      }
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

  const reset = (file: TrackedFile): void => {
    file.cursor = null
    file.replay = true
    file.examined = null
    dirty.set(file.path, file)
  }

  const invalidate = (file: TrackedFile): void => {
    const stream = file.cursor?.stream
    if (stream !== undefined && stream !== null && !recoveries.has(stream)) {
      recoveries.set(stream, { file, gap: null, pending: true })
    }
    reset(file)
  }

  const identify = async (file: TrackedFile, stats: BigIntStats): Promise<StreamKey | null> => {
    const adapter = options.adapters.get(file.root.runtime)
    if (adapter === undefined) {
      return null
    }
    const { bytes } = await readChunk(file.path, 0, Number(stats.size))
    const complete = bytes.subarray(0, bytes.lastIndexOf(lineFeed) + 1).toString('utf8')
    return adapter.streamKey(complete.split(/\r?\n/).filter((line) => line.length > 0))
  }

  const prepare = async (file: TrackedFile): Promise<void> => {
    try {
      const stats = await stat(file.path, { bigint: true })
      if (file.cursor !== null && (!stats.isFile() || invalidated(file.cursor, stats))) {
        invalidate(file)
      }
    } catch (error) {
      if (isMissing(error) && file.cursor !== null) {
        invalidate(file)
      }
    }
  }

  const relocate = async (): Promise<CollectedGap[]> => {
    const gaps: CollectedGap[] = []
    for (const [stream, recovery] of recoveries) {
      if (!recovery.pending) {
        continue
      }
      recovery.pending = false
      let found = false
      let failure: unknown = null
      for (const root of options.roots.filter(({ runtime }) => runtime === recovery.file.root.runtime)) {
        try {
          for (const path of await listFiles(root)) {
            const file = track(root, path)
            try {
              const stats = await stat(path, { bigint: true })
              if (stats.isFile() && await identify(file, stats) === stream) {
                reset(file)
                found = true
              }
            } catch (error) {
              if (!isMissing(error)) {
                failure = error
              }
            }
          }
        } catch (error) {
          failure = error
        }
      }
      if (found) {
        gaps.push(...recovered(recovery.file))
        if (recovery.gap !== null) {
          gaps.push({ ...recovery.gap, closed_at: nowNs() })
        }
        recoveries.delete(stream)
      } else if (failure !== null) {
        gaps.push(...failed(recovery.file, failure).gaps)
      } else if (recovery.gap === null) {
        gaps.push(...recovered(recovery.file))
        recovery.gap = {
          key: { kind: 'gap', gap: 'source_lost', subject: stream },
          stream,
          details: `Source not found after searching ${recovery.file.path}`,
          detected_at: nowNs(),
          closed_at: null,
        }
        gaps.push(recovery.gap)
      }
    }
    return gaps
  }

  const read = async (file: TrackedFile, budget: number): Promise<ReadOutcome> => {
    let stats: BigIntStats
    let start: FileCursor
    let chunk: Chunk
    try {
      stats = await stat(file.path, { bigint: true })
      if (!stats.isFile()) {
        return nothing
      }
      if (file.cursor !== null && invalidated(file.cursor, stats)) {
        invalidate(file)
        wakeup.notify()
        return nothing
      }
      if (file.cursor === null && !file.replay && stats.mtimeMs < BigInt(Date.now() - options.lookbackDays * 86_400_000)) {
        return nothing
      }
      start = file.cursor ?? freshCursor(file.path, stats)
      if (start.stream === null) {
        start = { ...start, stream: await identify(file, stats) }
      }
      chunk = await readChunk(file.path, start.offset, Number(stats.size))
    } catch (error) {
      if (isMissing(error)) {
        if (file.cursor !== null) {
          invalidate(file)
          wakeup.notify()
        }
        return nothing
      }
      return failed(file, error)
    }
    const gaps = recovered(file)
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
      size: Number(stats.size),
      last_ordinal: lastOrdinal,
    }
    file.cursor = cursor
    file.replay = false
    file.examined = start.offset + examined
    return {
      records,
      cursor: lineStart > 0 ? cursor : null,
      gaps,
      bytes: lineStart,
      more: examined < chunk.available,
    }
  }

  const take = async (): Promise<CollectorBatch | null> => {
    if (scanRequested) {
      scanRequested = false
      await scan()
    }
    const requested = new Set(rescans)
    rescans.clear()
    for (const file of [...dirty.values()]) {
      await prepare(file)
    }
    for (const file of files.values()) {
      if (file.cursor?.stream !== null && file.cursor?.stream !== undefined && requested.has(file.cursor.stream)) {
        reset(file)
      }
    }
    const records: CollectedRecord[] = []
    const cursors: FileCursor[] = []
    const gaps: CollectedGap[] = await relocate()
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

  const watchRoot = (root: TailRoot): DirectoryWatch =>
    watchDirectory(root.directory, true, {
      changed: (name) => {
        for (const recovery of recoveries.values()) {
          if (recovery.file.root.runtime === root.runtime) {
            recovery.pending = true
          }
        }
        if (!accepts(root, name)) {
          requestScan()
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
      const root = options.roots.find((candidate) => contains(candidate, cursor.path))
      if (root !== undefined) {
        track(root, cursor.path).cursor = cursor
      }
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
    await taking
  }

  return {
    open,
    take: () => {
      taking = take()
      return taking
    },
    close,
    rescan: (streams) => {
      if (!closed && streams.length > 0) {
        for (const stream of streams) {
          rescans.add(stream)
        }
        requestScan()
      }
    },
  }
}
