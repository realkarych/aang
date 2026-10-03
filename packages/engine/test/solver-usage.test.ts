import {
  type ActionId,
  ChangeSeq,
  type CollectorBatch,
  EpochNs,
  type Fact,
  LinkId,
  type RunId,
  type Runtime,
  StageId,
  type TokenUsage,
  type UsageRecord,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import {
  applyChangeSet,
  createReadQueries,
  type Engine,
  solverUsage,
  type StageDraft,
  stageUsage,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { describe, expect, onTestFinished, test } from 'vitest'
import { hookBatch, type JsonlFile, jsonlFile } from './batches.js'
import { factsOf, sessionKey, startEngine } from './harness.js'
import { createHome } from './home.js'
import { claudeForkTranscript, claudeHook, claudeTranscript, codexChildRollout, codexRollout } from './samples.js'

const cwd = '/work/project'
const projects = '/home/.claude/projects/-work-project'
const codexSessions = '/home/.codex/sessions'
const origin = Date.parse('2026-10-02T12:00:00.000Z')
const everything = ChangeSeq.parse(0)

const isoAt = (second: number): string => new Date(origin + second * 1000).toISOString()
const epochOf = (iso: string): EpochNs => EpochNs.parse(BigInt(Date.parse(iso)) * 1_000_000n)
const epochAt = (second: number): EpochNs => epochOf(isoAt(second))

const sessionOf = (runtime: Runtime, session: string) => objectId(sessionKey(runtime, session))
const runOf = (runtime: Runtime, session: string) => runId(sessionKey(runtime, session))
const mainOf = (runtime: Runtime, session: string) =>
  objectId({ kind: 'agent', runtime, session, agent: { kind: 'main' } })
const subagentOf = (session: string, agent: string) =>
  objectId({ kind: 'agent', runtime: 'claude', session, agent: { kind: 'subagent', agent_id: agent } })
const threadOf = (session: string, thread: string) =>
  objectId({ kind: 'agent', runtime: 'codex', session, agent: { kind: 'thread', thread_id: thread } })
const actionOf = (runtime: Runtime, session: string, call: string): ActionId =>
  objectId({ kind: 'action', runtime, session, call })

const tokens = (records: number, output: number, reasoning: number | null = null): TokenUsage => ({
  uncached_input_tokens: 3 * records,
  cache_read_input_tokens: 1000 * records,
  cache_write_input_tokens: 100 * records,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
})

const totals = (records: number, usage: TokenUsage, lowerBound = false) => ({
  tokens: usage,
  records,
  output_lower_bound: lowerBound,
  cost_usd: null,
})

interface Reply {
  readonly id: string
  readonly content: readonly object[]
  readonly output: number
  readonly stop?: string
  readonly thinking?: number
  readonly model?: string
}

const prompt = (uuid: string, second: number, text: string) => ({
  type: 'user',
  uuid,
  timestamp: isoAt(second),
  message: { role: 'user', content: text },
})

const reply = (uuid: string, second: number, { id, content, output, stop, thinking, model }: Reply) => ({
  type: 'assistant',
  uuid,
  timestamp: isoAt(second),
  message: {
    id,
    model: model ?? 'claude-opus-5-5',
    role: 'assistant',
    content,
    stop_reason: stop ?? null,
    usage: {
      input_tokens: model === '<synthetic>' ? 0 : 3,
      cache_creation_input_tokens: model === '<synthetic>' ? 0 : 100,
      cache_read_input_tokens: model === '<synthetic>' ? 0 : 1000,
      output_tokens: output,
      ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
    },
  },
})

const toolResult = (uuid: string, second: number, call: string) => ({
  type: 'user',
  uuid,
  timestamp: isoAt(second),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: 'ok' }] },
})

const text = (value: string) => ({ type: 'text', text: value })
const thinking = { type: 'thinking', thinking: '' }
const toolUse = (id: string, name = 'Bash') => ({ type: 'tool_use', id, name, input: { command: 'pnpm test' } })

const claudeLine = (session: string, agent: string | null, record: object): string =>
  JSON.stringify({
    sessionId: session,
    cwd,
    version: '2.1.286',
    ...(agent === null ? {} : { isSidechain: true, agentId: agent }),
    ...record,
  })

const mainFile = (session: string, records: readonly object[], ino: bigint): CollectorBatch => {
  const lines = records.map((record) => claudeLine(session, null, record))
  return jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines, ino }).batch(1, lines.length)
}

