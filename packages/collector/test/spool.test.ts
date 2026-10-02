import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createCollector } from '@aang/collector'
import { CollectedRecord, Config } from '@aang/contract'
import { expect, test, vi } from 'vitest'
import {
  createSandbox,
  daysAgo,
  holdExclusively,
  putSpoolFile,
  runCollector,
  sleep,
  spoolBytes,
  spoolPath,
  temporarySpoolPath,
} from './sandbox.js'

const permissionRequest = JSON.stringify({
  session_id: 'b0f4c1e2-1111-4a4a-9c9c-000000000001',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build/ && echo "готово"' },
})

test('a hook event written to spool/new reaches a batch within a second and is deleted only after ack', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  await putSpoolFile(sandbox, 'warmup', spoolBytes({ payload: '{}' }))
  const running = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(1)
  })

  const env = {
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 'b0f4c1e2-1111-4a4a-9c9c-000000000001',
    CLAUDE_PROJECT_DIR: 'C:\\Users\\Имя Фамилия\\proj=1',
    CLAUDE_PLUGIN_ROOT: '/home/user/.aang/claude-plugin',
  }
  const writtenAt = performance.now()
  const path = await putSpoolFile(sandbox, 'event-1', spoolBytes({ env, payload: permissionRequest }))
  await vi.waitFor(
    () => {
      expect(running.records()).toHaveLength(2)
    },
    { timeout: 2_000, interval: 5 },
  )

  expect((running.arrivalOf((record) => record.payload === permissionRequest) ?? Infinity) - writtenAt).toBeLessThanOrEqual(
    1_000,
  )
  const record = running.records()[1]
  expect(record).toEqual({
    channel: 'hook',
    runtime: 'claude',
    stream: null,
    position: { kind: 'spool', file: 'event-1' },
    hook: { registration: 'plugin', env },
    observed_at: (await stat(path, { bigint: true })).mtimeNs,
    payload: permissionRequest,
  })
  expect(CollectedRecord.parse(record)).toEqual(record)
  expect(() => running.collector.start([])).toThrow('the collector can only be started once')
  expect(existsSync(path)).toBe(true)
  expect(await running.collector.spoolStats()).toEqual({ files: 2, bytes: (await stat(path)).size + spoolBytes({ payload: '{}' }).length })

  await running.ackAll()

  expect(existsSync(path)).toBe(false)
  expect(await running.collector.spoolStats()).toEqual({ files: 0, bytes: 0 })
})

test('with fsWatch off a file that appears without a notification is issued within the scan interval, once, and removed only on ack', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const scanIntervalMs = 300
  await putSpoolFile(sandbox, 'warmup', spoolBytes({ payload: '{}' }))
  const running = runCollector(sandbox, { fsWatch: false, spoolScanIntervalMs: scanIntervalMs })
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(1)
  })
  await running.ackAll()

  const writtenAt = performance.now()
  const path = await putSpoolFile(sandbox, 'event-1', spoolBytes({ runtime: 'codex', registration: 'user', payload: '{"a":1}' }))
  await vi.waitFor(
    () => {
      expect(running.payloads()).toEqual(['{}', '{"a":1}'])
    },
    { timeout: 3_000, interval: 5 },
  )
  expect((running.arrivalOf((record) => record.payload === '{"a":1}') ?? Infinity) - writtenAt).toBeLessThanOrEqual(
    scanIntervalMs + 1_000,
  )

  await sleep(scanIntervalMs * 4)
  expect(running.payloads()).toEqual(['{}', '{"a":1}'])
  expect(existsSync(path)).toBe(true)

  await running.ackAll()
  expect(existsSync(path)).toBe(false)
})

test('a file issued but not acknowledged stays in the spool and is issued again after a restart', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const path = await putSpoolFile(sandbox, 'event-1', spoolBytes({ payload: permissionRequest }))
  const first = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(first.payloads()).toEqual([permissionRequest])
  })
  await first.close()
  expect(existsSync(path)).toBe(true)

  const second = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(second.records()).toEqual(first.records())
  })
  await second.ackAll()

  expect(existsSync(path)).toBe(false)
})

