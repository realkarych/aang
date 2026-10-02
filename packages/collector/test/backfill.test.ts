import { appendFile, utimes } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import { createSandbox, daysAgo, runCollector, sleep } from './sandbox.js'
import { sessions, writeSession } from './sessions.js'

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
