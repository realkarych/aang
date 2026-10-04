import {
  type CallUsage,
  type ChatInput,
  type CollectorBatch,
  EpochNs,
  type FactId,
  ModelVersion,
  ObserverCallId,
  type RunId,
  type TokenUsage,
  type UsageQuery,
  type UsageTotals,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import {
  applyObserverResponse,
  beginObserverCall,
  beginObserverFollowUp,
  createReadQueries,
  failObserverCall,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { describe, expect, onTestFinished, test } from 'vitest'
import { jsonlFile } from './batches.js'
import { sessionKey, startEngine } from './harness.js'
import { createHome } from './home.js'
import { inputFor } from './observer-fixtures.js'
import { claudeForkTranscript, claudeTranscript, codexRollout } from './samples.js'

const cwd = '/work/project'
const projects = '/home/.claude/projects/-work-project'
const origin = Date.parse('2026-10-02T12:00:00.000Z')
const readDelayMs = 2000

const epochAt = (second: number): EpochNs => EpochNs.parse(BigInt(origin + second * 1000) * 1_000_000n)
const isoAt = (second: number): string => new Date(origin + second * 1000).toISOString()

const alpha = runId(sessionKey('claude', 'alpha'))
const beta = runId(sessionKey('claude', 'beta'))
const missing = runId(sessionKey('claude', 'missing'))

const line = (session: string, record: object): string =>
  JSON.stringify({ sessionId: session, cwd, version: '2.1.286', ...record })

const prompt = (session: string, uuid: string, second: number): string =>
  line(session, { type: 'user', uuid, timestamp: isoAt(second), message: { role: 'user', content: 'Go on' } })

const reply = (session: string, uuid: string, second: number, id: string, output: number): string =>
  line(session, {
    type: 'assistant',
    uuid,
    timestamp: isoAt(second),
    message: {
      id,
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output },
    },
  })

const transcript = (session: string, lines: readonly string[], ino: bigint): CollectorBatch => {
  const batch = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines, ino }).batch(1, lines.length)
  return {
    ...batch,
    records: batch.records.map((record) => ({
      ...record,
      observed_at: EpochNs.parse(
        BigInt(Date.parse((JSON.parse(record.payload) as { timestamp: string }).timestamp) + readDelayMs) *
          1_000_000n,
      ),
    })),
  }
}

const tokens = (input: number, read: number, write: number, output: number): TokenUsage => ({
  uncached_input_tokens: input,
  cache_read_input_tokens: read,
  cache_write_input_tokens: write,
  output_tokens: output,
  reasoning_output_tokens: null,
})

const spent = (cost: number | null, input: number, read: number, write: number, output: number): CallUsage => ({
  model: cost === null ? 'gpt-6.1-sol' : 'claude-opus-5-5',
  tokens: tokens(input, read, write, output),
  cost_usd: cost,
})

const totals = (
  records: number,
  [input, read, write, output]: readonly [number, number, number, number],
  cost: number | null = null,
): UsageTotals => ({ tokens: tokens(input, read, write, output), records, output_lower_bound: false, cost_usd: cost })

const firstBatch = spent(0.25, 100, 2000, 300, 50)
const needsRequest = spent(0.125, 80, 1000, 0, 20)
const followUp = spent(0.5, 120, 1500, 0, 70)
const probe = spent(0.0625, 10, 0, 0, 5)
const chatQuestion = spent(0.03125, 30, 400, 50, 6)
const chatAnswer = spent(0.25, 40, 500, 0, 60)
const codexChat = spent(null, 5, 0, 0, 5)

const call = (name: string): ObserverCallId => ObserverCallId.parse(name)

const chatInput = (run: RunId, version: ModelVersion): ChatInput => ({
  question: 'What is left?',
  history: [],
  run: { id: run, runtime: 'claude', goal: null, brief: null, sessions: [], agents: [] },
  model: { version, stages: [], criteria: [], attention: [] },
  focus: { kind: 'run', attention: [], recent_changes: [] },
  materials: [],
})

const factsOf = (store: Store, ids: readonly FactId[]) =>
  ids.map((id) => {
    const fact = store.facts.get(id)
    if (fact === null) {
      throw new Error(`fact ${id} is missing`)
    }
    return fact
  })