test('batches follow the receipt order and every file is issued exactly once', async ({ onTestFinished }) => {
  const sandbox = await createSandbox(onTestFinished)
  const count = 600
  const base = Date.now() - 60_000
  for (let index = 0; index < count; index += 1) {
    const name = `event-${String(count - index).padStart(4, '0')}`
    await putSpoolFile(sandbox, name, spoolBytes({ payload: String(index) }), new Date(base + index * 10))
  }
  const running = runCollector(sandbox)
  await vi.waitFor(
    () => {
      expect(running.records()).toHaveLength(count)
    },
    { timeout: 10_000 },
  )

  expect(running.payloads()).toEqual(Array.from({ length: count }, (_, index) => String(index)))
  expect(running.arrivals.length).toBeGreaterThan(1)
  await running.ackAll()
  expect(await readdir(spoolPath(sandbox, ''))).toEqual([])
})

test('files older than the maximum age are discarded at start with a gap and removed after ack', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const expired = [
    await putSpoolFile(sandbox, 'old-1', spoolBytes({ payload: '{"old":1}' }), daysAgo(9)),
    await putSpoolFile(sandbox, 'old-2', spoolBytes({ payload: '{"old":2}' }), daysAgo(8)),
  ]
  const fresh = await putSpoolFile(sandbox, 'fresh', spoolBytes({ payload: '{"fresh":1}' }), daysAgo(6))
  const startedAt = BigInt(Date.now()) * 1_000_000n
  const running = runCollector(sandbox, { maxAgeDays: 7 })
  await vi.waitFor(() => {
    expect(running.gaps()).toHaveLength(1)
  })

  expect(running.payloads()).toEqual(['{"fresh":1}'])
  const [gap] = running.gaps()
  expect(gap).toMatchObject({
    key: { kind: 'gap', gap: 'spool_expired' },
    stream: null,
    details: expect.stringMatching(/^2 spool files older than 7 days discarded/) as unknown,
    closed_at: null,
  })
  expect(gap?.detected_at).toBeGreaterThanOrEqual(startedAt)
  expect(expired.map((path) => existsSync(path))).toEqual([true, true])

  await running.ackAll()
  expect([...expired, fresh].map((path) => existsSync(path))).toEqual([false, false, false])
  await running.close()

  const restarted = runCollector(sandbox, { maxAgeDays: 7 })
  await putSpoolFile(sandbox, 'next', spoolBytes({ payload: '{"next":1}' }))
  await vi.waitFor(() => {
    expect(restarted.payloads()).toEqual(['{"next":1}'])
  })
  expect(restarted.gaps()).toEqual([])
})

test('leftovers in spool/tmp from killed hooks are removed at start while files still being written stay', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const stale = temporarySpoolPath(sandbox, 'stale')
  const live = temporarySpoolPath(sandbox, 'live')
  await mkdir(temporarySpoolPath(sandbox, ''), { recursive: true })
  await writeFile(stale, 'aang-spool/1 claude plugin\n')
  await utimes(stale, daysAgo(1), daysAgo(1))
  await writeFile(live, 'aang-spool/1 claude plugin\n')
  await putSpoolFile(sandbox, 'warmup', spoolBytes({ payload: '{}' }))

  const running = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(1)
  })

  expect(existsSync(stale)).toBe(false)
  expect(existsSync(live)).toBe(true)
})

test('a spool file with a broken header becomes an unknown_records gap and is removed after ack', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const broken = {
    'no-header-line': Buffer.from('aang-spool/1 claude plugin'),
    'wrong-magic': Buffer.from('aang-spool/2 claude plugin\n\0{}'),
    'extra-field': Buffer.from('aang-spool/1 claude plugin extra\n\0{}'),
    'unknown-runtime': Buffer.from('aang-spool/1 gemini plugin\n\0{}'),
    'unknown-tag': Buffer.from('aang-spool/1 codex project\n\0{}'),
    unterminated: Buffer.from('aang-spool/1 claude plugin\nCLAUDE_PID=1\0'),
    'entry-without-value': Buffer.from('aang-spool/1 claude plugin\nCLAUDE_PID\0\0{}'),
    'empty-key': Buffer.from('aang-spool/1 claude plugin\n=1\0\0{}'),
  }
  const base = Date.now() - 1_000
  const paths = []
  for (const [index, [name, bytes]] of Object.entries(broken).entries()) {
    paths.push(await putSpoolFile(sandbox, name, bytes, new Date(base + index)))
  }
  const payload = Buffer.from('\uFEFF{"text":"a\0b\nc"}', 'utf8')
  paths.push(
    await putSpoolFile(
      sandbox,
      'valid',
      spoolBytes({
        runtime: 'codex',
        registration: 'user',
        env: { CODEX_HOME: '/home/user/.codex', FUTURE_KEY: 'ignored', AI_AGENT: 'a=b\nc' },
        payload,
      }),
      new Date(base + 100),
    ),
  )

  const running = runCollector(sandbox)
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(1)
  })

  expect(running.records()[0]).toMatchObject({
    runtime: 'codex',
    hook: { registration: 'user', env: { CODEX_HOME: '/home/user/.codex', AI_AGENT: 'a=b\nc' } },
    payload: payload.toString('utf8'),
  })
  expect(running.gaps().map(({ key, stream, closed_at }) => ({ key, stream, closed_at }))).toEqual(
    Object.keys(broken).map((name) => ({
      key: { kind: 'gap', gap: 'unknown_records', subject: `spool:${name}` },
      stream: null,
      closed_at: null,
    })),
  )
  expect(paths.every((path) => existsSync(path))).toBe(true)

  await running.ackAll()
  expect(paths.some((path) => existsSync(path))).toBe(false)
})