const agentFile = (session: string, agent: string, records: readonly object[], ino: bigint): CollectorBatch => {
  const lines = records.map((record) => claudeLine(session, agent, record))
  const path = `${projects}/${session}/subagents/agent-${agent}.jsonl`
  return jsonlFile({ runtime: 'claude', path, lines, ino }).batch(1, lines.length)
}

const codexFile = (thread: string, lines: readonly string[], ino: bigint): CollectorBatch =>
  jsonlFile({ runtime: 'codex', path: `${codexSessions}/${thread}.jsonl`, lines, ino }).batch(1, lines.length)

interface Ingested {
  readonly store: Store
  readonly engine: Engine
}

const ingested = async (batches: readonly CollectorBatch[]): Promise<Ingested> => {
  const store = (await createHome(onTestFinished)).open()
  const engine = startEngine(store, { all: true })
  for (const batch of batches) {
    await engine.ingest(batch)
  }
  return { store, engine }
}

const readsOf = (store: Store) =>
  createReadQueries({ store, observer: () => ({ state: { state: 'ok' }, isolation_unverified: false }) })

const withoutCounters = (record: UsageRecord): object =>
  Object.fromEntries(Object.entries(record).filter(([field]) => field !== 'change_seq'))

const recordOf = (store: Store, runtime: Runtime, session: string, usage: string) =>
  store.observations.getUsage(objectId({ kind: 'usage', runtime, session, usage }))

const parallel = 'parallel'

const parallelMain = [
  prompt('p-1', 0, 'Review the parser in parallel'),
  reply('m-1a', 1, { id: 'msg-main-1', content: [thinking], output: 7, thinking: 5 }),
  reply('m-1b', 1, { id: 'msg-main-1', content: [toolUse('call-a', 'Agent')], output: 50, thinking: 5 }),
  reply('m-1c', 1, { id: 'msg-main-1', content: [toolUse('call-b', 'Agent')], output: 120, stop: 'tool_use', thinking: 5 }),
  toolResult('r-a', 60, 'call-a'),
  toolResult('r-b', 60, 'call-b'),
  reply('m-synthetic', 61, { id: 'msg-synthetic', content: [text('No response requested.')], output: 0, stop: 'stop_sequence', model: '<synthetic>' }),
  reply('m-2', 61, { id: 'msg-main-2', content: [text('Both reviews are done')], output: 30, stop: 'end_turn' }),
]

const parallelAgent = (agent: string, outputs: readonly [number, number]) => [
  prompt(`${agent}-p`, 2, 'Review one half'),
  reply(`${agent}-1`, 30, { id: `msg-${agent}-1`, content: [text('Looking')], output: outputs[0] }),
  reply(`${agent}-2`, 58, { id: `msg-${agent}-2`, content: [text('Done')], output: outputs[1] }),
]

const parallelRun = (main: readonly object[] = parallelMain): CollectorBatch[] => [
  mainFile(parallel, main, 1n),
  agentFile(parallel, 'agent-a', parallelAgent('agent-a', [40, 60]), 2n),
  agentFile(parallel, 'agent-b', parallelAgent('agent-b', [45, 65]), 3n),
]

describe('Claude usage records', () => {
  test('count a message written as several records once, with its largest output', async () => {
    const { store } = await ingested(parallelRun())

    expect(recordOf(store, 'claude', parallel, 'msg-main-1')).toMatchObject({
      session: sessionOf('claude', parallel),
      agent: mainOf('claude', parallel),
      run: runOf('claude', parallel),
      model: 'claude-opus-5-5',
      tokens: tokens(1, 120, 5),
      output_lower_bound: false,
      synthetic: false,
      inherited: false,
      at: epochAt(1),
    })
    expect(store.observations.usageRecords(sessionOf('claude', parallel))).toHaveLength(7)
  })

  test('keep a <synthetic> message out of every total', async () => {
    const { store } = await ingested(parallelRun())
    const { journal, agents } = solverUsage(store, runOf('claude', parallel))

    expect(recordOf(store, 'claude', parallel, 'msg-synthetic')).toMatchObject({ synthetic: true, model: '<synthetic>' })
    expect(journal.totals.records).toBe(6)
    expect(agents.find(({ agent }) => agent === mainOf('claude', parallel))?.totals.records).toBe(2)
  })

  test('mark the output of a subagent message without stop_reason as a lower bound', async () => {
    const { store } = await ingested(parallelRun())
    const { journal, agents } = solverUsage(store, runOf('claude', parallel))

    expect(recordOf(store, 'claude', parallel, 'msg-agent-a-1')).toMatchObject({
      agent: subagentOf(parallel, 'agent-a'),
      tokens: tokens(1, 40),
      output_lower_bound: true,
    })
    expect(journal.totals).toEqual(totals(6, tokens(6, 360, 5), true))
    expect(agents.map(({ agent, totals: usage }) => [agent, usage])).toEqual(
      expect.arrayContaining([
        [mainOf('claude', parallel), totals(2, tokens(2, 150, 5))],
        [subagentOf(parallel, 'agent-a'), totals(2, tokens(2, 100), true)],
        [subagentOf(parallel, 'agent-b'), totals(2, tokens(2, 110), true)],
      ]),
    )
    expect(journal.sessions).toEqual([
      {
        session: sessionOf('claude', parallel),
        totals: totals(6, tokens(6, 360, 5), true),
        cost_state: null,
        cost_state_final: false,
      },
    ])
  })
})

