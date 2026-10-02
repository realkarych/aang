import type { BigIntStats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type {
  CollectedGap,
  CollectedPosition,
  CollectedRecord,
  CollectorBatch,
  ContentHash,
  EpochNs,
  Runtime,
} from '@aang/contract'
import { contentHash } from '@aang/contract/ids'
import { absent, isMissing } from './errors.js'
import type { Backoff, Failure, Retrier } from './retry.js'
import { epochNs, nowNs } from './time.js'
import { segmentsOf, type TreeRoot } from './tree.js'
import type { Wakeup } from './wakeup.js'

export interface SnapshotRoot {
  readonly root: TreeRoot
  readonly runtime: Runtime
  readonly channel: 'transcript' | 'registry'
  readonly selects: (segments: readonly string[]) => boolean
}

export interface SnapshotOptions {
  readonly roots: readonly SnapshotRoot[]
  readonly retrier: Retrier
}

export interface SnapshotSource {
  readonly changed: (root: TreeRoot, path: string) => void
  readonly listed: (root: TreeRoot, paths: readonly string[]) => Promise<void>
  readonly take: () => Promise<CollectorBatch | null>
  readonly close: () => void
}

interface Unsettled extends Backoff {
  readonly hash: ContentHash
}

interface SnapshotFile {
  readonly path: string
  readonly source: SnapshotRoot
  seen: string | null
  emitted: ContentHash | null
  unsettled: Unsettled | null
  failure: Failure | null
}

interface Loaded {
  readonly stats: BigIntStats
  readonly content: Buffer
}

interface ReadOutcome {
  readonly records: readonly CollectedRecord[]
  readonly gaps: readonly CollectedGap[]
}

const maxBytesPerBatch = 8 * 1024 ** 2
const maxRecordsPerBatch = 4096

const fingerprint = (stats: BigIntStats): string => [stats.dev, stats.ino, stats.size, stats.mtimeNs].join(':')

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const load = async (path: string): Promise<Loaded | null> => {
  const stats = await stat(path, { bigint: true })
  return stats.isFile() ? { stats, content: await readFile(path) } : null
}

export const createSnapshotSource = (options: SnapshotOptions, wakeup: Wakeup): SnapshotSource => {
  const { retrier } = options
  const sources = new Map(options.roots.map((source) => [source.root, source]))
  const files = new Map<string, SnapshotFile>()
  const dirty = new Map<string, SnapshotFile>()

  const track = (source: SnapshotRoot, path: string): SnapshotFile => {
    const existing = files.get(path)
    if (existing !== undefined) {
      return existing
    }
    const file: SnapshotFile = { path, source, seen: null, emitted: null, unsettled: null, failure: null }
    files.set(path, file)
    return file
  }

  const current = (file: SnapshotFile): boolean => files.get(file.path) === file

  const mark = (file: SnapshotFile): void => {
    if (current(file)) {
      dirty.set(file.path, file)
      wakeup.notify()
    }
  }

  const settle = (file: SnapshotFile): void => {
    clearTimeout(file.unsettled?.timer)
    file.unsettled = null
  }

  const record = (file: SnapshotFile, position: CollectedPosition, observedAt: EpochNs, payload: string): CollectedRecord => ({
    channel: file.source.channel,
    runtime: file.source.runtime,
    stream: null,
    position,
    hook: null,
    observed_at: observedAt,
    payload,
  })

  const vanished = (file: SnapshotFile): CollectedRecord[] => {
    settle(file)
    const emitted = file.emitted
    file.emitted = null
    file.seen = null
    if (dirty.get(file.path) !== file) {
      files.delete(file.path)
    }
    return emitted === null
      ? []
      : [record(file, { kind: 'file_removed', path: file.path, last_content_hash: emitted }, nowNs(), '')]
  }

  const complete = (file: SnapshotFile, hash: ContentHash, payload: string): boolean => {
    if (isJson(payload)) {
      return true
    }
    if (file.unsettled?.hash !== hash) {
      settle(file)
    }
    const unsettled = file.unsettled ?? { ...retrier.backoff(), hash }
    file.unsettled = unsettled
    if (retrier.lasted(unsettled)) {
      return true
    }
    retrier.later(unsettled, () => {
      mark(file)
    })
    return false
  }

  const loaded = (file: SnapshotFile, { stats, content }: Loaded): CollectedRecord[] => {
    file.seen = fingerprint(stats)
    const hash = contentHash(content)
    const payload = content.toString('utf8')
    if (hash !== file.emitted && !complete(file, hash, payload)) {
      return []
    }
    settle(file)
    if (hash === file.emitted) {
      return []
    }
    file.emitted = hash
    return [record(file, { kind: 'file', path: file.path, content_hash: hash }, epochNs(stats.mtimeNs), payload)]
  }

  const read = async (file: SnapshotFile): Promise<ReadOutcome> => {
    let content: Loaded | null
    try {
      content = await load(file.path)
    } catch (error) {
      if (!isMissing(error)) {
        return {
          records: [],
          gaps: retrier.failed(file, null, error, () => {
            mark(file)
          }),
        }
      }
      content = null
    }
    if (!current(file)) {
      return { records: [], gaps: [] }
    }
    const gaps = retrier.recovered(file)
    return { records: content === null ? vanished(file) : loaded(file, content), gaps }
  }

  const changed = (root: TreeRoot, path: string): void => {
    const source = sources.get(root)
    if (source?.selects(segmentsOf(root, path)) === true) {
      mark(track(source, path))
    }
  }

  const listed = async (root: TreeRoot, paths: readonly string[]): Promise<void> => {
    const source = sources.get(root)
    if (source === undefined) {
      return
    }
    const present = new Set(paths.filter((path) => source.selects(segmentsOf(root, path))))
    for (const path of present) {
      const stats = await stat(path, { bigint: true }).catch(absent)
      const file = track(source, path)
      if (stats === null || fingerprint(stats) !== file.seen) {
        mark(file)
      }
    }
    for (const file of files.values()) {
      if (file.source === source && !present.has(file.path)) {
        mark(file)
      }
    }
  }

  const take = async (): Promise<CollectorBatch | null> => {
    const records: CollectedRecord[] = []
    const gaps: CollectedGap[] = []
    let bytes = 0
    for (const [path, file] of [...dirty]) {
      if (bytes >= maxBytesPerBatch || records.length >= maxRecordsPerBatch) {
        break
      }
      if (!current(file)) {
        continue
      }
      if (dirty.get(path) === file) {
        dirty.delete(path)
      }
      const outcome = await read(file)
      records.push(...outcome.records)
      gaps.push(...outcome.gaps)
      bytes += outcome.records.reduce((total, { payload }) => total + payload.length, 0)
    }
    return records.length === 0 && gaps.length === 0 ? null : { records, cursors: [], gaps }
  }

  const close = (): void => {
    for (const file of files.values()) {
      clearTimeout(file.unsettled?.timer)
      clearTimeout(file.failure?.timer)
    }
  }

  return { changed, listed, take, close }
}
