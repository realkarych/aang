import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { CollectedRecord, type Listener } from '@aang/contract'
import { expect, test, vi } from 'vitest'
import { createSandbox, filesUnder, prepareCollector, runCollector, type Running, sleep } from './sandbox.js'

const samples = join(import.meta.dirname, '..', '..', '..', 'docs', 'research', 'samples', 'codex-otel')

const token = 'tOk3n_otel-receiver-secret-0123456789abcdefgh'

type Json = Record<string, unknown>

interface Variant {
  readonly service: string
  readonly logRecord: Json
}

interface Samples {
  readonly envelope: { readonly resource: Json; readonly scope: Json }
  readonly variants: readonly Variant[]
  readonly others: readonly Json[]
}

const readJsonLines = async (name: string): Promise<Json[]> =>
  (await readFile(join(samples, name), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Json)

const loadSamples = async (): Promise<Samples> => {
  const envelope = JSON.parse(await readFile(join(samples, 'logs.envelope.tool_decision.approved-user.app-server.json'), 'utf8')) as {
    resourceLogs: [{ resource: Json; scopeLogs: [{ scope: Json }] }]
  }
  const [resourceLog] = envelope.resourceLogs
  return {
    envelope: { resource: resourceLog.resource, scope: resourceLog.scopeLogs[0].scope },
    variants: (await readJsonLines('logs.tool_decision.variants.jsonl')).flatMap((line) =>
      line.logRecord === undefined ? [] : [{ service: line['_service.name'] as string, logRecord: line.logRecord as Json }],
    ),
    others: (await readJsonLines('logs.other-events.jsonl')).map((line) => line.logRecord as Json),
  }
}

const resourceFor = (resource: Json, service: string): Json => ({
  ...resource,
  attributes: (resource.attributes as Json[]).map((attribute) =>
    attribute.key === 'service.name' ? { key: 'service.name', value: { stringValue: service } } : attribute,
  ),
})

const envelopeOf = (resource: Json, scope: Json, logRecords: readonly Json[]): Json => ({
  resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords }] }],
})

const logsUrl = (listener: Listener, path = `/otel/${token}/v1/logs`): string =>
  `http://${listener.host}:${String(listener.port)}${path}`

const post = (url: string, body: string | Buffer, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

const epochNow = (): bigint => BigInt(Date.now()) * 1_000_000n

const startReceiving = async (running: Running): Promise<Listener> =>
  running.collector.listenOtel({ port: 0, token })

const decisionsBody = ({ envelope, variants }: Samples, count = variants.length): string =>
  JSON.stringify(envelopeOf(envelope.resource, envelope.scope, variants.slice(0, count).map(({ logRecord }) => logRecord)))

test('a request built from the tool_decision variants yields one record per decision and nothing of the other events', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const { envelope, variants, others } = await loadSamples()
  const running = runCollector(sandbox)
  const listener = await startReceiving(running)
  expect(listener.host).toBe('127.0.0.1')
  await sleep(200)
  const filesBefore = await filesUnder(sandbox.root)

  const services = [...new Set(variants.map(({ service }) => service))]
  const request = {
    resourceLogs: services.map((service, index) => ({
      resource: resourceFor(envelope.resource, service),
      scopeLogs: [
        {
          scope: envelope.scope,
          logRecords: [
            ...(index === 0 ? others.slice(0, 4) : []),
            ...variants.filter((variant) => variant.service === service).map(({ logRecord }) => logRecord),
            ...(index === services.length - 1 ? others.slice(4) : []),
          ],
        },
      ],
    })),
  }
  const sentFrom = epochNow()
  const response = await post(logsUrl(listener), JSON.stringify(request))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('application/json')
  expect(await response.json()).toEqual({})
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(variants.length)
  })
  const sentUntil = epochNow()

  const ordered = services.flatMap((service) => variants.filter((variant) => variant.service === service))
  expect(running.records().map(({ payload }) => JSON.parse(payload) as Json)).toEqual(
    ordered.map(({ service, logRecord }) => envelopeOf(resourceFor(envelope.resource, service), envelope.scope, [logRecord])),
  )
  const sample = JSON.parse(await readFile(join(samples, 'logs.envelope.tool_decision.approved-user.app-server.json'), 'utf8')) as Json
  expect(JSON.parse(running.payloads()[0] ?? '')).toEqual({ resourceLogs: sample.resourceLogs })
  for (const record of running.records()) {
    expect(CollectedRecord.parse(record)).toEqual(record)
    expect(record).toMatchObject({ channel: 'otel', runtime: 'codex', stream: null, position: { kind: 'otel' }, hook: null })
    expect(record.observed_at).toBeGreaterThanOrEqual(sentFrom)
    expect(record.observed_at).toBeLessThanOrEqual(sentUntil)
  }
  const otherNames = others.map(
    (logRecord) => ((logRecord.attributes as Json[]).find(({ key }) => key === 'event.name')?.value as Json).stringValue as string,
  )
  expect(otherNames).toContain('codex.user_prompt')
  for (const payload of running.payloads()) {
    for (const name of otherNames) {
      expect(payload).not.toContain(name)
    }
  }
  expect(running.gaps()).toEqual([])

  for (const path of await filesUnder(sandbox.root)) {
    const content = await readFile(path, 'utf8')
    for (const name of otherNames) {
      expect(content).not.toContain(name)
    }
  }
  await running.ackAll()
  expect(await filesUnder(sandbox.root)).toEqual(filesBefore)
})