describe('time of a run', () => {
  test('is the span from the first to the last activity, not the sum of parallel agents', async () => {
    const { store } = await ingested(parallelRun())
    const { time, agents } = solverUsage(store, runOf('claude', parallel))
    const active = new Map(agents.map(({ agent, active_ms: ms }) => [agent, ms]))

    expect(time).toEqual({ started_at: epochAt(0), ended_at: epochAt(61), duration_ms: 61_000, pauses: [] })
    expect(active).toEqual(
      new Map([
        [mainOf('claude', parallel), 61_000],
        [subagentOf(parallel, 'agent-a'), 56_000],
        [subagentOf(parallel, 'agent-b'), 56_000],
      ]),
    )
    const sum = [...active.values()].reduce((total, ms) => total + ms, 0)
    expect(sum).toBe(173_000)
    expect(time.duration_ms).not.toBe(sum)
  })

  test('shows a long silence as a pause and leaves it out of the active time of agents', async () => {
    const later = [
      ...parallelMain,
      prompt('p-2', 1200, 'One more check'),
      reply('m-3', 1205, { id: 'msg-main-3', content: [text('Checked')], output: 20, stop: 'end_turn' }),
    ]
    const { store } = await ingested(parallelRun(later))
    const { time, agents } = solverUsage(store, runOf('claude', parallel))

    expect(time).toEqual({
      started_at: epochAt(0),
      ended_at: epochAt(1205),
      duration_ms: 1_205_000,
      pauses: [{ started_at: epochAt(61), ended_at: epochAt(1200) }],
    })
    expect(agents.find(({ agent }) => agent === mainOf('claude', parallel))?.active_ms).toBe(66_000)
    expect(solverUsage(store, runOf('claude', parallel), { pauseAfterMs: 1_200_000 }).time.pauses).toEqual([])
  })

  test('does not take the reading time of a line without a timestamp for activity', async () => {
    const session = 'backfilled'
    const lines = claudeTranscript({ session, cwd })
    const file = jsonlFile({ runtime: 'claude', path: `${projects}/${session}.jsonl`, lines, ino: 1n })
    const readAfter = async (hours: bigint) => {
      const batch = file.batch(1, lines.length)
      const records = batch.records.map((record) => ({
        ...record,
        observed_at: EpochNs.parse(record.observed_at + hours * 3_600_000_000_000n),
      }))
      const { store } = await ingested([{ ...batch, records }])
      return solverUsage(store, runOf('claude', session))
    }

    const onTime = await readAfter(0n)
    const later = await readAfter(1n)

    expect(onTime.time).toEqual({
      started_at: epochOf('2026-10-01T11:49:30.942Z'),
      ended_at: epochOf('2026-10-01T11:57:53.500Z'),
      duration_ms: 502_558,
      pauses: [],
    })
    expect(later.time).toEqual(onTime.time)
    expect(later.agents).toEqual(onTime.agents)
  })

  test('takes the time of hooks, which are written when they fire', async () => {
    const session = 'hooked'
    const hook = (file: string, name: string, second: number) => ({
      file,
      arrival: second * 1_000_000_000,
      payload: claudeHook(name, { session, cwd }),
    })
    const { store } = await ingested([
      hookBatch(
        hook('start.evt', 'SessionStart.startup.json', 0),
        hook('prompt.evt', 'UserPromptSubmit.json', 2),
        hook('stop.evt', 'Stop.json', 90),
      ),
    ])

    expect(solverUsage(store, runOf('claude', session)).time.duration_ms).toBe(90_000)
  })
})

