import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createCollector } from '@aang/collector'
import { Config, type CollectedGap } from '@aang/contract'
import { openStore } from '@aang/store'
import { expect, test, vi } from 'vitest'

const epochNow = (): bigint => BigInt(Date.now()) * 1_000_000n

const envelope = (sharedBytes: number): string => JSON.stringify({
  resourceLogs: [{
    resource: { attributes: [{ key: 'shared', value: { stringValue: 'x'.repeat(sharedBytes) } }] },
    scopeLogs: [{ logRecords: [{ attributes: [{ key: 'event.name', value: { stringValue: 'codex.tool_decision' } }] }] }],
  }],
})

const rejectOversized = (url: string): Promise<number | undefined> => new Promise((resolve, reject) => {
  const sending = request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(32 * 1024 ** 2 + 1) },
  }, (response) => {
    response.resume()
    resolve(response.statusCode)
    sending.destroy()
  })
  sending.on('error', reject)
  sending.flushHeaders()
})

test('deferred OTLP parse failures and immediate rejections form a complete gap that commits to the store', async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'aang-otel-gaps-'))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const store = openStore({ home: join(root, 'store') })
  onTestFinished(() => { store.close() })
  const largeBody = envelope(30 * 1024 ** 2)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const spool = join(root, String(attempt), 'spool')
    const collector = createCollector({
      spool,
      runtimeRoots: { claude: join(root, 'claude'), codex: join(root, 'codex') },
      adapters: new Map(),
      config: Config.parse({ collector: { fsWatch: false } }),
    })
    onTestFinished(() => collector.close())
    const listener = await collector.listenOtel({ port: 0, token: 'gap-test' })
    const url = `http://${listener.host}:${String(listener.port)}/otel/gap-test/v1/logs`
    const post = async (body: string): Promise<void> => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(response.status).toBe(200)
      await response.arrayBuffer()
    }
    await post(largeBody)
    const invalidFrom = epochNow()
    await post('invalid')
    const invalidUntil = epochNow()
    await sleep(2)
    const rejectedFrom = epochNow()
    expect(await rejectOversized(url)).toBe(413)
    const rejectedUntil = epochNow()
    await post(envelope(0))
    await vi.waitFor(async () => {
      expect((await readdir(join(spool, 'otel'))).filter((name) => name.endsWith('.json'))).toHaveLength(2)
    }, { timeout: 10_000 })

    const gaps: CollectedGap[] = []
    let records = 0
    for await (const batch of collector.start([])) {
      for (const gap of batch.gaps) {
        const saved = store.transaction((tx) => tx.gaps.save({ ...gap, run: null, session: null }))
        expect(store.gaps.get(saved.id)).toEqual(saved)
        gaps.push(gap)
      }
      records += batch.records.length
      await collector.ack(batch)
      if (records === 2 && gaps.length > 0) {
        break
      }
    }
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.details).toContain('affected requests: 2')
    expect(gaps[0]?.detected_at).toBeGreaterThanOrEqual(invalidFrom)
    expect(gaps[0]?.detected_at).toBeLessThanOrEqual(invalidUntil)
    expect(gaps[0]?.closed_at).toBeGreaterThanOrEqual(rejectedFrom)
    expect(gaps[0]?.closed_at).toBeLessThanOrEqual(rejectedUntil)
  }
})