test('requests to a wrong token, path or method get 404 and leave no records', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const loaded = await loadSamples()
  const { variants } = loaded
  const running = runCollector(sandbox)
  const listener = await startReceiving(running)
  const body = decisionsBody(loaded)

  for (const path of [
    `/otel/${token}x/v1/logs`,
    `/otel/wrong/v1/logs`,
    `/otel//v1/logs`,
    `/otel/${token}/v1/traces`,
    `/otel/${token}/v1/metrics`,
    `/otel/${token}/v1/logs/`,
    `/v1/logs`,
    `/api/status`,
  ]) {
    const response = await post(logsUrl(listener, path), body)
    expect([path, response.status]).toEqual([path, 404])
  }
  const read = await fetch(logsUrl(listener))
  expect(read.status).toBe(404)

  const accepted = await post(`${logsUrl(listener)}?source=codex`, body)
  expect(accepted.status).toBe(200)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(variants.length)
  })
  await sleep(200)
  expect(running.records()).toHaveLength(variants.length)
})

test('only uncompressed JSON is accepted; other content types and encodings get 415', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const running = runCollector(sandbox)
  const listener = await startReceiving(running)
  const body = decisionsBody(await loadSamples(), 1)

  for (const headers of [
    { 'content-type': 'application/x-protobuf' },
    { 'content-type': 'text/plain' },
    { 'content-encoding': 'gzip' },
    { 'content-encoding': 'deflate' },
  ]) {
    const response = await post(logsUrl(listener), body, headers)
    expect([headers, response.status]).toEqual([headers, 415])
  }
  await sleep(200)
  expect(running.records()).toEqual([])

  for (const headers of [{ 'content-type': 'Application/JSON; charset=utf-8' }, { 'content-encoding': 'identity' }]) {
    const response = await post(logsUrl(listener), body, headers)
    expect([headers, response.status]).toEqual([headers, 200])
  }
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(2)
  })
  expect(running.gaps()).toEqual([])
})