describe('Claude fork', () => {
  const original = 'original'
  const fork = 'fork'
  const ownMessage = 'msg_011CfbUJspJNWUmrMrqKz5DE'

  const originalLines = () => claudeTranscript({ session: original, cwd })
  const forkLines = () => claudeForkTranscript({ session: fork, cwd })
  const originalJsonl = () =>
    jsonlFile({ runtime: 'claude', path: `${projects}/${original}.jsonl`, lines: originalLines(), ino: 1n })
  const originalFile = () => {
    const file = originalJsonl()
    return file.batch(1, file.lines.length)
  }
  const forkFile = () => {
    const lines = forkLines()
    return jsonlFile({ runtime: 'claude', path: `${projects}/${fork}.jsonl`, lines, ino: 2n }).batch(1, lines.length)
  }

  const messageTokens = (lines: readonly string[]): Map<string, TokenUsage> => {
    const messages = new Map<string, TokenUsage>()
    for (const line of lines) {
      const record = JSON.parse(line) as {
        type: string
        message?: {
          id: string
          usage: {
            input_tokens: number
            cache_read_input_tokens: number
            cache_creation_input_tokens: number
            output_tokens: number
            output_tokens_details: { thinking_tokens: number }
          }
        }
      }
      if (record.type === 'assistant' && record.message !== undefined) {
        const { usage } = record.message
        messages.set(record.message.id, {
          uncached_input_tokens: usage.input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_write_input_tokens: usage.cache_creation_input_tokens,
          output_tokens: usage.output_tokens,
          reasoning_output_tokens: usage.output_tokens_details.thinking_tokens,
        })
      }
    }
    return messages
  }

  const summed = (usages: readonly TokenUsage[]): TokenUsage =>
    usages.reduce((sum, usage) => ({
      uncached_input_tokens: sum.uncached_input_tokens + usage.uncached_input_tokens,
      cache_read_input_tokens: sum.cache_read_input_tokens + usage.cache_read_input_tokens,
      cache_write_input_tokens: sum.cache_write_input_tokens + usage.cache_write_input_tokens,
      output_tokens: sum.output_tokens + usage.output_tokens,
      reasoning_output_tokens: (sum.reasoning_output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
    }))

  test.each([
    ['after the original', () => [originalFile(), forkFile()]],
    ['before the original', () => [forkFile(), originalFile()]],
  ])('does not double the usage of the copied history when read %s', async (_, batches) => {
    const { store } = await ingested(batches())
    const originals = messageTokens(originalLines())
    const forked = messageTokens(forkLines())
    const own = forked.get(ownMessage)
    const forkRecords = store.observations.usageRecords(sessionOf('claude', fork))

    expect(forkRecords.map(({ key, inherited }) => [key.usage, inherited]).sort()).toEqual(
      [...forked.keys()].map((id) => [id, id !== ownMessage]).sort(),
    )
    expect(solverUsage(store, runOf('claude', fork)).journal.totals).toEqual(totals(1, own ?? tokens(0, 0)))
    expect(solverUsage(store, runOf('claude', original)).journal.totals).toEqual(
      totals(originals.size, summed([...originals.values()])),
    )
    expect(new Set([...originals.keys(), ...forked.keys()]).size).toBe(originals.size + 1)
  })

  test('without the original counts the same own usage', async () => {
    const alone = await ingested([forkFile()])
    const both = await ingested([forkFile(), originalFile()])

    expect(solverUsage(alone.store, runOf('claude', fork)).journal).toEqual(
      solverUsage(both.store, runOf('claude', fork)).journal,
    )
    expect(alone.store.observations.usageRecords(sessionOf('claude', fork)).map(withoutCounters)).toEqual(
      both.store.observations.usageRecords(sessionOf('claude', fork)).map(withoutCounters),
    )
  })

  test('keeps the last cost-state of each session, final once the launch that wrote it ends', async () => {
    const { store } = await ingested([originalFile(), forkFile()])
    const sessions = (run: RunId) => solverUsage(store, run).journal.sessions

    expect(sessions(runOf('claude', original))).toEqual([
      expect.objectContaining({
        cost_state: expect.objectContaining({ total_cost_usd: 0.19517879999999999 }) as unknown,
        cost_state_final: true,
      }),
    ])
    expect(sessions(runOf('claude', fork))).toEqual([
      expect.objectContaining({
        cost_state: expect.objectContaining({ total_cost_usd: 0.102586 }) as unknown,
        cost_state_final: true,
      }),
    ])
  })

  test('does not call the cost-state final while a later launch is running', async () => {
    const file = originalJsonl()
    const { store, engine } = await ingested([file.batch(1, 60)])
    const session = () => solverUsage(store, runOf('claude', original)).journal.sessions[0]

    expect(session()).toMatchObject({
      cost_state: { total_cost_usd: 0.0953938 },
      cost_state_final: false,
    })
    await engine.ingest(file.batch(61, file.lines.length))
    expect(session()).toMatchObject({
      cost_state: { total_cost_usd: 0.19517879999999999 },
      cost_state_final: true,
    })
  })
})

describe('Claude cost-state', () => {
  const session = 'resumed'
  const path = `${projects}/${session}.jsonl`
  const lines = claudeTranscript({ session, cwd })
  const lastCost = 0.19517879999999999
  const transcript = (content: readonly string[], ino = 1n, at = path) =>
    jsonlFile({ runtime: 'claude', path: at, lines: content, ino })
  const whole = (content: readonly string[]) => transcript(content).batch(1, content.length)
  const costState = (store: Store) => solverUsage(store, runOf('claude', session)).journal.sessions[0]
  const hook = (file: string, name: string) =>
    hookBatch({ file, arrival: 1_000_000_000, payload: claudeHook(name, { session, cwd }) })
  const laterLine = (record: object) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      uuid: 'line-after-cost-state',
      timestamp: '2026-10-01T12:05:00.000Z',
      sessionId: session,
      cwd,
      ...record,
    })

  test('is not final once a hook resumes the session, before its first new line', async () => {
    const { store, engine } = await ingested([whole(lines)])
    expect(costState(store)).toMatchObject({ cost_state: { total_cost_usd: lastCost }, cost_state_final: true })

    await engine.ingest(hook('resume.evt', 'SessionStart.resume.json'))

    expect(costState(store)).toMatchObject({ cost_state: { total_cost_usd: lastCost }, cost_state_final: false })
  })

  test('stays final after the hooks that end the launch which wrote it', async () => {
    const { store, engine } = await ingested([whole(lines)])

    await engine.ingest(hook('end.evt', 'SessionEnd.json'))

    expect(costState(store)).toMatchObject({ cost_state: { total_cost_usd: lastCost }, cost_state_final: true })
  })

  test.each([
    ['a context attachment without facts', { type: 'attachment', attachment: { type: 'environment', snapshot: {} } }],
    ['a line of an unknown type', { type: 'unknown-line' }],
    ['a line stamped before the launch that wrote it', { type: 'unknown-line', timestamp: '2026-10-01T11:00:00.000Z' }],
  ])('is not final once the transcript goes on with %s', async (_, record) => {
    const { store } = await ingested([whole([...lines, laterLine(record)])])

    expect(costState(store)).toMatchObject({ cost_state: { total_cost_usd: lastCost }, cost_state_final: false })
  })

  const superseded = `${path}.superseded-1790856000000`
  const current = () => transcript([...lines.slice(0, 2), ...lines.slice(69)], 1n)
  const previous = () => transcript(lines.slice(0, 69), 2n, superseded)
  const all = (file: JsonlFile) => file.batch(1, file.lines.length)

  test.each([
    ['in parts out of order', () => [transcript(lines).batch(1, 1), transcript(lines).batch(70, 97), transcript(lines).batch(2, 69)]],
    ['from a superseded file read after the current one', () => [all(current()), all(previous())]],
    ['from a superseded file read before the current one', () => [all(previous()), all(current())]],
  ])('is the last of the transcript when it arrives %s', async (_, batches) => {
    const { store } = await ingested(batches())

    expect(costState(store)).toMatchObject({ cost_state: { total_cost_usd: lastCost }, cost_state_final: true })
  })
})

