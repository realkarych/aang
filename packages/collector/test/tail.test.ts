import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CollectedRecord, type FileCursor, type StreamKey } from '@aang/contract'
import { expect, test, vi } from 'vitest'
import { createSandbox, holdExclusively, runCollector, type Sandbox, sleep } from './sandbox.js'

const transcriptPath = (sandbox: Sandbox, name = 'session-1'): string =>
  join(sandbox.claude, 'projects', '-work-proj', `${name}.jsonl`)

const rolloutPath = (sandbox: Sandbox, name: string, archived = false): string =>
  archived
    ? join(sandbox.codex, 'archived_sessions', `${name}.jsonl`)
    : join(sandbox.codex, 'sessions', '2026', '10', '01', `${name}.jsonl`)

const writeLines = async (path: string, content: string | Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

const line = (index: number, text = 'строка'): string => JSON.stringify({ uuid: `u-${String(index)}`, text: `${text} ${String(index)}` })

const lines = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, index) => line(from + index))

test('lines appended to a transcript are collected once and in order with their positions and cursor', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = transcriptPath(sandbox)
  await writeLines(path, `${line(1)}\n\n${line(2)}\n`)
  const running = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([line(1), line(2)])
  })
  const firstMtime = (await stat(path, { bigint: true })).mtimeNs

  await mkdir(join(dirname(path), 'not-a-file.jsonl'))
  await appendFile(path, `${line(3)}\n${line(4)}\n`)
  await vi.waitFor(
    () => {
      expect(running.payloads()).toEqual([line(1), line(2), line(3), line(4)])
    },
    { timeout: 10_000 },
  )
  const stats = await stat(path, { bigint: true })

  const offsetOf = (index: number): number => [line(1), '', line(2), line(3)].slice(0, index).reduce((sum, text) => sum + Buffer.byteLength(text) + 1, 0)
  expect(running.records()).toEqual([
    { line: 1, offset: offsetOf(0), observed: firstMtime },
    { line: 3, offset: offsetOf(2), observed: firstMtime },
    { line: 4, offset: offsetOf(3), observed: stats.mtimeNs },
    { line: 5, offset: offsetOf(4), observed: stats.mtimeNs },
  ].map(({ line: number, offset, observed }, index) => ({
    channel: 'transcript',
    runtime: 'claude',
    stream: null,
    position: { kind: 'line', path, offset, line: number },
    hook: null,
    observed_at: observed,
    payload: line(index + 1),
  })))
  for (const record of running.records()) {
    expect(CollectedRecord.parse(record)).toEqual(record)
  }
  expect(running.cursor(path)).toEqual({
    path,
    dev: stats.dev,
    ino: stats.ino,
    stream: null,
    offset: Number(stats.size),
    line: 5,
    size: Number(stats.size),
    last_ordinal: null,
  })
})

test('an incomplete last line waits for its end, a multibyte character split between writes stays intact and CRLF is accepted', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = transcriptPath(sandbox)
  const split = Buffer.from(`${line(2, 'ракета 🚀 полетела')}\r\n`, 'utf8')
  const cut = split.indexOf(Buffer.from('🚀', 'utf8')) + 2
  await writeLines(path, Buffer.concat([Buffer.from(`${line(1)}\r\n`, 'utf8'), split.subarray(0, cut)]))
  const running = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([line(1)])
  })
  await sleep(200)
  expect(running.payloads()).toEqual([line(1)])

  await appendFile(path, split.subarray(cut))
  await vi.waitFor(
    () => {
      expect(running.payloads()).toEqual([line(1), line(2, 'ракета 🚀 полетела')])
    },
    { timeout: 10_000 },
  )
  expect(running.records()[1]?.position).toEqual({
    kind: 'line',
    path,
    offset: Buffer.byteLength(`${line(1)}\r\n`),
    line: 2,
  })
  expect(running.cursor(path)).toMatchObject({ offset: Buffer.byteLength(`${line(1)}\r\n`) + split.length, line: 2 })
})