test('a body that is not JSON is answered with 200 and recorded as an unknown_records gap; JSON without logs yields nothing', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const running = runCollector(sandbox)
  const listener = await startReceiving(running)

  const sentFrom = epochNow()
  const response = await post(logsUrl(listener), '\u00124protobuf bytes')
  expect(response.status).toBe(200)
  await vi.waitFor(() => {
    expect(running.gaps()).toHaveLength(1)
  })
  const [gap] = running.gaps()
  expect(gap).toMatchObject({ key: { kind: 'gap', gap: 'unknown_records' }, stream: null })
  expect(gap?.key.subject).toMatch(/^otel:[0-9]+:[0-9]+$/)
  expect(gap?.details).toMatch(/not JSON/)
  expect(gap?.detected_at).toBeGreaterThanOrEqual(sentFrom)
  expect(gap?.closed_at).toBe(gap?.detected_at)

  const withoutLogs = [
    '[]',
    '"logs"',
    '{}',
    '{"resourceLogs": 5}',
    '{"resourceLogs": [{"scopeLogs": [{"logRecords": [{"attributes": 7}, null]}]}]}',
  ]
  for (const body of withoutLogs) {
    const accepted = await post(logsUrl(listener), body)
    expect([body, accepted.status]).toEqual([body, 200])
  }
  await sleep(300)
  expect(running.records()).toEqual([])
  expect(running.gaps()).toHaveLength(1)
})

test('a request over 32 MiB is rejected with 413 and an unknown_records gap', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const running = runCollector(sandbox)
  const listener = await startReceiving(running)

  const response = await post(logsUrl(listener), Buffer.alloc(32 * 1024 ** 2 + 1, 0x20))
  expect(response.status).toBe(413)
  await vi.waitFor(() => {
    expect(running.gaps()).toHaveLength(1)
  })
  expect(running.gaps()[0]).toMatchObject({ key: { kind: 'gap', gap: 'unknown_records' }, stream: null })
  expect(running.gaps()[0]?.details).toMatch(/over 33554432 bytes/)

  const accepted = await post(logsUrl(listener), decisionsBody(await loadSamples(), 1))
  expect(accepted.status).toBe(200)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(1)
  })
})

test('the receiver answers 200 before the records are taken and keeps them until the collector runs', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const loaded = await loadSamples()
  const collector = prepareCollector(sandbox)
  const listener = await collector.listenOtel({ port: 0, token })
  await expect(collector.listenOtel({ port: 0, token })).rejects.toThrow(/already listening/)

  const response = await post(logsUrl(listener), decisionsBody(loaded))
  expect(response.status).toBe(200)
  await sleep(100)

  const running = runCollector(sandbox, {}, collector)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(loaded.variants.length)
  })
  expect(running.arrivals[0]?.batch.records).toHaveLength(loaded.variants.length)
})

test('a client that drops the connection mid-body does not stop the receiver', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const running = runCollector(sandbox)
  const listener = await startReceiving(running)

  const dropped = httpRequest(logsUrl(listener), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '1000' },
  })
  dropped.on('error', () => undefined)
  dropped.write('{"resourceLogs": [')
  await sleep(100)
  dropped.destroy()
  await sleep(100)

  const response = await post(logsUrl(listener), decisionsBody(await loadSamples(), 1))
  expect(response.status).toBe(200)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(1)
  })
  expect(running.gaps()).toEqual([])
})

test('listening fails on a busy port and is refused after close; close stops the listener', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const blocker = createServer()
  blocker.listen(0, '127.0.0.1')
  await once(blocker, 'listening')
  onTestFinished(() => {
    blocker.close()
  })
  const address = blocker.address()
  const busyPort = typeof address === 'object' && address !== null ? address.port : 0

  const collector = prepareCollector(sandbox)
  await expect(collector.listenOtel({ port: busyPort, token })).rejects.toThrow(/EADDRINUSE/)
  const listener = await collector.listenOtel({ port: 0, token })
  await collector.close()

  await expect(fetch(logsUrl(listener), { method: 'POST', body: '{}' })).rejects.toThrow()
  await expect(collector.listenOtel({ port: 0, token })).rejects.toThrow(/closed/)
})
