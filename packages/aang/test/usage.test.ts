import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'vitest'
import { type CommandResult, createSandbox, type Sandbox } from './sandbox.js'

const session = 'u1-cli-session'
const origin = Date.parse('2026-10-02T12:00:00.000Z')

const isoAt = (second: number): string => new Date(origin + second * 1000).toISOString()
const nanosAt = (second: number): string => String(BigInt(origin + second * 1000) * 1_000_000n)

const reply = (uuid: string, second: number, id: string, output: number, stop: string | null): object => ({
  type: 'assistant',
  uuid,
  timestamp: isoAt(second),
  message: {
    id,
    model: 'claude-opus-5-5',
    role: 'assistant',
    content: [{ type: 'text', text: 'Done' }],
    stop_reason: stop,
    usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output },
  },
})

const transcript = (cwd: string): string[] =>
  [
    { type: 'user', uuid: 'u-1', timestamp: isoAt(600), message: { role: 'user', content: 'Go on' } },
    reply('a-1', 605, 'msg-1', 40, 'end_turn'),
    { type: 'user', uuid: 'u-2', timestamp: isoAt(8400), message: { role: 'user', content: 'One more' } },
    reply('a-2', 8410, 'msg-2', 60, null),
    {
      type: 'cost-state',
      totalCostUSD: 0.5,
      totalDuration: 7_810_000,
      modelUsage: {
        'claude-opus-5-5': {
          inputTokens: 6,
          outputTokens: 100,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 200,
          costUSD: 0.5,
        },
      },
    },
  ].map((record) => JSON.stringify({ sessionId: session, cwd, version: '2.1.286', ...record }))

const usage = (cost: number, input: number, read: number, write: number, output: number): string =>
  JSON.stringify({
    model: 'claude-opus-5-5',
    tokens: {
      uncached_input_tokens: input,
      cache_read_input_tokens: read,
      cache_write_input_tokens: write,
      output_tokens: output,
      reasoning_output_tokens: null,
    },
    cost_usd: cost,
  })

const observerInput = (run: string): string =>
  JSON.stringify({
    run: { id: run, runtime: 'claude', goal: null, brief: null, sessions: [], agents: [] },
    context: null,
    model: { version: 1, stages: [], criteria: [], attention: [] },
    batch: { facts: [], collapsed: [], backlog: null, artifact_versions: [] },
    materials: [],
    previous_attempt: null,
  })

const chatInput = (run: string): string =>
  JSON.stringify({
    question: 'What is left?',
    history: [],
    run: { id: run, runtime: 'claude', goal: null, brief: null, sessions: [], agents: [] },
    model: { version: 1, stages: [], criteria: [], attention: [] },
    focus: { kind: 'run', attention: [], recent_changes: [] },
    materials: [],
  })