test('a restart from the last cursor neither loses nor repeats lines', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = transcriptPath(sandbox)
  const stream = 'claude:session-1:main' as StreamKey
  const sixth = line(6)
  await writeLines(path, `${lines(1, 3).join('\n')}\n${sixth.slice(0, 10)}`)
  const first = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(first.payloads()).toEqual(lines(1, 3))
  })
  const saved = first.cursor(path)
  await first.close()
  expect(saved).toMatchObject({ line: 3, offset: Buffer.byteLength(`${lines(1, 3).join('\n')}\n`) })

  await appendFile(path, `${sixth.slice(10)}\n${lines(7, 8).join('\n')}\n${line(9).slice(0, 5)}`)
  const resumed: FileCursor[] = saved === undefined ? [] : [{ ...saved, stream }]
  const second = runCollector(sandbox, { cursors: resumed })
  await vi.waitFor(() => {
    expect(second.payloads()).toEqual([sixth, ...lines(7, 8)])
  })

  expect(second.records().map(({ stream: recordStream, position }) => ({ stream: recordStream, position }))).toEqual(
    [4, 5, 6].map((number, index) => ({
      stream,
      position: {
        kind: 'line',
        path,
        offset: Buffer.byteLength(`${[...lines(1, 3), sixth, ...lines(7, 8)].slice(0, 3 + index).join('\n')}\n`),
        line: number,
      },
    })),
  )
  expect(second.cursor(path)).toMatchObject({ stream, line: 6 })
})

test('with fsWatch off appended lines are read within the scan interval', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = transcriptPath(sandbox)
  const scanIntervalMs = 300
  await writeLines(path, `${line(1)}\n`)
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: scanIntervalMs })
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([line(1)])
  })

  const writtenAt = performance.now()
  await appendFile(path, `${line(2)}\n`)
  await vi.waitFor(
    () => {
      expect(running.payloads()).toEqual([line(1), line(2)])
    },
    { timeout: 3_000, interval: 5 },
  )

  expect((running.arrivalOf((record) => record.payload === line(2)) ?? Infinity) - writtenAt).toBeLessThanOrEqual(
    scanIntervalMs + 1_000,
  )
  await sleep(scanIntervalMs * 3)
  expect(running.payloads()).toEqual([line(1), line(2)])
})

test('500 files are tracked without misses', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const paths = Array.from({ length: 500 }, (_, index) =>
    index % 2 === 0
      ? join(sandbox.claude, 'projects', `-work-p${String(index % 10)}`, `s-${String(index)}`, 'subagents', `agent-${String(index)}.jsonl`)
      : rolloutPath(sandbox, `rollout-${String(index)}`),
  )
  for (const [index, path] of paths.entries()) {
    await writeLines(path, `${JSON.stringify({ ordinal: 0, file: index })}\n`)
  }
  const running = runCollector(sandbox)
  await vi.waitFor(
    () => {
      expect(running.records()).toHaveLength(500)
    },
    { timeout: 20_000 },
  )

  for (const [index, path] of paths.entries()) {
    await appendFile(path, `${JSON.stringify({ ordinal: 1, file: index })}\n`)
  }
  await vi.waitFor(
    () => {
      expect(running.records()).toHaveLength(1_000)
    },
    { timeout: 30_000 },
  )

  const seen = running.records().map(({ position, payload }) => `${position.kind === 'line' ? position.path : ''} ${payload}`)
  expect(new Set(seen).size).toBe(1_000)
  for (const [index, path] of paths.entries()) {
    expect(running.cursor(path)).toMatchObject({ line: 2, last_ordinal: index % 2 === 0 ? null : 1 })
  }
})

test('Codex rollouts in sessions and archived_sessions carry the last ordinal in the cursor', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const live = rolloutPath(sandbox, 'rollout-live')
  const archived = rolloutPath(sandbox, 'rollout-archived', true)
  const rollout = [
    JSON.stringify({ timestamp: '2026-10-01T11:55:58.087Z', ordinal: 0, type: 'session_meta', payload: { id: 't-1' } }),
    JSON.stringify({ timestamp: '2026-10-01T11:55:59.000Z', ordinal: 1, type: 'event_msg', payload: { ordinal: 99 } }),
    '{"not json',
    JSON.stringify({ ordinal: -1 }),
    JSON.stringify([2]),
  ]
  await writeLines(live, `${rollout.join('\n')}\n`)
  await writeLines(archived, `${JSON.stringify({ ordinal: 7 })}\n`)
  const running = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(rollout.length + 1)
  })

  expect(running.records().filter(({ position }) => position.kind === 'line' && position.path === live).map(({ payload }) => payload)).toEqual(rollout)
  expect(new Set(running.records().map(({ channel, runtime }) => `${channel}/${runtime}`))).toEqual(new Set(['rollout/codex']))
  expect(running.cursor(live)).toMatchObject({ line: rollout.length, last_ordinal: 1 })
  expect(running.cursor(archived)).toMatchObject({ line: 1, last_ordinal: 7 })

  await appendFile(live, `${JSON.stringify({ ordinal: 'x' })}\n`)
  await vi.waitFor(
    () => {
      expect(running.cursor(live)).toMatchObject({ line: rollout.length + 1, last_ordinal: 1 })
    },
    { timeout: 10_000 },
  )
})

