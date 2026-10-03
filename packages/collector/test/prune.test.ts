import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { prefixHash } from '@aang/collector'
import { type FileCursor, PruneBoundary } from '@aang/contract'
import { contentHash } from '@aang/contract/ids'
import { expect, test, vi } from 'vitest'
import { createSandbox, runCollector, type Sandbox, sleep } from './sandbox.js'
import { sessions, writeSession } from './sessions.js'

const [claude, codex] = sessions

const prunedAt = (): bigint => BigInt(Date.now()) * 1_000_000n

type ClaudeBoundary = Extract<PruneBoundary, { readonly runtime: 'claude' }>

const claudeBoundary = async (cursor: FileCursor | undefined): Promise<ClaudeBoundary> => {
  const boundary = PruneBoundary.parse({
    runtime: 'claude',
    stream: claude.stream,
    session: 'session-1',
    offset: cursor?.offset,
    prefix_hash: cursor === undefined ? null : await prefixHash(cursor.path, cursor.offset),
    pruned_at: prunedAt(),
  })
  if (boundary.runtime !== 'claude') {
    throw new Error('a Claude boundary was expected')
  }
  return boundary
}

const destinations = [
  { name: 'another project', path: (sandbox: Sandbox): string => join(sandbox.claude, 'projects', '-elsewhere', 'session-1.jsonl') },
  {
    name: 'a superseded copy',
    path: (sandbox: Sandbox): string => join(sandbox.claude, 'projects', '-project', 'session-1.jsonl.superseded-123'),
  },
]

const restarts = destinations.flatMap((destination) => [
  { ...destination, cursors: 'the original cursor' },
  { ...destination, cursors: 'no cursors' },
])

const lines = (values: readonly string[]): string => values.map((value) => `${value}\n`).join('')

test('prefixHash hashes the leading bytes of a file like contentHash and is null for a shorter or missing file', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = join(sandbox.root, 'large.jsonl')
  await writeFile(path, lines(Array.from({ length: 3 }, (_, index) => 'x'.repeat(1024 ** 2 + index))))
  const bytes = await readFile(path)
  expect(await prefixHash(path, 0)).toBe(contentHash(''))
  expect(await prefixHash(path, 10)).toBe(contentHash(bytes.subarray(0, 10)))
  expect(await prefixHash(path, bytes.length)).toBe(contentHash(bytes))
  expect(await prefixHash(path, bytes.length + 1)).toBeNull()
  expect(await prefixHash(join(sandbox.root, 'missing.jsonl'), 0)).toBeNull()
})

test.for(destinations)('a pruned Claude stream moved to $name resumes after the boundary with the original numbering', async (destination, { onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = claude.path(sandbox)
  await writeSession(path, claude.lines.slice(0, 2))
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50 })
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(claude.lines.slice(0, 2))
  })
  const boundary = await claudeBoundary(running.cursor(path))
  running.collector.prune([boundary])
  const moved = destination.path(sandbox)
  await mkdir(dirname(moved), { recursive: true })
  await rename(path, moved)
  await vi.waitFor(() => {
    expect(running.cursor(moved)).toMatchObject({ stream: claude.stream, offset: boundary.offset, line: 2 })
  })
  await appendFile(moved, lines([claude.lines[2]]))
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(claude.lines)
  })
  expect(running.records()[2]?.position).toEqual({ kind: 'line', path: moved, offset: boundary.offset, line: 3 })
  await sleep(200)
  expect(running.records()).toHaveLength(3)
  expect(running.gaps()).toEqual([])
})

test.for(restarts)('after a restart with $cursors, a pruned Claude stream moved to $name yields only lines after the boundary', async (restart, { onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = claude.path(sandbox)
  await writeSession(path, claude.lines.slice(0, 2))
  const first = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50 })
  await vi.waitFor(() => {
    expect(first.records()).toHaveLength(2)
  })
  const original = first.cursor(path)
  await first.close()
  const boundary = await claudeBoundary(original)
  const moved = restart.path(sandbox)
  await mkdir(dirname(moved), { recursive: true })
  await rename(path, moved)
  await appendFile(moved, lines([claude.lines[2]]))

  const second = runCollector(sandbox, {
    fsWatch: false,
    rootsScanIntervalMs: 50,
    prunedStreams: [boundary],
    cursors: restart.cursors === 'no cursors' || original === undefined ? [] : [original],
  })
  await vi.waitFor(() => {
    expect(second.payloads()).toEqual([claude.lines[2]])
  })
  expect(second.records()[0]?.position).toEqual({ kind: 'line', path: moved, offset: boundary.offset, line: 3 })
  await sleep(200)
  expect(second.records()).toHaveLength(1)
  expect(second.gaps()).toEqual([])
})

