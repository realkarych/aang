import { appendFile, mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createSandbox, daysAgo, holdExclusively, runCollector, sleep } from './sandbox.js'
import { sessions, writeSession } from './sessions.js'

test.for(sessions)('$runtime relocation preserves the stream and raw keys, then follows appended lines', async (session, { onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = session.path(sandbox)
  await writeSession(path, session.lines.slice(0, 2))
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50 })
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(session.lines.slice(0, 2))
  })
  expect(running.cursor(path)?.stream).toBe(session.stream)
  const keys = running.records().map((record) => session.adapter.rawKey(record))
  const moved = session.runtime === 'claude'
    ? join(sandbox.claude, 'projects', '-elsewhere', 'session-1.jsonl.superseded-123')
    : join(sandbox.codex, 'archived_sessions', 'rollout-thread-1.jsonl')
  await mkdir(dirname(moved), { recursive: true })
  await utimes(path, daysAgo(30), daysAgo(30))
  await rename(path, moved)
  await vi.waitFor(() => {
    expect(running.cursor(moved)).toMatchObject({ stream: session.stream, line: 2 })
  })
  expect(running.records().slice(2).map((record) => session.adapter.rawKey(record))).toEqual(keys)
  expect(running.gaps()).toEqual([])

  await appendFile(moved, `${session.lines[2]}\n`)
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([...session.lines.slice(0, 2), ...session.lines])
  })
  await sleep(200)
  expect(running.records()).toHaveLength(5)
  expect(running.gaps()).toEqual([])
})

test.for(sessions)('$runtime disappearance emits one source_lost gap and finding the stream closes it', async (session, { onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = session.path(sandbox)
  await writeSession(path, session.lines)
  const first = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(first.payloads()).toEqual(session.lines)
  })
  const saved = first.cursor(path)
  expect(saved).toBeDefined()
  await first.close()
  await rm(path)

  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50, cursors: saved === undefined ? [] : [saved] })
  await vi.waitFor(() => {
    expect(running.gaps()).toHaveLength(1)
  })
  const [lost] = running.gaps()
  expect(lost).toMatchObject({ key: { kind: 'gap', gap: 'source_lost' }, stream: session.stream, closed_at: null })
  await sleep(200)
  expect(running.gaps()).toHaveLength(1)

  const restored = session.runtime === 'claude'
    ? join(sandbox.claude, 'projects', '-restored', 'session-1.orphaned-123-suffix.jsonl')
    : join(sandbox.codex, 'archived_sessions', 'restored.jsonl')
  await writeSession(restored, session.lines)
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(session.lines)
    expect(running.gaps()).toHaveLength(2)
  })
  expect(running.gaps()[1]).toEqual({ ...lost, closed_at: expect.any(BigInt) as unknown })
  await sleep(200)
  expect(running.records()).toHaveLength(3)
  expect(running.gaps()).toHaveLength(2)
})

test('a replacement belonging to another stream does not hide the loss of the original stream', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const session = sessions[0]
  const path = session.path(sandbox)
  await writeSession(path, session.lines)
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50 })
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(session.lines)
  })
  const replacement = session.lines.map((line) => line.replaceAll('session-1', 'session-2'))
  await writeSession(`${path}.next`, replacement)
  await rename(`${path}.next`, path)
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([...session.lines, ...replacement])
    expect(running.gaps()).toHaveLength(1)
  })
  expect(running.gaps()[0]).toMatchObject({ key: { gap: 'source_lost' }, stream: session.stream })
  expect(running.records().slice(3).map(({ stream }) => stream)).toEqual(Array(3).fill('["claude","session-2","main"]'))
})

test('shrinking an unfinished suffix below the last observed size rereads the stream even above the committed offset', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const session = sessions[0]
  const path = session.path(sandbox)
  await writeSession(path, session.lines.slice(0, 1))
  await appendFile(path, ' '.repeat(1_000))
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50 })
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(1)
  })
  await writeFile(path, `${session.lines[0]}\n `)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(2)
  })
  expect(running.payloads()).toEqual([session.lines[0], session.lines[0]])
  expect(running.gaps()).toEqual([])
})

