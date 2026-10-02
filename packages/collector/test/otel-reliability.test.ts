import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { type Listener } from '@aang/contract'
import { expect, onTestFinished, test, vi } from 'vitest'
import { createSandbox, filesUnder, prepareCollector, runCollector, type Sandbox, sleep } from './sandbox.js'

const decision = { attributes: [{ key: 'event.name', value: { stringValue: 'codex.tool_decision' } }] }
const envelope = (count: number, sharedBytes = 0): string => JSON.stringify({
  resourceLogs: [{
    resource: { attributes: [{ key: 'shared', value: { stringValue: 'x'.repeat(sharedBytes) } }] },
    scopeLogs: [{ logRecords: Array.from({ length: count }, () => decision) }],
  }],
})
const post = (listener: Listener, body: string): Promise<Response> => fetch(
  `http://${listener.host}:${String(listener.port)}/otel/reliability/v1/logs`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body },
)

interface Report {
  readonly listener?: Listener
  readonly count?: number
  readonly bytes?: number
  readonly observedAt?: string
  readonly acknowledged?: boolean
  readonly gaps?: number
}

const childCollector = async (sandbox: Sandbox, mode: 'drain' | 'hold') => {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'otel-child.ts'), sandbox.spool, sandbox.claude, sandbox.codex, mode], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const reports: Report[] = []
  let stderr = ''
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  child.on('message', (message: Report) => reports.push(message))
  const kill = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
  sandbox.cleanup(kill)
  const until = async (matches: (report: Report) => boolean): Promise<Report> => {
    let result: Report | undefined
    const deadline = Date.now() + 20_000
    while (result === undefined) {
      expect([child.exitCode, child.signalCode, stderr]).toEqual([null, null, ''])
      result = reports.find(matches)
      if (Date.now() > deadline) {
        throw new Error('collector report timed out')
      }
      await sleep(20)
    }
    return result
  }
  const { listener } = await until((report) => report.listener !== undefined)
  return { child, kill, until, reports, listener: listener as Listener }
}

test('closing a collector during listener startup settles the startup promise', async ({ onTestFinished }) => {
  const collector = prepareCollector(await createSandbox(onTestFinished))
  const listening = collector.listenOtel({ port: 0, token: 'reliability' }).then(() => 'listening', () => 'closed')
  await collector.close()
  expect(await Promise.race([listening, sleep(500).then(() => 'pending')])).not.toBe('pending')
})

test('a child receiver drains 150000 decisions within the body limit and accepts the next request', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const running = await childCollector(sandbox, 'drain')
  const body = envelope(150_000)
  expect(Buffer.byteLength(body)).toBeLessThan(32 * 1024 ** 2)
  expect((await post(running.listener, body)).status).toBe(200)
  await running.until(({ count }) => count === 150_000)
  const directory = join(sandbox.spool, 'otel')
  const moved = join(sandbox.spool, 'otel-backup')
  await rename(directory, moved)
  await writeFile(directory, 'temporarily unavailable')
  expect((await post(running.listener, envelope(1))).status).toBe(200)
  await running.until(({ gaps }) => gaps === 1)
  await rm(directory)
  await rename(moved, directory)
  expect((await post(running.listener, envelope(1))).status).toBe(200)
  await running.until(({ count }) => count === 150_001)
})

