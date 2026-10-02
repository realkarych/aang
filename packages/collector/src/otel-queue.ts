import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CollectedGap, CollectedRecord, CollectorBatch, EpochNs } from '@aang/contract'
import { describeError } from './errors.js'
import { filterOtel, isObject, type OtelEnvelope, otelPayloads } from './otel-envelope.js'
import { epochNs, nowNs } from './time.js'

export const maxOtelBodyBytes = 32 * 1024 ** 2
export const maxOtelQueueBytes = 64 * 1024 ** 2
export const maxOtelRequests = 256
export const otelEnvelopeOverhead = 1024
const maxBytesPerBatch = 8 * 1024 ** 2
const maxRecordsPerBatch = 4096
const fileName = /^[\da-f-]{36}\.json$/

interface Pending {
  readonly name: string
  readonly bytes: number
  iterator: Generator<string> | null
  next: IteratorResult<string> | null
  observedAt: EpochNs
  issued: number
  done: boolean
}

export const createOtelQueue = (directory: string) => {
  const entries = new Map<string, Pending>()
  const acknowledgments = new WeakMap<CollectorBatch, Pending>()
  let bytes = 0
  let opening: Promise<void> | null = null
  let operation: Promise<void> = Promise.resolve()

  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = operation.then(run)
    operation = result.then(() => undefined, () => undefined)
    return result
  }

  const remember = (name: string, size: number): void => {
    entries.set(name, { name, bytes: size, iterator: null, next: null, observedAt: nowNs(), issued: 0, done: false })
    bytes += size
  }

  const open = (): Promise<void> => {
    opening ??= serial(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      for (const name of await readdir(directory)) {
        if (name.endsWith('.tmp')) {
          await rm(join(directory, name), { force: true })
        } else if (fileName.test(name)) {
          const info = await stat(join(directory, name))
          if (info.isFile()) {
            remember(name, info.size)
          }
        }
      }
    })
    return opening
  }

  const save = (envelope: OtelEnvelope): Promise<void> => serial(async () => {
    const content = JSON.stringify(envelope)
    const size = Buffer.byteLength(content)
    if (size > maxOtelBodyBytes + otelEnvelopeOverhead || bytes + size > maxOtelQueueBytes || entries.size >= maxOtelRequests) {
      throw new Error('OTLP queue budget exhausted')
    }
    const name = `${randomUUID()}.json`
    const temporary = join(directory, `${name}.tmp`)
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
      await rename(temporary, join(directory, name))
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    remember(name, size)
  })

  const remove = async (entry: Pending): Promise<void> => {
    if (entry.done && entry.issued === 0) {
      await rm(join(directory, entry.name), { force: true })
      entries.delete(entry.name)
      bytes -= entry.bytes
    }
  }

  const load = async (entry: Pending): Promise<void> => {
    if (entry.bytes > maxOtelBodyBytes + otelEnvelopeOverhead) {
      throw new Error('saved OTLP envelope exceeds the body limit')
    }
    const saved: unknown = JSON.parse(await readFile(join(directory, entry.name), 'utf8'))
    if (!isObject(saved) || typeof saved.observedAt !== 'string' || !/^\d+$/.test(saved.observedAt) || !Array.isArray(saved.resourceLogs)) {
      throw new Error('invalid saved OTLP envelope')
    }
    entry.observedAt = epochNs(BigInt(saved.observedAt))
    entry.iterator = otelPayloads(filterOtel(saved, saved.observedAt))
    entry.next = entry.iterator.next()
  }

  const take = (): Promise<CollectorBatch | null> => serial(async () => {
    for (const entry of entries.values()) {
      if (entry.done) {
        continue
      }
      if (entry.iterator === null) {
        try {
          await load(entry)
        } catch (error) {
          const detected = nowNs()
          const gap: CollectedGap = {
            key: { kind: 'gap', gap: 'unknown_records', subject: `otel:${entry.name}` },
            stream: null,
            details: `Saved OTLP request cannot be read: ${describeError(error)}`,
            detected_at: detected,
            closed_at: detected,
          }
          entry.done = true
          return { records: [], cursors: [], gaps: [gap] }
        }
      }
      const records: CollectedRecord[] = []
      let size = 0
      while (entry.next?.done === false && records.length < maxRecordsPerBatch) {
        const payload = entry.next.value
        const length = Buffer.byteLength(payload)
        if (records.length > 0 && size + length > maxBytesPerBatch) {
          break
        }
        records.push({ channel: 'otel', runtime: 'codex', stream: null, position: { kind: 'otel' }, hook: null, observed_at: entry.observedAt, payload })
        size += length
        entry.next = entry.iterator?.next() ?? null
      }
      entry.done = entry.next?.done !== false
      if (entry.done) {
        entry.iterator = null
        entry.next = null
      }
      if (records.length === 0) {
        await remove(entry)
        continue
      }
      const batch: CollectorBatch = { records, cursors: [], gaps: [] }
      entry.issued += 1
      acknowledgments.set(batch, entry)
      return batch
    }
    return null
  })

  const ack = (batch: CollectorBatch): Promise<void> => serial(async () => {
    const entry = acknowledgments.get(batch)
    if (entry === undefined) {
      return
    }
    entry.issued -= 1
    try {
      await remove(entry)
    } catch (error) {
      entry.issued += 1
      throw error
    }
    acknowledgments.delete(batch)
  })

  return { open, save, take, ack, bytes: () => bytes, count: () => entries.size, idle: () => operation }
}
