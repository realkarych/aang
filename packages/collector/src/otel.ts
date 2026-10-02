import { createHash, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CollectedGap, CollectedRecord, CollectorBatch, EpochNs, Listener } from '@aang/contract'
import { describeError } from './errors.js'
import { nowNs } from './time.js'
import type { Wakeup } from './wakeup.js'

export interface OtelReceiverOptions {
  readonly port: number
  readonly token: string
}

export interface OtelReceiver {
  readonly listen: (options: OtelReceiverOptions) => Promise<Listener>
  readonly take: () => CollectorBatch | null
  readonly close: () => Promise<void>
}

type JsonObject = Readonly<Record<string, unknown>>

const loopback = '127.0.0.1'
const logsPath = /^\/otel\/([^/]+)\/v1\/logs$/
const toolDecision = 'codex.tool_decision'
const maxBodyBytes = 32 * 1024 ** 2
const maxRecordsPerBatch = 4096
const identityEncodings = new Set(['', 'identity'])

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const objects = (value: JsonObject, key: string): JsonObject[] => {
  const member = value[key]
  return Array.isArray(member) ? member.filter(isObject) : []
}

const isToolDecision = (logRecord: JsonObject): boolean =>
  objects(logRecord, 'attributes').some(
    ({ key, value }) => key === 'event.name' && isObject(value) && value.stringValue === toolDecision,
  )

const toolDecisions = (request: unknown): string[] =>
  (isObject(request) ? objects(request, 'resourceLogs') : []).flatMap((resourceLog) =>
    objects(resourceLog, 'scopeLogs').flatMap((scopeLog) =>
      objects(scopeLog, 'logRecords')
        .filter(isToolDecision)
        .map((logRecord) =>
          JSON.stringify({ resourceLogs: [{ ...resourceLog, scopeLogs: [{ ...scopeLog, logRecords: [logRecord] }] }] }),
        ),
    ),
  )

const mediaType = (header: string | undefined): string => (header ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''

const readBody = async (request: IncomingMessage): Promise<Buffer | null> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size <= maxBodyBytes) {
      chunks.push(chunk)
    }
  }
  return size > maxBodyBytes ? null : Buffer.concat(chunks)
}

const respond = (response: ServerResponse, status: number): void => {
  if (status === 200) {
    response.writeHead(status, { 'content-type': 'application/json' }).end('{}')
  } else {
    response.writeHead(status).end()
  }
}

export const createOtelReceiver = (wakeup: Wakeup): OtelReceiver => {
  const records: CollectedRecord[] = []
  const gaps: CollectedGap[] = []
  let server: Server | null = null
  let expected: Buffer | null = null
  let lost = 0

  const lose = (observedAt: EpochNs, details: string): void => {
    lost += 1
    gaps.push({
      key: { kind: 'gap', gap: 'unknown_records', subject: `otel:${String(observedAt)}:${String(lost)}` },
      stream: null,
      details,
      detected_at: observedAt,
      closed_at: observedAt,
    })
    wakeup.notify()
  }

  const accept = (body: Buffer, observedAt: EpochNs): void => {
    let request: unknown
    try {
      request = JSON.parse(body.toString('utf8'))
    } catch (error) {
      lose(observedAt, `OTLP logs request is not JSON and was discarded: ${describeError(error)}`)
      return
    }
    const received = toolDecisions(request).map(
      (payload): CollectedRecord => ({
        channel: 'otel',
        runtime: 'codex',
        stream: null,
        position: { kind: 'otel' },
        hook: null,
        observed_at: observedAt,
        payload,
      }),
    )
    if (received.length > 0) {
      records.push(...received)
      wakeup.notify()
    }
  }

  const authorized = (request: IncomingMessage): boolean => {
    const token = logsPath.exec((request.url ?? '').split('?', 1)[0] ?? '')?.[1]
    return (
      request.method === 'POST' && token !== undefined && expected !== null && timingSafeEqual(digest(token), expected)
    )
  }

  const supported = (request: IncomingMessage): boolean =>
    mediaType(request.headers['content-type']) === 'application/json' &&
    identityEncodings.has(mediaType(request.headers['content-encoding']))

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request)) {
      respond(response, 404)
      return
    }
    if (!supported(request)) {
      respond(response, 415)
      return
    }
    const body = await readBody(request)
    const observedAt = nowNs()
    if (body === null) {
      respond(response, 413)
      lose(observedAt, `OTLP logs request over ${String(maxBodyBytes)} bytes was rejected`)
      return
    }
    respond(response, 200)
    setImmediate(() => {
      accept(body, observedAt)
    })
  }

  const listen = async ({ port, token }: OtelReceiverOptions): Promise<Listener> => {
    if (server !== null) {
      throw new Error('the OpenTelemetry receiver is already listening')
    }
    const created = createServer((request, response) => {
      handle(request, response).catch(() => {
        response.destroy()
      })
    })
    server = created
    expected = digest(token)
    created.listen(port, loopback)
    try {
      await once(created, 'listening')
    } catch (error) {
      server = null
      throw error
    }
    return { host: loopback, port: (created.address() as AddressInfo).port }
  }

  const take = (): CollectorBatch | null =>
    records.length === 0 && gaps.length === 0
      ? null
      : { records: records.splice(0, maxRecordsPerBatch), cursors: [], gaps: gaps.splice(0) }

  const close = async (): Promise<void> => {
    const running = server
    server = null
    if (running === null) {
      return
    }
    const closed = once(running, 'close')
    running.close()
    running.closeAllConnections()
    await closed
  }

  return { listen, take, close }
}