test.for(['replaced', 'shrunk'] as const)('a pruned Claude stream %s in place stops with one gap and yields no records', async (change, { onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = claude.path(sandbox)
  await writeSession(path, claude.lines)
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50 })
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(3)
  })
  const boundary = await claudeBoundary(running.cursor(path))
  running.collector.prune([boundary])
  if (change === 'replaced') {
    await writeSession(`${path}.next`, claude.lines.map((line) => line.replaceAll('Hello', 'Howdy')))
    await rename(`${path}.next`, path)
  } else {
    await writeSession(path, claude.lines.slice(0, 1))
  }
  await vi.waitFor(() => {
    expect(running.gaps()).toHaveLength(1)
  })
  expect(running.gaps()[0]).toMatchObject({
    key: { kind: 'gap', gap: 'stream_changed_after_prune', subject: claude.stream },
    stream: claude.stream,
    closed_at: null,
  })
  expect(running.cursor(path)).toMatchObject({ stream: claude.stream, offset: 0, line: 0 })

  await appendFile(path, lines([claude.lines[2], claude.lines[1], claude.lines[2]]))
  const { size } = await stat(path)
  await vi.waitFor(() => {
    expect(running.cursor(path)).toMatchObject({ offset: 0, line: 0, size })
  })
  await sleep(200)
  expect(running.records()).toHaveLength(3)
  expect(running.gaps()).toHaveLength(1)
  const stopped = running.cursor(path)
  const gaps = running.gaps()
  await running.close()

  const restarted = runCollector(sandbox, {
    fsWatch: false,
    rootsScanIntervalMs: 50,
    prunedStreams: [boundary],
    openGaps: gaps,
    cursors: stopped === undefined ? [] : [stopped],
  })
  await vi.waitFor(() => {
    expect(restarted.cursor(path)).toMatchObject({ offset: 0, line: 0, size })
  })
  await sleep(200)
  expect(restarted.records()).toEqual([])
  expect(restarted.gaps()).toEqual([])
})

test('a pruned Codex stream archived after the prune yields only lines above the boundary ordinal', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = codex.path(sandbox)
  const unordered = (type: string): string =>
    JSON.stringify({ timestamp: '2026-10-01T10:00:03Z', type: 'event_msg', payload: { type } })
  const kept = [...codex.lines.slice(0, 2), unordered('token_count')]
  const appended = [codex.lines[2], unordered('agent_message')]
  await writeSession(path, kept)
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50 })
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(kept)
  })
  const boundary = PruneBoundary.parse({
    runtime: 'codex',
    stream: codex.stream,
    session: 'thread-1',
    last_ordinal: running.cursor(path)?.last_ordinal,
    pruned_at: prunedAt(),
  })
  running.collector.prune([boundary])
  const archived = join(sandbox.codex, 'archived_sessions', 'rollout-thread-1.jsonl')
  await mkdir(dirname(archived), { recursive: true })
  await rename(path, archived)
  await appendFile(archived, lines(appended))
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([...kept, ...appended])
  })
  expect(running.records().slice(3).map(({ position }) => position)).toEqual([
    expect.objectContaining({ path: archived, line: 4 }),
    expect.objectContaining({ path: archived, line: 5 }),
  ])
  expect(running.cursor(archived)).toMatchObject({ line: 5, last_ordinal: 2 })
  await sleep(200)
  expect(running.records()).toHaveLength(5)
  await running.close()

  const restarted = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 50, prunedStreams: [boundary] })
  await vi.waitFor(() => {
    expect(restarted.payloads()).toEqual(appended)
  })
  expect(restarted.records().map(({ position }) => position.kind === 'line' ? position.line : null)).toEqual([4, 5])
  expect(restarted.gaps()).toEqual([])
})
