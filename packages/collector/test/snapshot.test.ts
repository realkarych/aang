import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CollectedRecord, type CollectedPosition } from '@aang/contract'
import { expect, test, vi } from 'vitest'
import { createSandbox, holdExclusively, runCollector, type Running, type Sandbox, sleep } from './sandbox.js'

const samples = join(import.meta.dirname, '..', '..', '..', 'docs', 'research', 'samples', 'claude-code-transcripts')

const epochNow = (): bigint => BigInt(Date.now()) * 1_000_000n

const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex')

const put = async (path: string, content: string | Buffer): Promise<bigint> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return (await stat(path, { bigint: true })).mtimeNs
}

const registryPath = (sandbox: Sandbox, file: string): string => join(sandbox.claude, 'sessions', file)

const projectPath = (sandbox: Sandbox, ...segments: string[]): string =>
  join(sandbox.claude, 'projects', '-work-proj', ...segments)

const snapshot = (
  channel: 'registry' | 'transcript',
  path: string,
  content: string,
  observedAt: bigint,
): CollectedRecord => ({
  channel,
  runtime: 'claude',
  stream: null,
  position: { kind: 'file', path, content_hash: sha256(content) } as CollectedPosition,
  hook: null,
  observed_at: observedAt as CollectedRecord['observed_at'],
  payload: content,
})

const removal = (channel: 'registry' | 'transcript', path: string, lastContent: string): CollectedRecord => ({
  channel,
  runtime: 'claude',
  stream: null,
  position: { kind: 'file_removed', path, last_content_hash: sha256(lastContent) } as CollectedPosition,
  hook: null,
  observed_at: expect.any(BigInt) as CollectedRecord['observed_at'],
  payload: '',
})

const ofPath = (running: Running, path: string): CollectedRecord[] =>
  running.records().filter(({ position }) => position.kind !== 'spool' && position.kind !== 'otel' && position.path === path)

interface RegistryEvent {
  readonly event: string
  readonly file?: string
  readonly pid?: number
  readonly sessionId?: string
  readonly kind?: string
  readonly entrypoint?: string
  readonly status?: string | null
  readonly statusUpdatedAt?: number | null
}

test('the registry sequence restored from the observed lifecycle is issued in order without repeats, with removals', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const template = JSON.parse(await readFile(join(samples, 'sessions-registry-pid-at-start.json'), 'utf8')) as Record<string, unknown>
  const events = (await readFile(join(samples, 'sessions-registry-lifecycle-observed.jsonl'), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RegistryEvent)
    .filter(({ event }) => event.startsWith('session_registry_'))
  const contentOf = ({ pid, sessionId, kind, entrypoint, status, statusUpdatedAt }: RegistryEvent): string =>
    JSON.stringify({
      ...template,
      pid,
      sessionId,
      kind,
      entrypoint,
      messagingSocketPath: `/tmp/cc-socks/${String(pid)}.sock`,
      ...(status === null || status === undefined ? {} : { status, statusUpdatedAt, updatedAt: statusUpdatedAt }),
    })
  const scanIntervalMs = 250
  await mkdir(join(sandbox.claude, 'sessions'), { recursive: true })
  const running = runCollector(sandbox, { rootsScanIntervalMs: scanIntervalMs })
  await sleep(scanIntervalMs)

  const expected: CollectedRecord[] = []
  const current = new Map<string, string>()
  for (const event of events) {
    const path = registryPath(sandbox, event.file ?? '')
    const previous = current.get(path)
    if (event.event === 'session_registry_gone') {
      const removedFrom = epochNow()
      await rm(path)
      current.delete(path)
      expected.push(removal('registry', path, previous ?? ''))
      await vi.waitFor(() => {
        expect(running.records()).toHaveLength(expected.length)
      })
      const observed = running.records().at(-1)?.observed_at ?? 0n
      expect(observed).toBeGreaterThanOrEqual(removedFrom)
      expect(observed).toBeLessThanOrEqual(epochNow())
      continue
    }
    const content = contentOf(event)
    const modifiedAt = await put(path, content)
    current.set(path, content)
    if (content !== previous) {
      expected.push(snapshot('registry', path, content, modifiedAt))
      await vi.waitFor(() => {
        expect(running.records()).toHaveLength(expected.length)
      })
    }
  }
  await sleep(scanIntervalMs * 4)

  expect(expected.filter(({ position }) => position.kind === 'file')).toHaveLength(20)
  expect(expected.filter(({ position }) => position.kind === 'file_removed')).toHaveLength(8)
  expect(running.records()).toEqual(expected)
  for (const record of running.records()) {
    expect(CollectedRecord.parse(record)).toEqual(record)
  }
  expect(running.gaps()).toEqual([])
  expect(running.arrivals.flatMap(({ batch }) => batch.cursors)).toEqual([])
})