test('unfinished concurrent HTTP bodies share the admission budget and release it on disconnect', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const collector = prepareCollector(sandbox)
  const listener = await collector.listenOtel({ port: 0, token: 'reliability' })
  const statuses: number[] = []
  const requests = Array.from({ length: 6 }, () => {
    const request = httpRequest(`http://${listener.host}:${String(listener.port)}/otel/reliability/v1/logs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    }, (response) => {
      statuses.push(response.statusCode ?? 0)
      response.resume()
    })
    request.on('error', () => undefined)
    request.write('{')
    return request
  })
  onTestFinished(() => { for (const request of requests) { request.destroy() } })
  await vi.waitFor(() => { expect(statuses).toContain(503); })
  for (const request of requests) {
    request.destroy()
  }
  await vi.waitFor(async () => { expect((await post(listener, envelope(1))).status).toBe(200); })
  const running = runCollector(sandbox, {}, collector)
  await vi.waitFor(() => { expect(running.records().length).toBeGreaterThan(0); })
})

test('many rejected requests produce a bounded gap while the consumer is paused', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const collector = prepareCollector(sandbox)
  const listener = await collector.listenOtel({ port: 0, token: 'reliability' })
  for (let index = 0; index < 100; index += 1) {
    expect((await post(listener, 'invalid-json')).status).toBe(200)
  }
  await sleep(100)
  const running = runCollector(sandbox, {}, collector)
  await vi.waitFor(() => { expect(running.gaps()).toHaveLength(1) })
  expect(running.gaps()[0]?.details).toContain('affected requests: 100')
  expect(running.records()).toEqual([])
})

test('a corrupt saved request produces a gap and is retained after acknowledgment', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const collector = prepareCollector(sandbox)
  const listener = await collector.listenOtel({ port: 0, token: 'reliability' })
  expect((await post(listener, envelope(1))).status).toBe(200)
  await collector.close()
  const files = await filesUnder(sandbox.root)
  expect(files).toHaveLength(1)
  const path = files[0] as string
  await writeFile(path, 'broken')
  const running = runCollector(sandbox)
  await vi.waitFor(() => { expect(running.gaps()).toHaveLength(1); })
  await running.ackAll()
  expect(await filesUnder(sandbox.root)).toEqual(files)
})

test('shared resource data is stored once and expanded only into byte bounded batches', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const running = runCollector(sandbox)
  const listener = await running.collector.listenOtel({ port: 0, token: 'reliability' })
  expect((await post(listener, envelope(96, 1024 ** 2))).status).toBe(200)
  await vi.waitFor(() => { expect(running.records()).toHaveLength(96); }, { timeout: 10_000 })
  expect(running.arrivals.every(({ batch }) => batch.records.reduce((n, r) => n + Buffer.byteLength(r.payload), 0) <= 8 * 1024 ** 2)).toBe(true)
  const files = await filesUnder(sandbox.root)
  expect(files.length).toBeGreaterThan(0)
  const sizes = await Promise.all(files.map(async (path) => (await stat(path)).size))
  expect(sizes.reduce((n, size) => n + size, 0)).toBeLessThan(2 * 1024 ** 2)
})

test('unacknowledged requests exhaust a finite budget and acknowledging them reopens admission', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const collector = prepareCollector(sandbox)
  const listener = await collector.listenOtel({ port: 0, token: 'reliability' })
  const body = envelope(1, 9 * 1024 ** 2)
  const statuses: number[] = []
  for (let index = 0; index < 10; index += 1) {
    statuses.push((await post(listener, body)).status)
    await sleep(20)
  }
  expect(statuses).toContain(503)
  const accepted = statuses.filter((status) => status === 200).length
  expect(accepted).toBeGreaterThan(0)
  const running = runCollector(sandbox, {}, collector)
  await vi.waitFor(() => { expect(running.records()).toHaveLength(accepted); }, { timeout: 10_000 })
  expect((await post(listener, body)).status).toBe(503)
  await vi.waitFor(() => { expect(running.gaps().length).toBeGreaterThan(0); })
  await running.ackAll()
  expect((await post(listener, body)).status).toBe(200)
  await vi.waitFor(() => { expect(running.records()).toHaveLength(accepted + 1); }, { timeout: 10_000 })
})

test.each([1, 5000])('published decisions survive SIGKILL with %i records and are removed only after full ack', async (count) => {
  const sandbox = await createSandbox(onTestFinished)
  const child = await childCollector(sandbox, 'hold')
  const body = envelope(count).replace('"logRecords":[', '"logRecords":[{"attributes":[{"key":"event.name","value":{"stringValue":"codex.tool_result"}}],"body":{"stringValue":"discard-me"}},')
  expect((await post(child.listener, body)).status).toBe(200)
  const issued = await child.until((report) => report.count === count)
  if (count > 1) {
    child.child.send('ack-first')
    await child.until((report) => report.acknowledged === true)
  }
  const files = await filesUnder(sandbox.root)
  expect(files.length).toBeGreaterThan(0)
  for (const path of files) {
    expect(await readFile(path, 'utf8')).not.toMatch(/discard-me|codex.tool_result/)
  }
  await child.kill()
  const recovered = runCollector(sandbox)
  await vi.waitFor(() => { expect(recovered.records()).toHaveLength(count); }, { timeout: 10_000 })
  expect(recovered.records().every(({ observed_at }) => String(observed_at) === issued.observedAt)).toBe(true)
  await recovered.ackAll()
  await recovered.close()
  expect(await filesUnder(sandbox.root)).toEqual([])
  const empty = runCollector(sandbox)
  await sleep(200)
  expect(empty.records()).toEqual([])
})