describe('Codex usage records', () => {
  const root = 'codex-root'
  const child = 'codex-child'

  const threadTotals = (store: Store, session: string): Map<string, TokenUsage> => {
    const last = new Map<string, Fact>()
    for (const fact of factsOf(store)) {
      if (
        fact.kind === 'usage_total' &&
        fact.payload.source === 'thread_token_usage' &&
        fact.entity_key.session === session
      ) {
        const thread = fact.runtime_ids.thread_id ?? ''
        const previous = last.get(thread)
        if (previous === undefined || (fact.runtime_ids.ordinal ?? 0) > (previous.runtime_ids.ordinal ?? 0)) {
          last.set(thread, fact)
        }
      }
    }
    return new Map(
      [...last].flatMap(([thread, fact]) => (fact.kind === 'usage_total' ? [[thread, fact.payload.tokens]] : [])),
    )
  }

  test('of each thread sum to its last thread_token_usage', async () => {
    const { store } = await ingested([
      codexFile(root, codexRollout({ thread: root, cwd }), 1n),
      codexFile(child, codexChildRollout({ root, thread: child, cwd }), 2n),
    ])
    const { journal, agents } = solverUsage(store, runOf('codex', root))
    const expected = threadTotals(store, root)
    const byAgent = new Map(agents.map(({ agent, totals: usage }) => [agent, usage]))

    expect(byAgent.get(mainOf('codex', root))?.tokens).toEqual(expected.get(root))
    expect(byAgent.get(threadOf(root, child))?.tokens).toEqual(expected.get(child))
    expect(byAgent.get(mainOf('codex', root))?.records).toBe(4)
    expect(journal.totals.records).toBe(5)
    expect(journal.totals.output_lower_bound).toBe(false)
    expect(store.observations.agents(sessionOf('codex', root)).map(({ thread_total: total }) => total)).toEqual([
      null,
      null,
    ])
  })

  const parent = 'codex-parent'
  const forked = 'codex-fork'
  const forkMeta = { forked_from_id: parent, forked_from_ordinal_exclusive: 3 }

  const inheritingCounter = (lines: readonly string[], inherited: TokenUsage): string[] =>
    lines.map((line) => {
      const record = JSON.parse(line) as { type: string; payload: Record<string, unknown> }
      const counter = record.payload['thread_token_usage'] as Record<string, number> | undefined
      if (record.type !== 'token_usage_record' || counter === undefined) {
        return line
      }
      const cached = (counter['cached_input_tokens'] ?? 0) + inherited.cache_read_input_tokens
      return JSON.stringify({
        ...record,
        payload: {
          ...record.payload,
          thread_token_usage: {
            ...counter,
            input_tokens:
              (counter['input_tokens'] ?? 0) + inherited.uncached_input_tokens + inherited.cache_read_input_tokens,
            cached_input_tokens: cached,
            output_tokens: (counter['output_tokens'] ?? 0) + inherited.output_tokens,
          },
        },
      })
    })

  test('of a fork count only its own records while its thread_token_usage includes the parent', async () => {
    const parentOnly = await ingested([codexFile(parent, codexRollout({ thread: parent, cwd }), 1n)])
    const parentTotals = solverUsage(parentOnly.store, runOf('codex', parent)).journal.totals
    const forkLines = inheritingCounter(codexRollout({ thread: forked, cwd, sessionMeta: forkMeta }), parentTotals.tokens)
    const { store } = await ingested([
      codexFile(parent, codexRollout({ thread: parent, cwd }), 1n),
      codexFile(forked, forkLines, 2n),
    ])
    const forkJournal = solverUsage(store, runOf('codex', forked)).journal

    expect(forkJournal.totals).toEqual(parentTotals)
    expect(threadTotals(store, forked).get(forked)).not.toEqual(forkJournal.totals.tokens)
    expect(solverUsage(store, runOf('codex', parent)).journal.totals).toEqual(parentTotals)
  })

  const withoutRecords = (lines: readonly string[]): string[] =>
    lines.filter((line) => (JSON.parse(line) as { type: string }).type !== 'token_usage_record')

  const lastTokenCount = (lines: readonly string[]): TokenUsage => {
    const counts = lines.flatMap((line) => {
      const record = JSON.parse(line) as {
        type: string
        payload: { type?: string; info?: { total_token_usage: Record<string, number> } | null }
      }
      const total = record.payload.info?.total_token_usage
      return record.type === 'event_msg' && record.payload.type === 'token_count' && total !== undefined ? [total] : []
    })
    const last = counts.at(-1) ?? {}
    const cached = last['cached_input_tokens'] ?? 0
    return {
      uncached_input_tokens: (last['input_tokens'] ?? 0) - cached,
      cache_read_input_tokens: cached,
      cache_write_input_tokens: last['cache_write_input_tokens'] ?? 0,
      output_tokens: last['output_tokens'] ?? 0,
      reasoning_output_tokens: last['reasoning_output_tokens'] ?? null,
    }
  }

  test('of a thread without token_usage_record fall back to its last total, except for a fork', async () => {
    const lines = withoutRecords(codexRollout({ thread: root, cwd }))
    const { store } = await ingested([
      codexFile(root, lines, 1n),
      codexFile(forked, withoutRecords(codexRollout({ thread: forked, cwd, sessionMeta: forkMeta })), 2n),
    ])

    expect(store.observations.getAgent(mainOf('codex', root))?.thread_total).toEqual(lastTokenCount(lines))
    expect(solverUsage(store, runOf('codex', root)).journal.totals.records).toBe(0)
    expect(store.observations.getAgent(mainOf('codex', forked))?.thread_total).toBeNull()
  })

  test('of a thread without token_usage_record keep the total of its last ordinal when the earlier file is read last', async () => {
    const lines = withoutRecords(codexRollout({ thread: root, cwd }))
    const middle = Math.floor(lines.length / 2)
    const archived = lines.slice(0, middle)
    const { store } = await ingested([
      codexFile(root, [...lines.slice(0, 1), ...lines.slice(middle)], 1n),
      jsonlFile({ runtime: 'codex', path: `/home/.codex/archived_sessions/${root}.jsonl`, lines: archived, ino: 2n }).batch(
        1,
        archived.length,
      ),
    ])

    expect(lastTokenCount(archived)).not.toEqual(lastTokenCount(lines))
    expect(store.observations.getAgent(mainOf('codex', root))?.thread_total).toEqual(lastTokenCount(lines))
  })
})

