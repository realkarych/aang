import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CollectedGap,
  type CollectedRecord,
  type CollectorBatch,
  type SpoolFileName,
  spoolLayout,
} from '@aang/contract'
import { contentHash } from '@aang/contract/ids'
import { absent, isMissing } from './errors.js'
import { parseSpoolFile } from './spool-file.js'
import { epochNs, millisecondsToNs, nowNs } from './time.js'
import type { Wakeup } from './wakeup.js'
import { type DirectoryWatch, watchDirectory } from './watch.js'

export interface SpoolOptions {
  readonly directory: string
  readonly fsWatch: boolean
  readonly scanIntervalMs: number
  readonly maxAgeDays: number
}

export interface SpoolStats {
  readonly files: number
  readonly bytes: number
}

export interface SpoolSource {
  readonly open: () => Promise<void>
  readonly take: () => Promise<CollectorBatch | null>
  readonly ack: (batch: CollectorBatch) => Promise<void>
  readonly stats: () => Promise<SpoolStats>
  readonly close: () => void
}

interface Waiting {
  readonly name: string
  readonly observedAt: bigint
  readonly size: bigint
}

const maxFilesPerBatch = 256
const maxBytesPerBatch = 8 * 1024 ** 2
const temporaryGraceMs = 60_000
const privateMode = 0o700
const day = 24 * 60 * 60 * 1_000