test('subagent meta, workflow and team files are snapshots of the transcript channel, other JSON files are not collected', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const meta = projectPath(sandbox, 'session-1', 'subagents', 'agent-aad616394e806288d.meta.json')
  const workflowMeta = projectPath(sandbox, 'session-1', 'subagents', 'workflows', 'wf_1', 'agent-b.meta.json')
  const workflow = projectPath(sandbox, 'session-1', 'workflows', 'wf_1.json')
  const team = join(sandbox.claude, 'teams', 'alpha', 'config.json')
  const transcript = projectPath(sandbox, 'session-1.jsonl')
  const metaContent = await readFile(join(samples, 'subagent-agent-aad616394e806288d.meta.json'), 'utf8')
  const workflowContent = JSON.stringify({ runId: 'wf_1', status: 'running', agentCount: 1 })
  const teamContent = JSON.stringify({ name: 'alpha', leadSessionId: 'session-1', members: [] })
  const transcriptLine = JSON.stringify({ sessionId: 'session-1', uuid: 'u-1' })
  const modified = new Map([
    [meta, await put(meta, metaContent)],
    [workflowMeta, await put(workflowMeta, '{"agentType":"worker"}')],
    [workflow, await put(workflow, workflowContent)],
    [team, await put(team, teamContent)],
  ])
  await put(transcript, `${transcriptLine}\n`)
  for (const ignored of [
    projectPath(sandbox, 'session-1', 'custom-title.json'),
    projectPath(sandbox, 'session-1.desktop-released.json'),
    projectPath(sandbox, 'session-1', 'precompact.json'),
    projectPath(sandbox, 'session-1', 'tool-results', 'toolu_1.txt'),
    join(sandbox.claude, 'teams', 'alpha', 'inbox.json'),
    join(sandbox.claude, 'teams', 'config.json'),
    join(sandbox.claude, 'teams', 'alpha', 'nested', 'config.json'),
    registryPath(sandbox, '4242.0123abcd.key'),
    registryPath(sandbox, join('nested', '4242.json')),
    join(sandbox.claude, 'settings.json'),
  ]) {
    await put(ignored, '{"ignored":true}')
  }
  await mkdir(projectPath(sandbox, 'session-1', 'subagents', 'agent-dir.meta.json'), { recursive: true })
  const running = runCollector(sandbox)

  const expectedFirst = [
    snapshot('transcript', meta, metaContent, modified.get(meta) ?? 0n),
    snapshot('transcript', workflowMeta, '{"agentType":"worker"}', modified.get(workflowMeta) ?? 0n),
    snapshot('transcript', workflow, workflowContent, modified.get(workflow) ?? 0n),
    snapshot('transcript', team, teamContent, modified.get(team) ?? 0n),
  ]
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(5)
  })
  expect(running.records().filter(({ position }) => position.kind === 'file')).toEqual(
    expect.arrayContaining(expectedFirst),
  )
  expect(running.payloads()).toContain(transcriptLine)

  await mkdir(projectPath(sandbox, 'session-1', 'subagents', 'agent-late.meta.json'), { recursive: true })
  const changedMeta = JSON.stringify({ ...(JSON.parse(metaContent) as object), description: 'changed' })
  const changedAt = await put(meta, changedMeta)
  await vi.waitFor(() => {
    expect(ofPath(running, meta)).toHaveLength(2)
  })
  await put(workflow, workflowContent)
  await rm(team)
  await vi.waitFor(() => {
    expect(ofPath(running, team)).toHaveLength(2)
  })
  await rm(workflow)
  await vi.waitFor(() => {
    expect(ofPath(running, workflow)).toHaveLength(2)
  })
  const recreatedContent = JSON.stringify({ runId: 'wf_1', status: 'completed' })
  const recreatedAt = await put(workflow, recreatedContent)
  await vi.waitFor(() => {
    expect(ofPath(running, workflow)).toHaveLength(3)
  })
  await sleep(300)

  expect(ofPath(running, meta)).toEqual([expectedFirst[0], snapshot('transcript', meta, changedMeta, changedAt)])
  expect(ofPath(running, team)).toEqual([expectedFirst[3], removal('transcript', team, teamContent)])
  expect(ofPath(running, workflow)).toEqual([
    expectedFirst[2],
    removal('transcript', workflow, workflowContent),
    snapshot('transcript', workflow, recreatedContent, recreatedAt),
  ])
  expect(running.records()).toHaveLength(9)
  expect(running.gaps()).toEqual([])
})

test('with fsWatch off registry files that appear, change and disappear are found by the periodic scan', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const scanIntervalMs = 300
  const path = registryPath(sandbox, '501.json')
  const first = JSON.stringify({ pid: 501, sessionId: 's-501', status: 'busy' })
  const firstAt = await put(path, first)
  const running = runCollector(sandbox, { fsWatch: false, rootsScanIntervalMs: scanIntervalMs })
  await vi.waitFor(() => {
    expect(running.records()).toEqual([snapshot('registry', path, first, firstAt)])
  })

  const second = JSON.stringify({ pid: 501, sessionId: 's-501', status: 'waiting', waitingFor: 'permission prompt' })
  const secondAt = await put(path, second)
  const writtenAt = performance.now()
  await vi.waitFor(
    () => {
      expect(running.records()).toHaveLength(2)
    },
    { timeout: 5_000, interval: 5 },
  )
  expect((running.arrivalOf(({ payload }) => payload === second) ?? Infinity) - writtenAt).toBeLessThanOrEqual(
    scanIntervalMs + 1_000,
  )

  await rm(path)
  await vi.waitFor(
    () => {
      expect(running.records()).toHaveLength(3)
    },
    { timeout: 5_000 },
  )
  await sleep(scanIntervalMs * 3)
  expect(running.records()).toEqual([
    snapshot('registry', path, first, firstAt),
    snapshot('registry', path, second, secondAt),
    removal('registry', path, second),
  ])
})