const recordCalls = (sandbox: Sandbox, run: string): void => {
  const database = new DatabaseSync(join(sandbox.aangHome, 'aang.db'))
  try {
    const insert = database.prepare(
      `INSERT INTO observer_calls (id, kind, run_id, previous_id, backend, base_version, input, output, verdict, usage,
         started_at, finished_at, delay_ms, change_seq)
       VALUES (?, ?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    insert.run('batch', 'batch', run, null, 1, observerInput(run), '{}', 'accepted', usage(0.25, 100, 2000, 300, 50), nanosAt(3600), nanosAt(3612), 3_010_000)
    insert.run('probe', 'probe', null, null, null, null, null, 'accepted', usage(0.0625, 10, 0, 0, 5), nanosAt(5400), nanosAt(5402), null)
    insert.run('question', 'chat', run, null, 1, chatInput(run), null, 'needs_requested', usage(0.03125, 30, 400, 50, 6), nanosAt(6000), nanosAt(6006), null)
    insert.run('answer', 'chat', run, 'question', 1, chatInput(run), '{}', 'accepted', usage(0.25, 40, 500, 0, 60), nanosAt(6007), nanosAt(6015), null)
  } finally {
    database.close()
  }
}

const reported = async (sandbox: Sandbox): Promise<CommandResult> => {
  const deadline = Date.now() + 20_000
  for (;;) {
    const result = await sandbox.aang('usage')
    if (result.stdout.includes('2 records\n    session ') || Date.now() > deadline) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const idOf = (pattern: RegExp, text: string): string => {
  const id = pattern.exec(text)?.[1]
  if (id === undefined) {
    throw new Error(`no ${String(pattern)} in ${text}`)
  }
  return id
}

const observerLine = 'observer: 100 input, 2,000 cache read, 300 cache write, 50 output, $0.25'
const observerCalls = '1 call; latency p50 12.0 s, p95 12.0 s, max 12.0 s; lag p50 50 min 10 s, p95 50 min 10 s, max 50 min 10 s'
const chatLine = 'chat: 70 input, 900 cache read, 50 cache write, 66 output, $0.2813'
const chatCalls = '1 call; latency p50 15.0 s, p95 15.0 s, max 15.0 s'
const solverLine = 'solver: 6 input, 2,000 cache read, 200 cache write, at least 100 output, 2 records'
const moneyNote = 'money is at list prices; with a subscription it is not a charge'

describe.concurrent('aang usage shows the three journals of the running daemon', () => {
  test('the report of a run, of all runs and of a period keeps the solver, observer and chat apart', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const root = dirname(sandbox.aangHome)
    const workspace = join(root, 'work')
    const projects = join(root, '.claude', 'projects', '-work')
    await mkdir(workspace)
    await mkdir(projects, { recursive: true })
    await writeFile(
      join(sandbox.aangHome, 'config.json'),
      JSON.stringify({
        api: { port: 0 },
        otel: { port: 0 },
        collector: { rootsScanIntervalMs: 200 },
        watch: { roots: [{ path: workspace }] },
      }),
    )
    await writeFile(join(projects, `${session}.jsonl`), `${transcript(workspace).join('\n')}\n`)
    expect((await sandbox.aang('start')).code).toBe(0)
    const collected = await reported(sandbox)
    expect((await sandbox.aang('stop')).code).toBe(0)
    const run = idOf(/^run ([0-9a-f]{32}):/m, collected.stdout)
    const sessionId = idOf(/session ([0-9a-f]{32}):/, collected.stdout)
    recordCalls(sandbox, run)

    expect((await sandbox.aang('start')).code).toBe(0)
    const ofRun = await sandbox.aang('usage', '--run', run)
    const all = await sandbox.aang('usage')
    const period = await sandbox.aang('usage', '--from', '2026-10-02T13:00:00Z', '--to', '2026-10-02T14:00:00Z')
    const unknown = await sandbox.aang('usage', '--run', '0'.repeat(32))
    expect((await sandbox.aang('stop')).code).toBe(0)

    const sessionLine = `    session ${sessionId}: Claude Code reports 6 input, 2,000 cache read, 200 cache write, 100 output, $0.50; final`
    expect(ofRun).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        'usage over all time',
        'active hours: 2',
        '',
        solverLine,
        observerLine,
        chatLine,
        '',
        'per active hour',
        '  solver: 3 input, 1,000 cache read, 100 cache write, at least 50 output, 1 record',
        '  observer: 50 input, 1,000 cache read, 150 cache write, 25 output, $0.125',
        '  chat: 35 input, 450 cache read, 25 cache write, 33 output, $0.1406',
        '',
        `observer calls: ${observerCalls}`,
        'probes: not attributed to runs',
        `chat calls: ${chatCalls}`,
        '',
        `run ${run}: 2 h 10 min 10 s from the first to the last activity, 2 active hours`,
        `  ${solverLine}`,
        sessionLine,
        `  ${observerLine}; ${observerCalls}`,
        `  ${chatLine}; ${chatCalls}`,
        '',
        moneyNote,
        '',
      ].join('\n'),
    })
    expect(all.stdout).toContain('observer: 110 input, 2,000 cache read, 300 cache write, 55 output, $0.3125\n')
    expect(all.stdout).toContain('\nprobes: 1 call; latency p50 2.0 s, p95 2.0 s, max 2.0 s\n')
    expect(period).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        'usage from 2026-10-02T13:00:00.000Z to 2026-10-02T14:00:00.000Z',
        'active hours: 0',
        '',
        'solver: 0 input, 0 cache read, 0 cache write, 0 output, 0 records',
        'observer: 110 input, 2,000 cache read, 300 cache write, 55 output, $0.3125',
        chatLine,
        '',
        `observer calls: ${observerCalls}`,
        'probes: 1 call; latency p50 2.0 s, p95 2.0 s, max 2.0 s',
        `chat calls: ${chatCalls}`,
        '',
        `run ${run}: no solver activity`,
        '  solver: 0 input, 0 cache read, 0 cache write, 0 output, 0 records',
        sessionLine,
        `  ${observerLine}; ${observerCalls}`,
        `  ${chatLine}; ${chatCalls}`,
        '',
        moneyNote,
        '',
      ].join('\n'),
    })
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain(`aang usage: no run ${'0'.repeat(32)}`)
  })

  test('an empty daemon reports no usage, and the command refuses to run without a daemon', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const stopped = await sandbox.aang('usage')
    expect((await sandbox.aang('start')).code).toBe(0)
    const empty = await sandbox.aang('usage', '--from', '2026-10-01')
    expect((await sandbox.aang('stop')).code).toBe(0)

    expect(stopped.code).toBe(1)
    expect(stopped.stderr).toContain('aang usage: aang is not running; start it with `aang start`')
    expect(empty).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        'usage from 2026-10-01T00:00:00.000Z',
        'active hours: 0',
        '',
        'solver: 0 input, 0 cache read, 0 cache write, 0 output, 0 records',
        'observer: 0 input, 0 cache read, 0 cache write, 0 output',
        'chat: 0 input, 0 cache read, 0 cache write, 0 output',
        '',
        'observer calls: 0 calls',
        'probes: 0 calls',
        'chat calls: 0 calls',
        '',
      ].join('\n'),
    })
  })

  test.for([
    { args: ['usage', 'extra'], message: 'aang usage takes no positional arguments' },
    { args: ['usage', '--run', 'not-a-run'], message: "'not-a-run' is not a run id" },
    { args: ['usage', '--from', 'yesterday'], message: "--from takes a date, got 'yesterday'" },
    { args: ['usage', '--to', 'tomorrow'], message: "--to takes a date, got 'tomorrow'" },
    { args: ['usage', '--from', '2026-10-02', '--to', '2026-10-01'], message: '--from must precede --to' },
  ])('aang $args is a usage error', async ({ args, message }, { expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.aang(...args)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
  })
})
