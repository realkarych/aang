import { appendFile, mkdir, readdir, rename, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createSandbox, daysAgo, preventListing, runCollector, sleep } from './sandbox.js'
import { sessions, writeSession } from './sessions.js'

test('periodic discovery reads healthy sources while a sibling directory cannot be listed', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const session = sessions[1]
  const blocked = join(sandbox.codex, 'sessions', 'blocked')
  await mkdir(blocked, { recursive: true })
  const release = await preventListing(sandbox, blocked)
  await expect(readdir(blocked)).rejects.toThrow()
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50 })
  await writeSession(session.path(sandbox), session.lines)
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(session.lines)
  }, { timeout: 5_000 })
  await release()
  await sleep(200)
  expect(running.payloads()).toEqual(session.lines)
})

test('backfill skips files outside lookback until they are modified, while saved cursors ignore age', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const session = sessions[0]
  const path = session.path(sandbox)
  const recent = `${path}-recent.jsonl`
  await writeSession(path, session.lines.slice(0, 2))
  await utimes(path, daysAgo(3), daysAgo(3))
  await writeSession(recent, ['{"uuid":"recent"}'])
  const first = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50, lookbackDays: 2 })
  await vi.waitFor(() => {
    expect(first.payloads()).toContain('{"uuid":"recent"}')
  })
  await sleep(200)
  expect(first.payloads()).toEqual(['{"uuid":"recent"}'])
  expect(first.cursor(path)).toBeUndefined()

  await appendFile(path, `${session.lines[2]}\n`)
  await vi.waitFor(() => {
    expect(first.records()).toHaveLength(4)
  })
  expect(first.payloads().slice(1)).toEqual(session.lines)
  const saved = first.cursor(path)
  const recentCursor = first.cursor(recent)
  await first.close()
  await appendFile(path, `${session.lines[2]}\n`)
  await utimes(path, daysAgo(30), daysAgo(30))
  const second = runCollector(sandbox, { fsWatch: false, cursors: [saved, recentCursor].filter((cursor) => cursor !== undefined) })
  await vi.waitFor(() => {
    expect(second.payloads()).toEqual([session.lines[2]])
  })
  expect(second.records()[0]?.position).toMatchObject({ line: 4, offset: saved?.offset })
})

test('rescan rereads only requested streams from the beginning and resets line positions and ordinals', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  for (const session of sessions) {
    await writeSession(session.path(sandbox), session.lines)
  }
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 60_000 })
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(6)
  })
  const session = sessions[1]
  await utimes(session.path(sandbox), daysAgo(30), daysAgo(30))
  running.collector.rescan([session.stream])
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(9)
  })
  const replayed = running.records().slice(6)
  expect(replayed.map(({ payload }) => payload)).toEqual(session.lines)
  expect(replayed.map(({ stream }) => stream)).toEqual(Array(3).fill(session.stream))
  expect(replayed.map(({ position }) => position.kind === 'line' ? position.line : null)).toEqual([1, 2, 3])
  expect(running.cursor(session.path(sandbox))).toMatchObject({ line: 3, last_ordinal: 2 })
  await appendFile(session.path(sandbox), `${session.lines[2]}\n`)
  running.collector.rescan([session.stream])
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(13)
  })
  expect(running.records().slice(9).map(({ payload }) => payload)).toEqual([...session.lines, session.lines[2]])
})

test('rescan with a lookback rereads only the requested files modified within it', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  for (const session of sessions) {
    await writeSession(session.path(sandbox), session.lines)
  }
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 60_000 })
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(6)
  })
  const [fresh, stale] = sessions
  await utimes(stale.path(sandbox), daysAgo(30), daysAgo(30))
  running.collector.rescan([fresh.stream, stale.stream], 7)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(9)
  })
  await sleep(200)
  const replayed = running.records().slice(6)
  expect(replayed).toHaveLength(3)
  expect(replayed.map(({ payload }) => payload)).toEqual(fresh.lines)
  expect(replayed.map(({ position }) => position.kind === 'line' ? position.line : null)).toEqual([1, 2, 3])
})

interface Transcript {
  readonly path: string
  readonly lines: readonly string[]
}

test('backfill reads files without a cursor modified within its lookback and keeps the collector lookback', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const transcript = (name: string): Transcript => ({
    path: join(sandbox.claude, 'projects', '-project', `${name}.jsonl`),
    lines: [JSON.stringify({ type: 'user', sessionId: name, uuid: `${name}-1`, message: { role: 'user', content: name } })],
  })
  const place = async ({ path, lines }: Transcript, age: number): Promise<void> => {
    const staging = join(sandbox.root, 'staging.jsonl')
    await writeSession(staging, lines)
    await utimes(staging, daysAgo(age), daysAgo(age))
    await mkdir(dirname(path), { recursive: true })
    await rename(staging, path)
  }
  const fresh = transcript('fresh')
  const recent = transcript('recent')
  const old = transcript('old')
  const later = transcript('later')
  await place(fresh, 0)
  await place(recent, 20)
  await place(old, 40)
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50, lookbackDays: 7 })
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(fresh.lines)
  })
  await sleep(200)
  expect(running.payloads()).toEqual(fresh.lines)

  await utimes(fresh.path, daysAgo(20), daysAgo(20))
  running.collector.backfill(30)
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([...fresh.lines, ...recent.lines])
  })
  expect(running.cursor(recent.path)).toMatchObject({ offset: Buffer.byteLength(`${recent.lines.join('\n')}\n`), line: 1 })
  await place(later, 20)
  await sleep(300)
  expect(running.payloads()).toEqual([...fresh.lines, ...recent.lines])
  expect(running.cursor(old.path)).toBeUndefined()
  expect(running.cursor(later.path)).toBeUndefined()
})
