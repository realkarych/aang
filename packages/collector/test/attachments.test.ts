import { createHash } from 'node:crypto'
import { mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CollectedRecord, StreamKey } from '@aang/contract'
import { expect, test, vi } from 'vitest'
import { createSandbox, holdExclusively, prepareCollector, runCollector, type Sandbox, sleep } from './sandbox.js'

const stream = StreamKey.parse('["claude","session-1","main"]')
const attachmentPath = (sandbox: Sandbox, name = 'toolu_1.txt'): string =>
  join(sandbox.claude, 'projects', '-Мой проект', 'session-1', 'tool-results', name)

const put = async (path: string, content: string | Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

test('only requested attachments are collected, preserving full text, file hash and stream', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = attachmentPath(sandbox, 'вывод Bash.txt')
  const content = '\uFEFFВывод 😀\r\n'.repeat(100_000)
  await put(path, content)
  await put(attachmentPath(sandbox, 'ignored.txt'), 'not requested')
  await put(attachmentPath(sandbox, 'ignored.meta.json'), '{}')
  await put(attachmentPath(sandbox, 'ignored.jsonl'), '{"sessionId":"session-1"}\n')
  const modified = (await stat(path, { bigint: true })).mtimeNs
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: 30 })
  await sleep(100)
  expect(running.records()).toEqual([])

  running.collector.requestAttachment(path, stream)
  running.collector.requestAttachment(path, stream)
  await vi.waitFor(() => { expect(running.records()).toHaveLength(1) })
  const record = running.records()[0]
  expect(record).toEqual({
    channel: 'transcript',
    runtime: 'claude',
    stream,
    position: { kind: 'file', path, content_hash: createHash('sha256').update(content).digest('hex') },
    hook: null,
    observed_at: modified,
    payload: content,
  })
  expect(CollectedRecord.parse(record)).toEqual(record)
  expect(running.arrivals.flatMap(({ batch }) => batch.cursors)).toEqual([])
  await running.ackAll()
  expect((await stat(path)).isFile()).toBe(true)

  await writeFile(path, '')
  await sleep(100)
  expect(running.records()).toHaveLength(1)
  running.collector.requestAttachment(path, stream)
  await vi.waitFor(() => { expect(running.records()).toHaveLength(2) })
  expect(running.records()[1]).toMatchObject({
    payload: '',
    position: { content_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
  })
  await running.close()
  expect(() => { running.collector.requestAttachment(path, stream) }).toThrow('closed')
})

test.for(['missing', 'locked'] as const)('a %s attachment opens a gap, retries and closes the same gap on recovery', async (scenario, { onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = attachmentPath(sandbox)
  await mkdir(dirname(path), { recursive: true })
  let release = async (): Promise<void> => { await writeFile(path, 'recovered output') }
  if (scenario === 'locked') {
    await writeFile(path, 'recovered output')
    release = await holdExclusively(sandbox, path)
  }
  const running = runCollector(sandbox, {
    fsWatch: false,
    rootsScanIntervalMs: 30,
    readRetry: { pauseMs: 10, gapAfterMs: 30 },
  })
  running.collector.requestAttachment(path, stream)
  await vi.waitFor(() => { expect(running.gaps()).toHaveLength(1) })
  const gap = running.gaps()[0]
  expect(gap).toMatchObject({ key: { kind: 'gap', gap: 'read_failed', subject: path }, stream, closed_at: null })
  expect(running.records()).toEqual([])
  await release()
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(['recovered output'])
    expect(running.gaps()).toHaveLength(2)
  })
  expect(running.gaps()[1]).toEqual({ ...gap, closed_at: expect.any(BigInt) as unknown })
  expect(running.gaps()[1]?.closed_at).toBeGreaterThanOrEqual(gap?.detected_at ?? 0n)
})

test('requests are confined to tool-results files inside the configured Claude projects directory', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const collector = prepareCollector(sandbox, { readRetry: { pauseMs: 10, gapAfterMs: 30 } })
  const paths = [
    'tool-results/result.txt',
    join(sandbox.root, 'tool-results', 'result.txt'),
    join(sandbox.claude, 'projects-other', 'session-1', 'tool-results', 'result.txt'),
    join(sandbox.claude, 'projects', 'session-1.jsonl'),
    join(sandbox.claude, 'projects', '-project', 'session-1', 'tool-results', 'nested', 'result.txt'),
  ]
  for (const path of paths) {
    expect(() => { collector.requestAttachment(path, stream) }).toThrow('tool-results')
  }
  const path = attachmentPath(sandbox)
  const outside = join(sandbox.root, 'outside', 'tool-results')
  await put(join(outside, 'toolu_1.txt'), 'private output')
  await mkdir(dirname(dirname(path)), { recursive: true })
  await symlink(outside, dirname(path), process.platform === 'win32' ? 'junction' : 'dir')
  const running = runCollector(sandbox, { readRetry: { pauseMs: 10, gapAfterMs: 30 } }, collector)
  collector.requestAttachment(path, stream)
  await vi.waitFor(() => { expect(running.gaps()).toHaveLength(1) })
  expect(running.records()).toEqual([])
  await running.close()
  await rm(dirname(path))
  await put(path, 'now inside')
  await sleep(100)
  expect(running.records()).toEqual([])
})

test.for(['directory', 'invalid UTF-8', 'binary'] as const)('a %s attachment is reported as unreadable without corrupting raw text', async (kind, { onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = attachmentPath(sandbox)
  if (kind === 'directory') {
    await mkdir(path, { recursive: true })
  } else {
    await put(path, kind === 'binary' ? Buffer.from([97, 0, 98]) : Buffer.from([0xc3, 0x28]))
  }
  const collector = prepareCollector(sandbox, { readRetry: { pauseMs: 10, gapAfterMs: 30 } })
  collector.requestAttachment(path, stream)
  const running = runCollector(sandbox, {}, collector)
  await vi.waitFor(() => { expect(running.gaps()).toHaveLength(1) })
  expect(running.records()).toEqual([])
  expect(running.gaps()[0]).toMatchObject({ key: { gap: 'read_failed', subject: path }, stream })
})