test('a partly written file waits for valid JSON, while content that stays invalid is issued once as it is', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const gapAfterMs = 1_500
  const partial = registryPath(sandbox, '601.json')
  const corrupt = registryPath(sandbox, '602.json')
  const whole = JSON.stringify({ pid: 601, sessionId: 's-601', status: 'idle' })
  await put(partial, whole.slice(0, 20))
  const corruptAt = await put(corrupt, '{"pid": 602, "status": "bu')
  const running = runCollector(sandbox, { rootsScanIntervalMs: 200, readRetry: { pauseMs: 50, gapAfterMs } })
  await sleep(gapAfterMs / 2)
  expect(ofPath(running, partial)).toEqual([])
  expect(ofPath(running, corrupt)).toEqual([])

  const wholeAt = await put(partial, whole)
  await vi.waitFor(() => {
    expect(ofPath(running, partial)).toEqual([snapshot('registry', partial, whole, wholeAt)])
  })
  await vi.waitFor(
    () => {
      expect(ofPath(running, corrupt)).toEqual([snapshot('registry', corrupt, '{"pid": 602, "status": "bu', corruptAt)])
    },
    { timeout: 10_000 },
  )

  await put(partial, whole.slice(0, 10))
  await sleep(200)
  await put(partial, whole)
  await sleep(gapAfterMs * 2)
  expect(ofPath(running, partial)).toEqual([snapshot('registry', partial, whole, wholeAt)])
  expect(ofPath(running, corrupt)).toHaveLength(1)
  expect(running.gaps()).toEqual([])
})

test('a registry file that cannot be read becomes a read_failed gap that the next successful read closes', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const gapAfterMs = 600
  const path = registryPath(sandbox, '701.json')
  const content = JSON.stringify({ pid: 701, sessionId: 's-701', status: 'busy' })
  const modifiedAt = await put(path, content)
  const release = await holdExclusively(sandbox, path)
  const running = runCollector(sandbox, { readRetry: { pauseMs: 50, gapAfterMs } })
  await vi.waitFor(
    () => {
      expect(running.gaps()).toHaveLength(1)
    },
    { timeout: 10_000 },
  )
  expect(running.records()).toEqual([])
  const [opened] = running.gaps()
  expect(opened).toMatchObject({ key: { kind: 'gap', gap: 'read_failed', subject: path }, stream: null, closed_at: null })

  await release()
  await vi.waitFor(
    () => {
      expect(running.records()).toEqual([snapshot('registry', path, content, modifiedAt)])
    },
    { timeout: 10_000 },
  )
  const closed = running.gaps()[1]
  expect(closed).toMatchObject({ key: opened?.key, detected_at: opened?.detected_at })
  expect(closed?.closed_at ?? 0n).toBeGreaterThanOrEqual(opened?.detected_at ?? 0n)
})

test('large snapshot files are split across batches and each is issued exactly once', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const paths = Array.from({ length: 5 }, (_, index) => projectPath(sandbox, 'session-2', 'workflows', `wf_${String(index)}.json`))
  for (const [index, path] of paths.entries()) {
    await put(path, JSON.stringify({ runId: `wf_${String(index)}`, phases: 'x'.repeat(3 * 1024 ** 2) }))
  }
  const running = runCollector(sandbox)
  await vi.waitFor(
    () => {
      expect(running.records()).toHaveLength(5)
    },
    { timeout: 10_000 },
  )
  await sleep(300)

  expect(running.records().map(({ position }) => (position.kind === 'file' ? position.path : null)).sort()).toEqual([...paths].sort())
  for (const { batch } of running.arrivals) {
    expect(batch.records.reduce((total, { payload }) => total + payload.length, 0)).toBeLessThanOrEqual(12 * 1024 ** 2)
  }
  expect(running.arrivals.length).toBeGreaterThanOrEqual(2)
})

test('after a restart the present snapshot files are issued again with the same positions', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const registry = registryPath(sandbox, '801.json')
  const meta = projectPath(sandbox, 'session-3', 'subagents', 'agent-c.meta.json')
  await put(registry, JSON.stringify({ pid: 801, sessionId: 'session-3', status: 'idle' }))
  await put(meta, JSON.stringify({ agentType: 'checker', toolUseId: 'toolu_3' }))
  const first = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(first.records()).toHaveLength(2)
  })
  await first.close()

  const second = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(second.records()).toHaveLength(2)
  })
  const positions = (running: Running): CollectedPosition[] =>
    running
      .records()
      .map(({ position }) => position)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  expect(positions(second)).toEqual(positions(first))
})