const byArrival = (left: Waiting, right: Waiting): number => {
  if (left.observedAt !== right.observedAt) {
    return left.observedAt < right.observedAt ? -1 : 1
  }
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

const isoTime = (observedAt: bigint): string => new Date(Number(observedAt / 1_000_000n)).toISOString()

const expiredGap = (expired: readonly Waiting[], maxAgeDays: number): CollectedGap => {
  const oldest = expired[0]
  const newest = expired.at(-1)
  const range = oldest === undefined || newest === undefined ? '' : `, ${isoTime(oldest.observedAt)} to ${isoTime(newest.observedAt)}`
  return {
    key: { kind: 'gap', gap: 'spool_expired', subject: contentHash(expired.map(({ name }) => name).join('\n')) },
    stream: null,
    details: `${String(expired.length)} spool files older than ${String(maxAgeDays)} days discarded${range}`,
    detected_at: nowNs(),
    closed_at: null,
  }
}

const unknownRecordGap = (name: string, reason: string): CollectedGap => ({
  key: { kind: 'gap', gap: 'unknown_records', subject: `spool:${name}` },
  stream: null,
  details: `spool file ${name} left in the spool: ${reason}`,
  detected_at: nowNs(),
  closed_at: null,
})

export const createSpoolSource = (options: SpoolOptions, wakeup: Wakeup): SpoolSource => {
  const ready = join(options.directory, spoolLayout.readyDirectory)
  const temporary = join(options.directory, spoolLayout.temporaryDirectory)
  const issued = new Set<string>()
  const held = new Set<string>()
  const hinted = new Set<string>()
  const waiting = new Map<string, Waiting>()
  const deletions = new WeakMap<CollectorBatch, Set<string>>()
  let listingRequested = true
  let expiryPending = true
  let watch: DirectoryWatch | null = null
  let timer: NodeJS.Timeout | null = null

  const requestListing = (): void => {
    listingRequested = true
    wakeup.notify()
  }

  const inspect = async (name: string): Promise<Waiting | null> => {
    const stats = await stat(join(ready, name), { bigint: true }).catch(absent)
    return stats?.isFile() === true ? { name, observedAt: stats.mtimeNs, size: stats.size } : null
  }

  const list = async (): Promise<string[]> => {
    const created = await mkdir(ready, { recursive: true, mode: privateMode })
    if (created !== undefined) {
      watch?.reset()
    }
    watch?.ensure()
    return readdir(ready)
  }

  const discover = async (): Promise<void> => {
    const listing = listingRequested
    listingRequested = false
    const hints = [...hinted]
    hinted.clear()
    for (const name of listing ? await list() : hints) {
      if (issued.has(name) || held.has(name) || waiting.has(name)) {
        continue
      }
      const entry = await inspect(name)
      if (entry !== null) {
        waiting.set(name, entry)
      }
    }
  }

  const expire = (): { readonly names: readonly string[]; readonly gaps: readonly CollectedGap[] } => {
    if (!expiryPending) {
      return { names: [], gaps: [] }
    }
    expiryPending = false
    const cutoff = nowNs() - millisecondsToNs(options.maxAgeDays * day)
    const expired = [...waiting.values()].filter(({ observedAt }) => observedAt < cutoff).sort(byArrival)
    for (const { name } of expired) {
      waiting.delete(name)
      issued.add(name)
    }
    return {
      names: expired.map(({ name }) => name),
      gaps: expired.length === 0 ? [] : [expiredGap(expired, options.maxAgeDays)],
    }
  }

  const select = (): Waiting[] => {
    const selected: Waiting[] = []
    let bytes = 0
    for (const entry of [...waiting.values()].sort(byArrival)) {
      if (selected.length >= maxFilesPerBatch || (selected.length > 0 && bytes + Number(entry.size) > maxBytesPerBatch)) {
        break
      }
      selected.push(entry)
      bytes += Number(entry.size)
    }
    return selected
  }

  const take = async (): Promise<CollectorBatch | null> => {
    await discover()
    const expired = expire()
    const records: CollectedRecord[] = []
    const gaps: CollectedGap[] = [...expired.gaps]
    const names: string[] = [...expired.names]
    for (const entry of select()) {
      waiting.delete(entry.name)
      const bytes = await readFile(join(ready, entry.name)).catch(absent)
      if (bytes === null) {
        continue
      }
      const file = parseSpoolFile(bytes)
      if (file.header === null) {
        held.add(entry.name)
        gaps.push(unknownRecordGap(entry.name, file.reason))
        continue
      }
      issued.add(entry.name)
      names.push(entry.name)
      records.push({
        channel: 'hook',
        runtime: file.header.runtime,
        stream: null,
        position: { kind: 'spool', file: entry.name as SpoolFileName },
        hook: { registration: file.header.registration, env: file.header.env },
        observed_at: epochNs(entry.observedAt),
        payload: file.payload,
      })
    }
    if (records.length === 0 && gaps.length === 0) {
      return null
    }
    const batch: CollectorBatch = { records, cursors: [], gaps }
    deletions.set(batch, new Set(names))
    return batch
  }

  const ack = async (batch: CollectorBatch): Promise<void> => {
    const pending = deletions.get(batch)
    if (pending === undefined) {
      return
    }
    for (const name of [...pending]) {
      await rm(join(ready, name), { force: true })
      pending.delete(name)
      issued.delete(name)
    }
    deletions.delete(batch)
  }

  const removeStaleTemporaryFiles = async (): Promise<void> => {
    const cutoff = Date.now() - temporaryGraceMs
    for (const name of await readdir(temporary)) {
      const path = join(temporary, name)
      const stats = await stat(path).catch(absent)
      if (stats !== null && stats.mtimeMs < cutoff) {
        await rm(path, { force: true, recursive: true }).catch(absent)
      }
    }
  }

  const open = async (): Promise<void> => {
    await mkdir(ready, { recursive: true, mode: privateMode })
    await mkdir(temporary, { recursive: true, mode: privateMode })
    await removeStaleTemporaryFiles()
    if (options.fsWatch) {
      watch = watchDirectory(ready, false, {
        changed: (name) => {
          hinted.add(name)
          wakeup.notify()
        },
        lost: requestListing,
      })
      watch.ensure()
    }
    timer = setInterval(requestListing, options.scanIntervalMs)
  }

  const stats = async (): Promise<SpoolStats> => {
    const names = await readdir(ready).catch((error: unknown) => {
      if (isMissing(error)) {
        return []
      }
      throw error
    })
    let files = 0
    let bytes = 0
    for (const name of names) {
      const entry = await inspect(name)
      if (entry !== null) {
        files += 1
        bytes += Number(entry.size)
      }
    }
    return { files, bytes }
  }

  const close = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    watch?.close()
    watch = null
  }

  return { open, take, ack, stats, close }
}
