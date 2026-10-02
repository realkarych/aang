import { execFile } from 'node:child_process'
import { appendFile, chmod, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { codexAdapter } from '@aang/adapter-codex'
import { createCollector } from '@aang/collector'
import { ChangeSeq, type CollectedRecord, Config, StreamKey } from '@aang/contract'
import { openStore } from '@aang/store'
import { expect, test, vi } from 'vitest'

const setReadable = async (path: string, readable: boolean): Promise<void> => {
  if (process.platform === 'win32') {
    const username = userInfo().username
    await promisify(execFile)('icacls.exe', readable
      ? [path, '/remove:d', username]
      : [path, '/deny', `${username}:(RD)`])
  } else {
    await chmod(path, readable ? 0o600 : 0o200)
  }
}

test.for([
  { operation: 'tail', scenario: 'missing' },
  { operation: 'tail', scenario: 'replaced' },
  { operation: 'rescan', scenario: 'missing' },
  { operation: 'rescan', scenario: 'replaced' },
])('$operation relocation closes the persisted read_failed episode when its old path is $scenario', async ({ operation, scenario }, { onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'aang-read-recovery-'))
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
    JSON.stringify({ timestamp: '2026-10-01T10:00:02Z', ordinal: 2, type: 'event_msg', payload: { type: 'task_complete' } }),
  ] as const
  const contents = `${lines.slice(0, 2).join('\n')}\n`
  await writeFile(path, contents)
  const store = openStore({ home })
  const collector = createCollector({
    spool: join(home, 'spool'),
    runtimeRoots: { claude: join(root, 'claude'), codex },
    config: Config.parse({ collector: { fsWatch: false, rootsScanIntervalMs: 50 } }),
    adapters: new Map([['codex', codexAdapter]]),
    readRetry: { pauseMs: 20, gapAfterMs: 50 },
  })
  const records: CollectedRecord[] = []
  let failure: { error: unknown } | null = null
  const pumping = (async () => {
    for await (const batch of collector.start([])) {
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
  let sourcePath = path
  onTestFinished(async () => {
    await collector.close()
    await pumping
    store.close()
    await setReadable(sourcePath, true)
    await rm(root, { recursive: true, force: true })
    if (failure !== null) {
      throw failure.error
    }
  })
  const savedGaps = () => store.changes.after(ChangeSeq.parse(0), 100).flatMap((change) => change.layer === 'gap' ? [change.gap] : [])
  await vi.waitFor(() => {
    expect(records).toHaveLength(2)
  })
  await setReadable(path, false)
  await appendFile(path, `${lines[2]}\n`)
  if (operation === 'rescan') {
    collector.rescan([StreamKey.parse('codex:original:original')])
  }
  await vi.waitFor(() => {
    expect(savedGaps()).toHaveLength(1)
  }, { timeout: 5_000 })
  const opened = savedGaps()[0]
  if (opened === undefined) {
    throw new Error('the read failure was not persisted')
  }
  expect(opened).toMatchObject({
    key: { kind: 'gap', gap: 'read_failed', subject: path },
    stream: 'codex:original:original',
    closed_at: null,
  })
  const old = new Date(Date.now() - 30 * 86_400_000)
  await utimes(path, old, old)
  await rename(path, restored)
  sourcePath = restored
  if (scenario === 'replaced') {
    await writeFile(path, contents.replaceAll('original', 'replacement'))
    await vi.waitFor(() => {
      expect(records.filter(({ stream }) => stream === 'codex:replacement:replacement')).toHaveLength(2)
      expect(savedGaps().some(({ key }) => key.gap === 'read_failed' && key.subject === opened.stream)).toBe(true)
    }, { timeout: 5_000 })
    expect(store.gaps.get(opened.id)).toEqual(opened)
  }
  await setReadable(restored, true)
  await vi.waitFor(() => {
    expect(records.filter(({ position }) => position.kind === 'line' && position.path === restored).map(({ payload }) => payload)).toEqual(lines)
    expect(store.gaps.get(opened.id)).toEqual({
      ...opened,
      closed_at: expect.any(BigInt) as unknown,
      change_seq: expect.any(Number) as unknown,
    })
    expect(savedGaps().every(({ closed_at }) => closed_at !== null)).toBe(true)
  }, { timeout: 5_000 })
  const closed = store.gaps.get(opened.id)
  if (closed === null) {
    throw new Error('the recovered gap was not persisted')
  }
  expect(closed.closed_at).toBeGreaterThanOrEqual(opened.detected_at)
  expect(closed.change_seq).toBeGreaterThan(opened.change_seq)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(store.gaps.get(opened.id)).toEqual(closed)
})

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