const stageDraft = (id: StageId, run: RunId): StageDraft => ({
  id,
  run,
  title: id,
  expected_result: null,
  summary: null,
  parent: null,
  origin: 'inferred',
  lifecycle: { state: 'active' },
  execution: { value: { state: 'running' }, basis: { kind: 'observed' }, evidence: [] },
  execution_claim: null,
  decision: { value: 'none', basis: { kind: 'observed' }, evidence: [] },
  session_moved: false,
  basis: { kind: 'observed' },
  evidence: [],
})

const assign = (store: Store, run: RunId, assignments: readonly (readonly [ActionId, StageId])[]): void => {
  const stages = [...new Set(assignments.map(([, stage]) => stage))]
  store.transaction((transaction) =>
    applyChangeSet(transaction, {
      run,
      author: 'rule',
      at: epochAt(100),
      changes: [
        ...stages
          .filter((stage) => transaction.model.entity(run, { kind: 'stage', id: stage }) === null)
          .map((stage) => ({
            op: 'stage.create' as const,
            put: { kind: 'stage' as const, value: stageDraft(stage, run) },
            basis: { kind: 'observed' as const },
            evidence: [],
          })),
        ...assignments.map(([action, stage]) => ({
          op: 'actions.assign' as const,
          put: {
            kind: 'link' as const,
            value: {
              id: LinkId.parse(`assign-${action}-${stage}`),
              run,
              basis: { kind: 'observed' as const },
              evidence: [],
              kind: 'assignment' as const,
              action,
              stage,
            },
          },
          basis: { kind: 'observed' as const },
          evidence: [],
        })),
      ],
    }),
  )
}

