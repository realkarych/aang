import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createCollector } from '@aang/collector'
import { Config, type Gap, type RawRecord, StreamKey } from '@aang/contract'
import type { Store } from '@aang/store'
import { expect, test, vi } from 'vitest'
import { adapters, factsOf, gapsOf, recordsOf, startEngine } from './harness.js'
import { createHome } from './home.js'
import { createLiveRoots, runLive, writeLines } from './live.js'

const stream = StreamKey.parse('["claude","session-1","main"]')

const bashResult = (path: string, cwd: string): string =>
  JSON.stringify({
    type: 'user',
    sessionId: 'session-1',
    uuid: 'result-1',
    cwd,
    timestamp: '2026-10-01T10:00:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'Bash output' }] },
    toolUseResult: { stdout: 'Bash output', stderr: '', interrupted: false, persistedOutputPath: path },
  })

const persistedOutputPath = (store: Store): string => {
  const fact = factsOf(store).find(({ kind }) => kind === 'action_end')
  if (fact?.kind !== 'action_end' || fact.payload.persisted_output_path === null) {
    throw new Error('the Bash result has no persisted output path')
  }
  return fact.payload.persisted_output_path
}

const attachmentsOf = (store: Store): RawRecord[] => recordsOf(store).filter(({ position }) => position.kind === 'file')

const readFailuresOf = (store: Store): Gap[] => gapsOf(store).filter(({ key }) => key.gap === 'read_failed')

test('persisted Bash output is ingested, deduplicated and remains available after source deletion and store restart', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const claude = join(home.path, 'claude')
  const path = join(claude, 'projects', '-work', 'session-1', 'tool-results', 'toolu_bash.txt')
  const transcript = join(claude, 'projects', '-work', 'session-1.jsonl')
  const content = 'Bash output\r\nпроверка 😀\n'.repeat(10_000)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  await writeFile(transcript, `${bashResult(path, home.path)}\n`)
  const collector = createCollector({
    spool: join(home.path, 'spool'),
    runtimeRoots: { claude, codex: join(home.path, 'codex') },
    config: Config.parse({ collector: { fsWatch: false, rootsScanIntervalMs: 30 } }),
    adapters,
  })
  const engine = startEngine(store, { all: true })
  let duplicates = 0
  let failure: { readonly error: unknown } | null = null
  const pumping = (async () => {
    for await (const batch of collector.start([])) {
      const result = await engine.ingest(batch)
      duplicates += result.duplicates
      for (const settled of result.settled) {
        await collector.ack(settled)
      }
    }
  })().catch((error: unknown) => { failure = { error } })
  const stop = async (): Promise<void> => {
    await collector.close()
    await pumping
    if (failure !== null) {
      throw failure.error
    }
  }
  onTestFinished(stop)
  await vi.waitFor(() => { expect(factsOf(store).some(({ kind }) => kind === 'action_end')).toBe(true) })
  collector.requestAttachment(persistedOutputPath(store), stream)
  await vi.waitFor(() => { expect(attachmentsOf(store)).toHaveLength(1) })
  const saved = attachmentsOf(store)[0]
  if (saved === undefined) {
    throw new Error('the requested attachment was not stored')
  }
  expect(saved).toMatchObject({
    payload: content,
    runtime: 'claude',
    channel: 'transcript',
    stream,
    parse_state: 'parsed',
    position: { kind: 'file', path, content_hash: createHash('sha256').update(content).digest('hex') },
  })
  expect(store.facts.ofRecord(saved.seq)).toEqual([])
  collector.requestAttachment(path, stream)
  await vi.waitFor(() => { expect(duplicates).toBe(1) })
  expect(attachmentsOf(store)).toHaveLength(1)

  await writeFile(path, '{"sessionId":"other-session","type":"user"}')
  collector.requestAttachment(path, stream)
  await vi.waitFor(() => { expect(attachmentsOf(store)).toHaveLength(2) })
  expect(attachmentsOf(store)[1]).toMatchObject({ parse_state: 'parsed', payload: '{"sessionId":"other-session","type":"user"}' })
  await rm(path)
  await stop()
  store.close()
  const reopened = home.open()
  expect(reopened.rawRecords.get(saved.seq)).toEqual(saved)
  expect(attachmentsOf(reopened)).toHaveLength(2)
})

test.for(['available', 'still missing'] as const)('a persisted attachment read failure continues after restart while the file is %s and closes on the first successful read', async (scenario, { onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const roots = await createLiveRoots(onTestFinished)
  const path = join(roots.claude, 'projects', '-work', 'session-1', 'tool-results', 'toolu_bash.txt')
  await mkdir(dirname(path), { recursive: true })
  await writeLines(join(roots.claude, 'projects', '-work', 'session-1.jsonl'), [bashResult(path, home.path)])
  const readRetry = { pauseMs: 10, gapAfterMs: 30 }
  const store = home.open()
  const first = runLive(onTestFinished, roots, store, startEngine(store, { all: true }), readRetry)
  await vi.waitFor(() => { expect(factsOf(store).some(({ kind }) => kind === 'action_end')).toBe(true) })
  first.requestAttachment(persistedOutputPath(store), stream)
  await vi.waitFor(() => { expect(readFailuresOf(store)).toHaveLength(1) })
  const opened = readFailuresOf(store)[0]
  if (opened === undefined) {
    throw new Error('the read failure was not persisted')
  }
  expect(opened).toMatchObject({ key: { kind: 'gap', gap: 'read_failed', subject: path }, stream, closed_at: null })
  await first.stop()
  store.close()

  if (scenario === 'available') {
    await writeFile(path, 'recovered output')
  }
  const reopened = home.open()
  const second = runLive(onTestFinished, roots, reopened, startEngine(reopened, { all: true }), readRetry)
  await sleep(200)
  expect(attachmentsOf(reopened)).toEqual([])
  expect(reopened.gaps.get(opened.id)).toEqual(opened)
  second.requestAttachment(persistedOutputPath(reopened), stream)
  if (scenario === 'still missing') {
    await sleep(300)
    expect(attachmentsOf(reopened)).toEqual([])
    expect(reopened.gaps.get(opened.id)).toEqual(opened)
    await writeFile(path, 'recovered output')
  }
  await vi.waitFor(() => {
    expect(attachmentsOf(reopened).map(({ payload }) => payload)).toEqual(['recovered output'])
    expect(reopened.gaps.get(opened.id)).toEqual({
      ...opened,
      closed_at: expect.any(BigInt) as unknown,
      change_seq: expect.any(Number) as unknown,
    })
  })
  const closed = reopened.gaps.get(opened.id)
  expect(closed?.closed_at).toBeGreaterThanOrEqual(opened.detected_at)
  expect(readFailuresOf(reopened)).toEqual([closed])
})
