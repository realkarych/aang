import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { CollectedGap, CollectorBatch, EpochNs, Listener } from '@aang/contract'
import { describeError } from './errors.js'
import { filterOtel } from './otel-envelope.js'
import { createOtelQueue, maxOtelBodyBytes, maxOtelQueueBytes, maxOtelRequests, otelEnvelopeOverhead } from './otel-queue.js'
import { nowNs } from './time.js'
import type { Wakeup } from './wakeup.js'

export interface OtelReceiverOptions {
  readonly port: number
  readonly token: string
}

export interface OtelReceiver {
  readonly open: () => Promise<void>
  readonly listen: (options: OtelReceiverOptions) => Promise<Listener>
  readonly setToken: (token: string) => void
  readonly take: () => Promise<CollectorBatch | null>
  readonly ack: (batch: CollectorBatch) => Promise<void>
  readonly close: () => Promise<void>
}

const loopback = '127.0.0.1'
const logsPath = /^\/otel\/([^/]+)\/v1\/logs$/
const identityEncodings = new Set(['', 'identity'])
const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
const mediaType = (header: string | undefined): string => (header ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''

const respond = (response: ServerResponse, status: number): void => {
  if (status === 200) {
    response.writeHead(status, { 'content-type': 'application/json' }).end('{}')
  } else {
    response.writeHead(status).end()
  }
}

export const createOtelReceiver = (spool: string, wakeup: Wakeup): OtelReceiver => {
  const queue = createOtelQueue(join(spool, 'otel'))
  const requests = new Set<Promise<void>>()
  let processing: Promise<void> = Promise.resolve()
  let server: Server | null = null
  let expected: Buffer | null = null
  let closed = false
  let closing: Promise<void> | null = null
  let reservedBytes = 0
  let reservedRequests = 0
  let gap: CollectedGap | null = null
  let lost = 0
  let pendingLosses = 0

  const isClosed = (): boolean => closed

  const lose = (observedAt: EpochNs, details: string): void => {
    lost += 1
    pendingLosses += 1
    gap = {
      key: gap?.key ?? { kind: 'gap', gap: 'unknown_records', subject: `otel:${String(observedAt)}:${String(lost)}` },
      stream: null,
      details: `${details.slice(0, 512)}; affected requests: ${String(pendingLosses)}`,
      detected_at: gap !== null && gap.detected_at < observedAt ? gap.detected_at : observedAt,
      closed_at: gap !== null && gap.closed_at !== null && gap.closed_at > observedAt ? gap.closed_at : observedAt,
    }
    wakeup.notify()
  }

  const accept = async (body: Buffer, observedAt: EpochNs): Promise<void> => {
    let request: unknown
    try {
      request = JSON.parse(body.toString('utf8'))
    } catch (error) {
      lose(observedAt, `OTLP logs request is not JSON and was discarded: ${describeError(error)}`)
      return
    }
    const envelope = filterOtel(request, String(observedAt))
    if (envelope.resourceLogs.length > 0) {
      await queue.save(envelope)
      wakeup.notify()
    }
  }

  const authorized = (request: IncomingMessage): boolean => {
    const token = logsPath.exec((request.url ?? '').split('?', 1)[0] ?? '')?.[1]
    return request.method === 'POST' && token !== undefined && expected !== null && timingSafeEqual(digest(token), expected)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request)) {
      respond(response, 404)
      request.resume()
      return
    }
    if (mediaType(request.headers['content-type']) !== 'application/json' || !identityEncodings.has(mediaType(request.headers['content-encoding']))) {
      respond(response, 415)
      request.resume()
      return
    }
    const declared = Number(request.headers['content-length'] ?? maxOtelBodyBytes)
    if (declared > maxOtelBodyBytes) {
      respond(response, 413)
      request.resume()
      lose(nowNs(), `OTLP logs request over ${String(maxOtelBodyBytes)} bytes was rejected`)
      return
    }
    const reservation = declared + otelEnvelopeOverhead
    if (closed || queue.bytes() + reservedBytes + reservation > maxOtelQueueBytes || queue.count() + reservedRequests >= maxOtelRequests) {
      respond(response, 503)
      request.resume()
      lose(nowNs(), 'OTLP queue budget exhausted; request rejected')
      return
    }
    reservedBytes += reservation
    reservedRequests += 1
    let deferred = false
    const release = (): void => {
      reservedBytes -= reservation
      reservedRequests -= 1
    }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > declared) {
          respond(response, 413)
          lose(nowNs(), `OTLP logs request over ${String(declared)} bytes was rejected`)
          return
        }
        chunks.push(chunk)
      }
      if (isClosed()) {
        respond(response, 503)
        return
      }
      const body = Buffer.concat(chunks, size)
      const observedAt = nowNs()
      respond(response, 200)
      deferred = true
      processing = processing.then(() => new Promise<void>((resolve) => { setImmediate(resolve) }))
        .then(() => accept(body, observedAt))
        .catch((error: unknown) => { lose(observedAt, `OTLP request processing failed: ${describeError(error)}`) })
        .finally(release)
    } finally {
      if (!deferred) {
        release()
      }
    }
  }

  const listen = async ({ port, token }: OtelReceiverOptions): Promise<Listener> => {
    if (closed) {
      throw new Error('the OpenTelemetry receiver is closed')
    }
    if (server !== null) {
      throw new Error('the OpenTelemetry receiver is already listening')
    }
    const created = createServer((request, response) => {
      const handled = handle(request, response).catch(() => { response.destroy() })
      requests.add(handled)
      void handled.finally(() => { requests.delete(handled) })
    })
    created.maxConnections = 64
    created.requestTimeout = 30_000
    server = created
    expected = digest(token)
    try {
      await queue.open()
      if (isClosed() || server !== created) {
        throw new Error('the OpenTelemetry receiver was closed during startup')
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          created.off('listening', ready)
          created.off('error', failed)
          created.off('close', stopped)
        }
        const ready = (): void => { cleanup(); resolve() }
        const failed = (error: Error): void => { cleanup(); reject(error) }
        const stopped = (): void => { failed(new Error('the OpenTelemetry receiver was closed during startup')) }
        created.once('listening', ready)
        created.once('error', failed)
        created.once('close', stopped)
        created.listen(port, loopback)
      })
      const address = created.address() as AddressInfo | null
      if (address === null || isClosed()) {
        throw new Error('the OpenTelemetry receiver was closed during startup')
      }
      return { host: loopback, port: address.port }
    } catch (error) {
      if (server === created) {
        server = null
      }
      throw error
    }
  }

  const take = async (): Promise<CollectorBatch | null> => {
    if (gap !== null) {
      const batch: CollectorBatch = { records: [], cursors: [], gaps: [gap] }
      gap = null
      pendingLosses = 0
      return batch
    }
    return queue.take()
  }

  const close = (): Promise<void> => {
    closed = true
    closing ??= (async () => {
      const running = server
      server = null
      if (running !== null) {
        await new Promise<void>((resolve) => {
          running.close(() => { resolve() })
          running.closeAllConnections()
        })
      }
      await Promise.all([...requests])
      await processing
      await queue.idle()
    })()
    return closing
  }

  const setToken = (token: string): void => {
    expected = digest(token)
  }

  return { open: queue.open, listen, setToken, take, ack: queue.ack, close }
}