test('a file replaced at the same path or truncated is read again from its beginning', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = transcriptPath(sandbox)
  await writeLines(path, `${lines(1, 3).join('\n')}\n`)
  const running = runCollector(sandbox, { rootsScanIntervalMs: 300 })
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(lines(1, 3))
  })
  const original = running.cursor(path)

  const replacement = `${path}.next`
  const longLine = line(10, 'заменённый файл с более длинной первой строкой')
  await writeFile(replacement, `${longLine}\n`)
  await rename(replacement, path)
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([...lines(1, 3), longLine])
  })
  const replaced = await stat(path, { bigint: true })
  expect(running.cursor(path)).toMatchObject({ ino: replaced.ino, offset: Buffer.byteLength(`${longLine}\n`), line: 1 })
  expect(running.cursor(path)?.ino).not.toBe(original?.ino)

  await writeFile(path, `${line(20)}\n${line(21).slice(0, 4)}`)
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([...lines(1, 3), longLine, line(20)])
  })
  expect(running.records().at(-1)?.position).toMatchObject({ offset: 0, line: 1 })
})

test('a briefly locked file is read after a retry, a long lock is a read_failed gap closed by the next successful read', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const brief = transcriptPath(sandbox, 'brief')
  const long = transcriptPath(sandbox, 'long')
  await writeLines(brief, `${line(1)}\n`)
  await writeLines(long, `${line(2)}\n`)
  const releaseBrief = await holdExclusively(sandbox, brief)
  const releaseLong = await holdExclusively(sandbox, long)
  const running = runCollector(sandbox, { readRetry: { pauseMs: 50, gapAfterMs: 1_500 } })
  await sleep(150)
  await releaseBrief()

  await vi.waitFor(
    () => {
      expect(running.payloads()).toEqual([line(1)])
    },
    { timeout: 5_000 },
  )
  await vi.waitFor(
    () => {
      expect(running.gaps()).toHaveLength(1)
    },
    { timeout: 10_000 },
  )
  const [opened] = running.gaps()
  expect(opened).toMatchObject({
    key: { kind: 'gap', gap: 'read_failed', subject: long },
    stream: null,
    closed_at: null,
  })
  expect(opened?.details).toMatch(/^E[A-Z]+: /)
  expect(running.payloads()).toEqual([line(1)])

  await releaseLong()
  await vi.waitFor(
    () => {
      expect(running.payloads()).toEqual([line(1), line(2)])
    },
    { timeout: 10_000 },
  )
  const closed = running.gaps()[1]
  expect(closed).toEqual({ ...opened, closed_at: expect.any(BigInt) as unknown })
  expect(closed?.closed_at).toBeGreaterThanOrEqual(opened?.detected_at ?? 0n)
  expect(running.gaps()).toHaveLength(2)
})

test('a backlog larger than a batch and a line longer than a read chunk are delivered whole and exactly once', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const backlog = [1, 2, 3].map((index) => transcriptPath(sandbox, `backlog-${String(index)}`))
  const perFile = 40_000
  for (const path of backlog) {
    await writeLines(path, `${lines(1, perFile).join('\n')}\n`)
  }
  const long = transcriptPath(sandbox, 'long-line')
  const longLine = JSON.stringify({ uuid: 'big', text: 'я'.repeat(1_600_000) })
  await writeLines(long, `${longLine}\n${line(2)}\n`)
  const running = runCollector(sandbox)

  await vi.waitFor(
    () => {
      expect(running.records()).toHaveLength(perFile * backlog.length + 2)
    },
    { timeout: 20_000 },
  )

  for (const path of backlog) {
    const ofFile = running.records().filter(({ position }) => position.kind === 'line' && position.path === path)
    expect(ofFile.map(({ payload }) => payload)).toEqual(lines(1, perFile))
    expect(running.cursor(path)).toMatchObject({ line: perFile, offset: (await stat(path)).size })
  }
  expect(running.records().filter(({ position }) => position.kind === 'line' && position.path === long).map(({ payload }) => payload)).toEqual([longLine, line(2)])
  expect(running.arrivals.length).toBeGreaterThan(backlog.length)
  expect(Math.max(...running.arrivals.map(({ batch }) => batch.records.length))).toBeLessThan(perFile)
})