const observe = (store: Store): void => {
  const pending = store.interpretations.pending(alpha)
  const readAt = (second: number) =>
    pending.filter(({ observed_at: observed }) => observed === epochAt(second + readDelayMs / 1000))
  const [prompted, answered] = [readAt(600), readAt(605)]
  const rest = pending.filter((item) => !prompted.includes(item) && !answered.includes(item))
  const begin = (id: string, items: typeof pending, second: number): ModelVersion => {
    const head = store.model.head(alpha)
    const input = inputFor(store, factsOf(store, items.map(({ fact }) => fact)), alpha)
    store.transaction((transaction) => {
      beginObserverCall(transaction, { id: call(id), backend: 'claude', crossVendor: false, input, at: epochAt(second) })
    })
    return head
  }
  const respond = (id: string, base: ModelVersion, second: number, usage: CallUsage, needs = false) =>
    store.transaction((transaction) =>
      applyObserverResponse(transaction, {
        call: call(id),
        output: { base_version: base, ops: [], needs: needs ? [{ kind: 'raw_record', seq: prompted[0]?.seq }] : [] },
        at: epochAt(second),
        usage,
      }),
    )

  const first = begin('batch', prompted, 3600)
  expect(respond('batch', first, 3612, firstBatch).status).toBe('accepted')
  const second = begin('needs', answered, 3900)
  expect(respond('needs', second, 3908, needsRequest, true).status).toBe('needs_requested')
  store.transaction((transaction) =>
    beginObserverFollowUp(transaction, { previous: call('needs'), id: call('follow-up'), at: epochAt(3909), crossVendor: false }),
  )
  expect(respond('follow-up', second, 3920, followUp).status).toBe('accepted')
  begin('timeout', rest, 9000)
  store.transaction((transaction) => {
    failObserverCall(transaction, {
      call: call('timeout'),
      outcome: 'failed',
      error: { class: 'timeout', message: 'the observer call timed out' },
      at: epochAt(9030),
    })
    for (const [kind, second, usage] of [
      ['probe', 5400, probe],
      ['auth_status', 5500, null],
    ] as const) {
      transaction.observerCalls.check({
        id: call(kind),
        kind,
        backend: 'claude',
        input: null,
        output: null,
        verdict: 'accepted',
        error: null,
        usage,
        started_at: epochAt(second),
        finished_at: epochAt(second + 2),
      })
    }
    const version = transaction.model.head(alpha)
    const chat = {
      run: alpha,
      backend: 'claude',
      base_version: version,
      input: chatInput(alpha, version),
      error: null,
    } as const
    transaction.observerCalls.chat({
      ...chat,
      id: call('question'),
      previous: null,
      output: null,
      verdict: 'needs_requested',
      usage: chatQuestion,
      started_at: epochAt(6000),
      finished_at: epochAt(6006),
    })
    transaction.observerCalls.chat({
      ...chat,
      id: call('answer'),
      previous: call('question'),
      output: { answer: 'Both exchanges are done.' },
      verdict: 'accepted',
      usage: chatAnswer,
      started_at: epochAt(6007),
      finished_at: epochAt(6015),
    })
    const betaVersion = transaction.model.head(beta)
    transaction.observerCalls.chat({
      id: call('codex-answer'),
      run: beta,
      backend: 'codex',
      base_version: betaVersion,
      previous: null,
      input: chatInput(beta, betaVersion),
      output: null,
      verdict: 'accepted',
      error: null,
      usage: codexChat,
      started_at: epochAt(10800),
      finished_at: epochAt(10805),
    })
  })
}

const observed = async (): Promise<Store> => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store, { all: true })
  await engine.ingest(
    transcript(
      'alpha',
      [
        prompt('alpha', 'a-1', 600),
        reply('alpha', 'a-2', 605, 'msg-alpha-1', 40),
        prompt('alpha', 'a-3', 8400),
        reply('alpha', 'a-4', 8410, 'msg-alpha-2', 60),
      ],
      1n,
    ),
  )
  await engine.ingest(transcript('beta', [prompt('beta', 'b-1', 1800), reply('beta', 'b-2', 1805, 'msg-beta-1', 20)], 2n))
  observe(store)
  return store
}

const reportOf = (store: Store, query: UsageQuery) =>
  createReadQueries({ store, observer: () => ({ state: { state: 'ok' }, isolation_unverified: false }) }).usage(query)

const solverOf = (records: number, output: number) => totals(records, [3 * records, 1000 * records, 100 * records, output])

const alphaObserver = {
  calls: 3,
  totals: totals(3, [300, 4500, 300, 140], 0.875),
  latency_ms: { p50: 20_000, p95: 30_000, max: 30_000 },
  lag_ms: { p50: 3_010_000, p95: 3_313_000, max: 3_313_000 },
}