describe('usage of a stage', () => {
  const staged = 'staged'
  const build = StageId.parse('stage-build')
  const check = StageId.parse('stage-test')
  const stagedFile = () =>
    mainFile(
      staged,
      [
        prompt('s-p', 0, 'Build and test'),
        reply('s-1', 1, { id: 'msg-build', content: [toolUse('call-build')], output: 11, stop: 'tool_use' }),
        toolResult('s-r1', 2, 'call-build'),
        reply('s-2', 3, { id: 'msg-test', content: [toolUse('call-test')], output: 22, stop: 'tool_use' }),
        toolResult('s-r2', 4, 'call-test'),
        reply('s-3', 5, { id: 'msg-done', content: [text('Built and tested')], output: 33, stop: 'end_turn' }),
      ],
      1n,
    )

  test('is the exact sum of responses whose actions all belong to it; the rest stays unassigned', async () => {
    const { store } = await ingested([stagedFile()])
    const run = runOf('claude', staged)
    assign(store, run, [
      [actionOf('claude', staged, 'call-build'), build],
      [actionOf('claude', staged, 'call-test'), check],
    ])
    const { journal } = solverUsage(store, run)

    expect(journal.stages).toEqual([
      { stage: build, totals: totals(1, tokens(1, 11)) },
      { stage: check, totals: totals(1, tokens(1, 22)) },
    ])
    expect(journal.unassigned).toEqual(totals(1, tokens(1, 33)))
    expect(journal.totals).toEqual(totals(3, tokens(3, 66)))
    expect(stageUsage(store, run, build)).toEqual({
      stage: totals(1, tokens(1, 11)),
      unassigned_in_sessions: totals(1, tokens(1, 33)),
    })
    expect(readsOf(store).inspector(run, check)?.usage).toEqual({
      stage: totals(1, tokens(1, 22)),
      unassigned_in_sessions: totals(1, tokens(1, 33)),
    })
  })

  test('leaves a response unassigned when one of its actions belongs to two stages', async () => {
    const { store } = await ingested([stagedFile()])
    const run = runOf('claude', staged)
    assign(store, run, [
      [actionOf('claude', staged, 'call-build'), build],
      [actionOf('claude', staged, 'call-build'), check],
      [actionOf('claude', staged, 'call-test'), check],
    ])
    const { journal } = solverUsage(store, run)

    expect(journal.stages).toEqual([{ stage: check, totals: totals(1, tokens(1, 22)) }])
    expect(journal.unassigned).toEqual(totals(2, tokens(2, 44)))
    expect(stageUsage(store, run, build)).toEqual({
      stage: totals(0, tokens(0, 0)),
      unassigned_in_sessions: totals(2, tokens(2, 44)),
    })
  })

  const codexStaged = 'codex-staged'
  const cell = 'call_MxHF39QIUjLqImvlqfhdfE2y'
  const command = 'exec-a8b47079-66cf-4c58-ba7c-268717fda6fb'
  const stage = StageId.parse('stage-echo')

  test.each([
    ['every action of the turn belongs to the stage', [cell, command], 2],
    ['an action of the turn is not assigned', [cell], 0],
  ])('of Codex counts the responses of a turn only when %s', async (_, calls, records) => {
    const { store } = await ingested([codexFile(codexStaged, codexRollout({ thread: codexStaged, cwd }), 1n)])
    const run = runOf('codex', codexStaged)
    assign(store, run, calls.map((call) => [actionOf('codex', codexStaged, call), stage] as const))
    const { journal } = solverUsage(store, run)

    expect(journal.stages.map(({ totals: usage }) => usage.records)).toEqual(records === 0 ? [] : [records])
    expect(journal.unassigned.records).toBe(4 - records)
  })
})

