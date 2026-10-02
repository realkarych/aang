import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexAdapter } from '@aang/adapter-codex'
import { createCollector } from '@aang/collector'
import { ChangeSeq, type CollectedRecord, Config } from '@aang/contract'
import { openStore } from '@aang/store'
import { expect, test, vi } from 'vitest'

test.for(['archived', 'still missing', 'replaced'] as const)('a persisted source_lost episode survives restart when the source is %s', async (scenario, { onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'aang-recovery-'))
  const home = join(root, 'home')
  const codex = join(root, 'codex')
  const active = join(codex, 'sessions')
  const archive = join(codex, 'archived_sessions')
  const path = join(active, 'rollout.jsonl')
  const restored = join(archive, 'restored.jsonl')
  await mkdir(active, { recursive: true })
  await mkdir(archive, { recursive: true })
  const lines = [
    JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', ordinal: 0, type: 'session_meta', payload: { id: 'original' } }),
    JSON.stringify({ timestamp: '2026-10-01T10:00:01Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started' } }),
  ]
  const contents = `${lines.join('\n')}\n`
  await writeFile(path, contents)
  let store = openStore({ home })
  const stops: (() => Promise<void>)[] = []
  onTestFinished(async () => {
    for (const stop of stops.reverse()) {
      await stop()
    }
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const savedGaps = () => store.changes.after(ChangeSeq.parse(0), 100).flatMap((change) => change.layer === 'gap' ? [change.gap] : [])
  const start = () => {
    const options = {
      spool: join(home, 'spool'),
      runtimeRoots: { claude: join(root, 'claude'), codex },
      config: Config.parse({ collector: { fsWatch: false, rootsScanIntervalMs: 50 } }),
      adapters: new Map([['codex' as const, codexAdapter]]),
      openGaps: savedGaps().filter((gap) => gap.closed_at === null),
    }
    const collector = createCollector(options)
    const records: CollectedRecord[] = []
    let failure: { error: unknown } | null = null
    const pumping = (async () => {
      for await (const batch of collector.start(store.cursors.list())) {
        store.transaction((transaction) => {
          for (const cursor of batch.cursors) {
            if (cursor.stream !== null) {
              transaction.scopes.decide({ stream: cursor.stream, runtime: 'codex', scope: 'watched' })
            }
            transaction.cursors.save(cursor)
          }
          for (const gap of batch.gaps) {
            transaction.gaps.save({ ...gap, run: null, session: null })
          }
        })
        records.push(...batch.records)
        await collector.ack(batch)
      }
    })().catch((error: unknown) => { failure = { error } })
    const stop = async () => {
      await collector.close()
      await pumping
      if (failure !== null) {
        throw failure.error
      }
    }
    stops.push(stop)
    return { records, stop }
  }
  const first = start()
  await vi.waitFor(() => {
    expect(first.records).toHaveLength(2)
  })
  await rename(path, join(root, 'removed.jsonl'))
  if (scenario === 'replaced') {
    await writeFile(path, contents.replaceAll('original', 'replacement'))
  }
  await vi.waitFor(() => {
    expect(savedGaps()).toHaveLength(1)
    if (scenario === 'replaced') {
      expect(first.records).toHaveLength(4)
    }
  })
  const [lost] = savedGaps()
  expect(lost).toMatchObject({ kind: 'source_lost', stream: 'codex:original:original', closed_at: null })
  await first.stop()
  store.close()
  const restore = async () => {
    await writeFile(restored, contents)
    const old = new Date(Date.now() - 30 * 86_400_000)
    await utimes(restored, old, old)
  }
  if (scenario !== 'still missing') {
    await restore()
  }
  store = openStore({ home })
  const second = start()
  if (scenario === 'still missing') {
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(savedGaps()).toEqual([lost])
    await restore()
  }
  await vi.waitFor(() => {
    expect(second.records.map(({ payload }) => payload)).toEqual(lines)
    expect(savedGaps()).toEqual([{ ...lost, closed_at: expect.any(BigInt) as unknown, change_seq: expect.any(Number) as unknown }])
  }, { timeout: 5_000 })
  expect(savedGaps()[0]?.closed_at).toBeGreaterThanOrEqual(lost?.detected_at ?? 0n)
  await second.stop()
})