test('a spool/new removed while running is recreated and files written afterwards are still collected', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const scanIntervalMs = 300
  await putSpoolFile(sandbox, 'warmup', spoolBytes({ payload: '{}' }))
  const running = runCollector(sandbox, { spoolScanIntervalMs: scanIntervalMs })
  await vi.waitFor(() => {
    expect(running.records()).toHaveLength(1)
  })
  await running.ackAll()

  await rm(spoolPath(sandbox, ''), { recursive: true, maxRetries: 10 })
  await vi.waitFor(() => {
    expect(existsSync(spoolPath(sandbox, ''))).toBe(true)
  })
  await sleep(scanIntervalMs)
  await putSpoolFile(sandbox, 'after', spoolBytes({ payload: '{"after":1}' }))

  await vi.waitFor(() => {
    expect(running.payloads()).toEqual(['{}', '{"after":1}'])
  })
})

test('a spool file that cannot be read yet stays in place and is issued once it becomes readable', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const scanIntervalMs = 300
  const path = await putSpoolFile(sandbox, 'locked', spoolBytes({ payload: permissionRequest }))
  const release = await holdExclusively(sandbox, path)
  const running = runCollector(sandbox, { spoolScanIntervalMs: scanIntervalMs })

  await sleep(scanIntervalMs * 3)
  expect(running.records()).toEqual([])
  expect(existsSync(path)).toBe(true)

  await release()
  await vi.waitFor(() => {
    expect(running.payloads()).toEqual([permissionRequest])
  })
  await running.ackAll()
  expect(existsSync(path)).toBe(false)
})

test('spool statistics are empty before the spool exists and fail when spool/new cannot be listed', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const collector = createCollector({
    spool: sandbox.spool,
    runtimeRoots: { claude: sandbox.claude, codex: sandbox.codex },
    config: Config.parse({}),
  })
  onTestFinished(() => collector.close())

  expect(await collector.spoolStats()).toEqual({ files: 0, bytes: 0 })

  await mkdir(sandbox.spool, { recursive: true })
  await writeFile(spoolPath(sandbox, ''), 'not a directory')
  await expect(collector.spoolStats()).rejects.toThrow(/ENOTDIR/)
})

test.runIf(process.env.AANG_BENCH === '1')(
  'benchmark: a hook event reaches a batch within 100 ms at p95',
  async ({ onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)
    await putSpoolFile(sandbox, 'warmup', spoolBytes({ payload: '{}' }))
    const running = runCollector(sandbox)
    await vi.waitFor(() => {
      expect(running.records()).toHaveLength(1)
    })
    const latencies: number[] = []
    for (let index = 0; index < 100; index += 1) {
      const payload = JSON.stringify({ index })
      const writtenAt = performance.now()
      await putSpoolFile(sandbox, `event-${String(index)}`, spoolBytes({ payload }))
      await vi.waitFor(
        () => {
          expect(running.arrivalOf((record) => record.payload === payload)).toBeDefined()
        },
        { timeout: 2_000, interval: 1 },
      )
      latencies.push((running.arrivalOf((record) => record.payload === payload) ?? Infinity) - writtenAt)
      await sleep(20)
    }
    latencies.sort((left, right) => left - right)
    expect(latencies[Math.ceil(latencies.length * 0.95) - 1]).toBeLessThanOrEqual(100)
  },
)