describe('usage after a transfer and a reparse', () => {
  const host = 'host'
  const guest = 'guest'
  const sessionFile = (session: string, ino: bigint) =>
    mainFile(
      session,
      [
        prompt(`${session}-p`, 0, 'Work'),
        reply(`${session}-1`, 1, { id: `msg-${session}`, content: [text('Done')], output: 10, stop: 'end_turn' }),
      ],
      ino,
    )

  test('moves with the session to the run it is attached to and back', async () => {
    const { store, engine } = await ingested([sessionFile(host, 1n), sessionFile(guest, 2n)])
    const hostRun = runOf('claude', host)
    const guestRun = runOf('claude', guest)

    const { binding } = await engine.bind({ kind: 'attach', session: sessionOf('claude', guest), run: hostRun })
    expect(solverUsage(store, hostRun).journal.totals).toEqual(totals(2, tokens(2, 20)))
    expect(solverUsage(store, hostRun).journal.sessions.map(({ session }) => session)).toEqual(
      [sessionOf('claude', host), sessionOf('claude', guest)].sort(),
    )
    expect(solverUsage(store, guestRun).journal.totals).toEqual(totals(0, tokens(0, 0)))

    await engine.revokeBinding(binding.id)
    expect(solverUsage(store, hostRun).journal.totals).toEqual(totals(1, tokens(1, 10)))
    expect(solverUsage(store, guestRun).journal.totals).toEqual(totals(1, tokens(1, 10)))
  })

  test('keeps the same records after a reparse', async () => {
    const { store, engine } = await ingested(parallelRun())
    const before = store.observations.usageRecords(sessionOf('claude', parallel)).map(withoutCounters)

    await engine.reparse()

    expect(store.observations.usageRecords(sessionOf('claude', parallel)).map(withoutCounters)).toEqual(before)
  })
})

describe('usage records in the reads of a run', () => {
  test('come with its snapshot and its change feed', async () => {
    const [main, ...agentFiles] = parallelRun()
    const { store, engine } = await ingested(main === undefined ? [] : [main])
    const reads = readsOf(store)
    const run = runOf('claude', parallel)
    const usageOf = (records: readonly UsageRecord[]) => records.map(({ key }) => key.usage).sort()
    const before = reads.snapshot(run)

    for (const batch of agentFiles) {
      await engine.ingest(batch)
    }
    const fed = (reads.feed(run, before?.change_seq ?? everything)?.events ?? []).flatMap((event) =>
      event.event === 'facts' ? event.data.objects.usage_records : [],
    )

    expect(usageOf(before?.objects.usage_records ?? [])).toEqual(['msg-main-1', 'msg-main-2', 'msg-synthetic'])
    expect(usageOf(fed)).toEqual(expect.arrayContaining(['msg-agent-a-1', 'msg-agent-a-2', 'msg-agent-b-1', 'msg-agent-b-2']))
    expect(reads.snapshot(run)?.objects.usage_records).toEqual(
      store.observations.usageRecords(sessionOf('claude', parallel)).toSorted((left, right) => (left.id < right.id ? -1 : 1)),
    )
  })
})
