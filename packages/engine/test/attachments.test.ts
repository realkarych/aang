import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createCollector } from '@aang/collector'
import { Config, type RawRecord, StreamKey } from '@aang/contract'
import { expect, test, vi } from 'vitest'
import { adapters, factsOf, recordsOf, startEngine } from './harness.js'
import { createHome } from './home.js'

test('persisted Bash output is ingested, deduplicated and remains available after source deletion and store restart', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const claude = join(home.path, 'claude')
  const path = join(claude, 'projects', '-work', 'session-1', 'tool-results', 'toolu_bash.txt')
  const transcript = join(claude, 'projects', '-work', 'session-1.jsonl')
  const content = 'Bash output\r\nпроверка 😀\n'.repeat(10_000)
  const stream = StreamKey.parse('["claude","session-1","main"]')
  const line = JSON.stringify({
    type: 'user',
    sessionId: 'session-1',
    uuid: 'result-1',
    cwd: home.path,
    timestamp: '2026-10-01T10:00:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'Bash output' }] },
    toolUseResult: { stdout: 'Bash output', stderr: '', interrupted: false, persistedOutputPath: path },
  })
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  await writeFile(transcript, `${line}\n`)
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
  const fact = factsOf(store).find(({ kind }) => kind === 'action_end')
  if (fact?.kind !== 'action_end' || fact.payload.persisted_output_path === null) {
    throw new Error('the Bash result has no persisted output path')
  }
  collector.requestAttachment(fact.payload.persisted_output_path, stream)
  const attachments = (): RawRecord[] => recordsOf(store).filter(({ position }) => position.kind === 'file')
  await vi.waitFor(() => { expect(attachments()).toHaveLength(1) })
  const saved = attachments()[0]
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
  expect(attachments()).toHaveLength(1)

  await writeFile(path, '{"sessionId":"other-session","type":"user"}')
  collector.requestAttachment(path, stream)
  await vi.waitFor(() => { expect(attachments()).toHaveLength(2) })
  expect(attachments()[1]).toMatchObject({ parse_state: 'parsed', payload: '{"sessionId":"other-session","type":"user"}' })
  await rm(path)
  await stop()
  store.close()
  const reopened = home.open()
  expect(reopened.rawRecords.get(saved.seq)).toEqual(saved)
  expect(recordsOf(reopened).filter(({ position }) => position.kind === 'file')).toHaveLength(2)
})