const alphaChat = { calls: 1, totals: totals(2, [70, 900, 50, 66], 0.28125), latency_ms: { p50: 15_000, p95: 15_000, max: 15_000 } }

const betaChat = { calls: 1, totals: totals(1, [5, 0, 0, 5]), latency_ms: { p50: 5_000, p95: 5_000, max: 5_000 } }

const noCalls = { calls: 0, totals: totals(0, [0, 0, 0, 0]), latency_ms: null }

describe('the usage report', () => {
  test('keeps the solver, observer and chat journals apart and counts active hours by the activity of the solver', async () => {
    const store = await observed()

    const report = reportOf(store, {})

    expect(report?.runs.map(({ run, solver, observer, chat, duration_ms, active_hours }) => ({
      run,
      solver: solver.totals,
      observer,
      chat,
      duration_ms,
      active_hours,
    }))).toEqual([
      {
        run: alpha,
        solver: solverOf(2, 100),
        observer: alphaObserver,
        chat: alphaChat,
        duration_ms: 7_810_000,
        active_hours: 2,
      },
      { run: beta, solver: solverOf(1, 20), observer: { ...noCalls, lag_ms: null }, chat: betaChat, duration_ms: 5_000, active_hours: 1 },
    ])
    expect(report).toMatchObject({
      from: null,
      to: null,
      observer: alphaObserver,
      probes: { calls: 1, totals: totals(1, [10, 0, 0, 5], 0.0625), latency_ms: { p50: 2_000, p95: 2_000, max: 2_000 } },
      chat: {
        calls: 2,
        totals: totals(3, [75, 900, 50, 71], 0.28125),
        latency_ms: { p50: 5_000, p95: 15_000, max: 15_000 },
      },
      totals: {
        solver: solverOf(3, 120),
        observer: totals(4, [310, 4500, 300, 145], 0.9375),
        chat: totals(3, [75, 900, 50, 71], 0.28125),
      },
      active_hours: 2,
    })
    expect(report?.per_active_hour).toEqual({
      solver: { tokens: tokens(4.5, 1500, 150, 60), records: 1.5, output_lower_bound: false, cost_usd: null },
      observer: { tokens: tokens(155, 2250, 150, 72.5), records: 2, output_lower_bound: false, cost_usd: 0.46875 },
      chat: { tokens: tokens(37.5, 450, 25, 35.5), records: 1.5, output_lower_bound: false, cost_usd: 0.140625 },
    })
  })

  test('of a run leaves out the probes, which belong to no run', async () => {
    const store = await observed()

    const report = reportOf(store, { run: alpha })

    expect(report?.runs.map(({ run }) => run)).toEqual([alpha])
    expect(report).toMatchObject({
      observer: alphaObserver,
      probes: null,
      chat: alphaChat,
      totals: { solver: solverOf(2, 100), observer: alphaObserver.totals, chat: alphaChat.totals },
      active_hours: 2,
    })
    expect(reportOf(store, { run: missing })).toBeNull()
  })

  test('over a period counts the records, activity and calls that end in it and lists only the runs it touches', async () => {
    const store = await observed()

    const report = reportOf(store, { from: epochAt(3612), to: epochAt(10805) })

    expect(report).toMatchObject({
      from: epochAt(3612),
      to: epochAt(10805),
      runs: [
        {
          run: alpha,
          solver: { totals: solverOf(1, 60) },
          observer: alphaObserver,
          chat: alphaChat,
          duration_ms: 10_000,
          active_hours: 1,
        },
      ],
      probes: { calls: 1 },
      chat: alphaChat,
      active_hours: 1,
    })
    expect(report?.runs).toHaveLength(1)
  })

  test('lists a run that only talked to the chat in the period, with no active hour and no rate per active hour', async () => {
    const store = await observed()

    const report = reportOf(store, { from: epochAt(10800) })

    expect(report).toMatchObject({
      runs: [{ run: beta, solver: { totals: solverOf(0, 0) }, chat: betaChat, duration_ms: 0, active_hours: 0 }],
      observer: { calls: 0 },
      probes: { calls: 0, latency_ms: null },
      active_hours: 0,
      per_active_hour: null,
    })
    expect(report?.runs).toHaveLength(1)
  })

  test('gives an observer call that requested materials with both of its phases', async () => {
    const store = await observed()

    const { calls } = createReadQueries({
      store,
      observer: () => ({ state: { state: 'ok' }, isolation_unverified: false }),
    }).observerCalls(alpha) ?? { calls: [] }

    expect(calls.map(({ id, outcome, usage, latency_ms }) => ({ id, outcome, usage, latency_ms }))).toEqual([
      { id: call('batch'), outcome: 'accepted', usage: firstBatch, latency_ms: 12_000 },
      {
        id: call('follow-up'),
        outcome: 'accepted',
        usage: { model: 'claude-opus-5-5', tokens: tokens(200, 2500, 0, 90), cost_usd: 0.625 },
        latency_ms: 20_000,
      },
      { id: call('timeout'), outcome: 'failed', usage: null, latency_ms: 30_000 },
    ])
  })
})

