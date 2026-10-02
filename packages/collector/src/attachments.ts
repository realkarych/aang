import { isUtf8 } from 'node:buffer'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CollectedGap, CollectedRecord, CollectorBatch, StreamKey } from '@aang/contract'
import { contentHash } from '@aang/contract/ids'
import type { Failure, Retrier } from './retry.js'
import { epochNs } from './time.js'
import type { Wakeup } from './wakeup.js'

export interface AttachmentSource {
  readonly request: (path: string, stream: StreamKey) => void
  readonly take: () => Promise<CollectorBatch | null>
  readonly close: () => void
}

interface Request {
  readonly key: string
  readonly path: string
  readonly stream: StreamKey
  failure: Failure | null
}

const maxBytesPerBatch = 8 * 1024 ** 2
const maxReadsPerBatch = 4096

const requireAttachmentPath = (root: string, path: string): void => {
  const relation = relative(root, path)
  const parts = relation.split(sep)
  if (!isAbsolute(path) || isAbsolute(relation) || parts.includes('..') || parts.length < 4 || parts.at(-2) !== 'tool-results') {
    throw new Error('attachment must be a tool-results file inside the configured Claude projects directory')
  }
}

const readAttachment = async (root: string, request: Request): Promise<CollectedRecord> => {
  const [canonicalRoot, path] = await Promise.all([realpath(root), realpath(request.path)])
  requireAttachmentPath(canonicalRoot, path)
  if (!(await stat(path)).isFile()) {
    throw new Error('attachment is not a regular file')
  }
  const file = await open(path, 'r')
  try {
    const stats = await file.stat({ bigint: true })
    if (!stats.isFile()) {
      throw new Error('attachment is not a regular file')
    }
    const content = await file.readFile()
    if (!isUtf8(content) || content.includes(0)) {
      throw new Error('attachment is not UTF-8 text')
    }
    return {
      channel: 'transcript',
      runtime: 'claude',
      stream: request.stream,
      position: { kind: 'file', path: request.path, content_hash: contentHash(content) },
      hook: null,
      observed_at: epochNs(stats.mtimeNs),
      payload: content.toString('utf8'),
    }
  } finally {
    await file.close()
  }
}

export const createAttachmentSource = (root: string, retrier: Retrier, wakeup: Wakeup): AttachmentSource => {
  const pending = new Map<string, Request>()
  const dirty = new Map<string, Request>()
  let closed = false
  const active = (): boolean => !closed

  const mark = (request: Request): void => {
    if (!closed && pending.get(request.key) === request) {
      dirty.set(request.key, request)
      wakeup.notify()
    }
  }

  const request = (path: string, stream: StreamKey): void => {
    if (closed) {
      throw new Error('the collector is closed')
    }
    requireAttachmentPath(root, path)
    const absolute = resolve(path)
    const key = JSON.stringify([absolute, stream])
    if (!pending.has(key)) {
      const entry: Request = { key, path: absolute, stream, failure: null }
      pending.set(key, entry)
      mark(entry)
    }
  }

  const take = async (): Promise<CollectorBatch | null> => {
    const records: CollectedRecord[] = []
    const gaps: CollectedGap[] = []
    let bytes = 0
    let reads = 0
    for (const [key, entry] of [...dirty]) {
      if (!active() || bytes >= maxBytesPerBatch || reads >= maxReadsPerBatch) {
        break
      }
      dirty.delete(key)
      reads += 1
      let record: CollectedRecord
      try {
        record = await readAttachment(root, entry)
      } catch (error) {
        if (active()) {
          gaps.push(...retrier.failed(entry, entry.stream, error, () => { mark(entry) }))
        }
        continue
      }
      if (active()) {
        records.push(record)
        gaps.push(...retrier.recovered(entry))
        bytes += Buffer.byteLength(record.payload)
        pending.delete(key)
      }
    }
    return records.length === 0 && gaps.length === 0 ? null : { records, cursors: [], gaps }
  }

  const close = (): void => {
    closed = true
    for (const entry of pending.values()) {
      clearTimeout(entry.failure?.timer)
    }
    pending.clear()
    dirty.clear()
  }

  return { request, take, close }
}