test.for(sessions)('$runtime restart locates an old moved stream and does not confuse its stored paths with lost sources', async (session, { onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = session.path(sandbox)
  await writeSession(path, session.lines)
  const first = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(first.records()).toHaveLength(3)
  })
  const original = first.cursor(path)
  await first.close()
  const destination = session.runtime === 'claude'
    ? join(sandbox.claude, 'projects', '-other', 'arbitrary-name.jsonl')
    : join(sandbox.codex, 'archived_sessions', 'arbitrary-name.jsonl')
  await mkdir(dirname(destination), { recursive: true })
  await utimes(path, daysAgo(30), daysAgo(30))
  await rename(path, destination)
  const second = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50, cursors: original === undefined ? [] : [original] })
  await vi.waitFor(() => {
    expect(second.payloads()).toEqual(session.lines)
  })
  expect(second.cursor(destination)?.stream).toBe(session.stream)
  expect(second.gaps()).toEqual([])
  const moved = second.cursor(destination)
  await second.close()
  const third = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50, cursors: [original, moved].filter((cursor) => cursor !== undefined) })
  await vi.waitFor(() => {
    expect(third.cursor(destination)).toMatchObject({ stream: session.stream, line: 3 })
  })
  expect(third.gaps()).toEqual([])
  const beforeAppend = third.records().length
  await appendFile(destination, `${session.lines[2]}\n`)
  await vi.waitFor(() => {
    expect(third.records()).toHaveLength(beforeAppend + 1)
    expect(third.cursor(destination)?.line).toBe(4)
  })
  expect(third.gaps()).toEqual([])
})

test('a locked relocation candidate delays source_lost and is retried until it can be identified', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const session = sessions[1]
  const path = session.path(sandbox)
  await writeSession(path, session.lines)
  const first = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(first.records()).toHaveLength(3)
  })
  const saved = first.cursor(path)
  await first.close()
  const destination = join(sandbox.codex, 'archived_sessions', 'locked.jsonl')
  await mkdir(dirname(destination), { recursive: true })
  await rename(path, destination)
  await utimes(destination, daysAgo(30), daysAgo(30))
  const release = await holdExclusively(sandbox, destination)
  const running = runCollector(sandbox, {
    fsWatch: false,
    rootsScanIntervalMs: 60_000,
    readRetry: { pauseMs: 20, gapAfterMs: 100 },
    cursors: saved === undefined ? [] : [saved],
  })
  await vi.waitFor(() => {
    expect(running.gaps().some(({ key }) => key.gap === 'read_failed')).toBe(true)
  })
  expect(running.gaps().some(({ key }) => key.gap === 'source_lost')).toBe(false)
  await release()
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(session.lines)
  }, { timeout: 5_000 })
  await vi.waitFor(() => {
    expect(running.gaps().filter(({ closed_at }) => closed_at !== null)).toHaveLength(
      running.gaps().filter(({ closed_at }) => closed_at === null).length,
    )
  })
})

test('rescan does not hide a stream replaced at the same path', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const session = sessions[0]
  const path = session.path(sandbox)
  await writeSession(path, session.lines)
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 60_000 })
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(3)
  })
  await writeSession(`${path}.next`, session.lines.map((line) => line.replaceAll('session-1', 'other')))
  await rename(`${path}.next`, path)
  running.collector.rescan([session.stream])
  await vi.waitFor(() => {
    expect(running.gaps()).toHaveLength(1)
  })
  expect(running.gaps()[0]).toMatchObject({ key: { gap: 'source_lost' }, stream: session.stream })
})

test('a truncated backlog is reread from the beginning when restarting between batches', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const session = sessions[0]
  const path = session.path(sandbox)
  const lines = Array.from({ length: 20_000 }, (_, index) => JSON.stringify({ sessionId: 'session-1', uuid: `message-${String(index)}` }))
  await writeSession(path, lines)
  const first = runCollector(sandbox, { fsWatch: false })
  await vi.waitFor(() => {
    expect(first.records()).toHaveLength(lines.length)
  }, { timeout: 10_000 })
  const saved = first.arrivals[0]?.batch.cursors.find((cursor) => cursor.path === path)
  expect(saved?.line).toBe(4096)
  await first.close()
  await writeSession(path, lines.slice(0, 5_000))
  const second = runCollector(sandbox, { fsWatch: false, cursors: saved === undefined ? [] : [saved] })
  await vi.waitFor(() => {
    expect(second.payloads()).toEqual(lines.slice(0, 5_000))
  }, { timeout: 5_000 })
  expect(second.gaps()).toEqual([])
})

test('watch notifications close a source_lost gap as soon as the stream reappears', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const session = sessions[0]
  const path = session.path(sandbox)
  await writeSession(path, session.lines)
  const running = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(3)
  })
  await rm(path)
  await vi.waitFor(() => {
    expect(running.gaps()).toHaveLength(1)
  }, { timeout: 5_000 })
  await writeSession(path, session.lines)
  await vi.waitFor(() => {
    expect(running.gaps()).toHaveLength(2)
  }, { timeout: 5_000 })
  expect(running.gaps()[1]?.closed_at).not.toBeNull()
})