const sampleFile = (runtime: 'claude' | 'codex', path: string, lines: readonly string[], ino: bigint): CollectorBatch =>
  jsonlFile({ runtime, path, lines, ino }).batch(1, lines.length)

const withoutRecords = (lines: readonly string[]): string[] =>
  lines.filter((record) => (JSON.parse(record) as { type: string }).type !== 'token_usage_record')

const forks = async (): Promise<Store> => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store, { all: true })
  const forkMeta = { forked_from_id: 'legacy', forked_from_ordinal_exclusive: 3 }
  const codexSessions = '/home/.codex/sessions'
  await engine.ingest(sampleFile('codex', `${codexSessions}/legacy.jsonl`, withoutRecords(codexRollout({ thread: 'legacy', cwd })), 1n))
  await engine.ingest(
    sampleFile(
      'codex',
      `${codexSessions}/legacy-fork.jsonl`,
      withoutRecords(codexRollout({ thread: 'legacy-fork', cwd, sessionMeta: forkMeta })),
      2n,
    ),
  )
  await engine.ingest(sampleFile('claude', `${projects}/parent.jsonl`, claudeTranscript({ session: 'parent', cwd }), 3n))
  await engine.ingest(sampleFile('claude', `${projects}/fork.jsonl`, claudeForkTranscript({ session: 'fork', cwd }), 4n))
  return store
}

const idle = totals(0, [0, 0, 0, 0])

describe('the usage report of forks and of threads without usage records', () => {
  test('gives the total of a Codex thread without usage records next to the solver journal, never in it', async () => {
    const store = await forks()
    const legacy = objectId({ kind: 'agent', runtime: 'codex', session: 'legacy', agent: { kind: 'main' } })

    const report = reportOf(store, { run: runId(sessionKey('codex', 'legacy')) })

    expect(report?.runs).toEqual([
      expect.objectContaining({
        solver: expect.objectContaining({
          totals: idle,
          sessions: [
            expect.objectContaining({
              fork: false,
              totals: idle,
              thread_totals: [
                {
                  agent: legacy,
                  tokens: {
                    uncached_input_tokens: 4366,
                    cache_read_input_tokens: 38_656,
                    cache_write_input_tokens: 0,
                    output_tokens: 38,
                    reasoning_output_tokens: 0,
                  },
                },
              ],
            }),
          ],
        }) as unknown,
      }),
    ])
    expect(report?.totals.solver).toEqual(idle)
    expect(report?.active_hours).toBeGreaterThan(0)
    expect(report?.per_active_hour?.solver).toMatchObject({ tokens: tokens(0, 0, 0, 0), records: 0 })
    expect(reportOf(store, { run: runId(sessionKey('codex', 'legacy-fork')) })?.runs[0]?.solver.sessions).toEqual([
      expect.objectContaining({ fork: true, totals: idle, thread_totals: [] }),
    ])
  })

  test('marks a Claude fork, whose Claude Code total includes the inherited usage, and counts only its own records', async () => {
    const store = await forks()

    const fork = reportOf(store, { run: runId(sessionKey('claude', 'fork')) })
    const parent = reportOf(store, { run: runId(sessionKey('claude', 'parent')) })

    expect(fork?.totals.solver).toEqual({
      ...totals(1, [2, 18_341, 427, 5]),
      tokens: { ...tokens(2, 18_341, 427, 5), reasoning_output_tokens: 0 },
    })
    expect(fork?.runs[0]?.solver.sessions).toEqual([
      expect.objectContaining({
        fork: true,
        cost_state: expect.objectContaining({ total_cost_usd: 0.102586 }) as unknown,
        cost_state_final: true,
        thread_totals: [],
      }),
    ])
    expect(parent?.runs[0]?.solver.sessions).toEqual([expect.objectContaining({ fork: false, thread_totals: [] })])
  })
})
