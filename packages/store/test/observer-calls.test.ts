import { type CallUsage, type ChatInput, EpochNs, ModelVersion, ObserverCallId, type ObserverInput, RunId } from '@aang/contract'
import type { ChatCallRecord, ObserverCheck, StoredChatCall } from '@aang/store'
import { expect, test } from 'vitest'
import { createHome } from './home.js'

const run = RunId.parse('a'.repeat(32))

const second = 1_000_000_000n

const at = (seconds: number): EpochNs => EpochNs.parse(1_759_370_000n * second + BigInt(seconds) * second)

const input = (version = 0): ObserverInput => ({
  run: { id: run, runtime: 'claude', goal: null, brief: null, sessions: [], agents: [] },
  context: null,
  model: { version: ModelVersion.parse(version), stages: [], criteria: [], attention: [] },
  batch: { facts: [], collapsed: [], backlog: null, artifact_versions: [] },
  materials: [],
  previous_attempt: null,
})

const usage = (uncached: number, read: number, write: number, output: number): CallUsage => ({
  model: 'claude-opus-5-5',
  cost_usd: null,
  tokens: {
    uncached_input_tokens: uncached,
    cache_read_input_tokens: read,
    cache_write_input_tokens: write,
    output_tokens: output,
    reasoning_output_tokens: 7,
  },
})

const id = (name: string): ObserverCallId => ObserverCallId.parse(name)

const probe = (name: string, seconds: number, changes: Partial<ObserverCheck> = {}): ObserverCheck => ({
  id: id(name),
  kind: 'probe',
  backend: 'claude',
  input: input(),
  output: { base_version: 0, ops: [], needs: [] },
  verdict: 'accepted',
  error: null,
  usage: usage(10, 0, 0, 5),
  started_at: at(seconds),
  finished_at: at(seconds + 2),
  ...changes,
})

test('a batch call keeps the class and message of its backend error, and an accepted batch keeps its delay', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  store.transaction((transaction) => {
    transaction.observerCalls.start({ id: id('failed'), backend: 'claude', input: input(), at: at(0) })
    transaction.observerCalls.finish({
      id: id('failed'),
      output: null,
      verdict: 'failed',
      reasons: [],
      error: { class: 'network', message: 'stream disconnected before completion' },
      at: at(3),
    })
    transaction.observerCalls.start({ id: id('accepted'), backend: 'claude', input: input(), at: at(13) })
    transaction.observerCalls.finish({
      id: id('accepted'),
      output: { base_version: 0, ops: [], needs: [] },
      verdict: 'accepted',
      reasons: [],
      usage: usage(1, 2, 3, 4),
      delay_ms: 21_000,
      at: at(21),
    })
  })
  store.close()

  const reopened = home.open()
  onTestFinished(() => {
    reopened.close()
  })
  expect(reopened.observerCalls.get(id('failed'))).toMatchObject({
    run,
    verdict: 'failed',
    error: { class: 'network', message: 'stream disconnected before completion' },
    usage: null,
    delay_ms: null,
  })
  expect(reopened.observerCalls.get(id('accepted'))).toMatchObject({
    verdict: 'accepted',
    error: null,
    usage: usage(1, 2, 3, 4),
    delay_ms: 21_000,
  })
})

test('probes and authorization checks are recorded finished and stay apart from the batch calls of runs', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  onTestFinished(() => {
    store.close()
  })
  const limited = probe('limited', 0, {
    output: null,
    verdict: 'failed',
    error: { class: 'limit', message: "You've hit your limit" },
    usage: null,
  })
  const authorized = probe('authorized', 5, {
    kind: 'auth_status',
    backend: 'codex',
    input: null,
    output: null,
    usage: null,
  })
  const recovered = probe('recovered', 9)
  const seqs = store.transaction((transaction) => {
    transaction.observerCalls.start({ id: id('batch'), backend: 'claude', input: input(), at: at(-20) })
    const before = transaction.nextChangeSeq()
    for (const check of [recovered, limited, authorized]) {
      transaction.observerCalls.check(check)
    }
    return [before, transaction.nextChangeSeq()]
  })

  expect(seqs[1]).toBe((seqs[0] ?? 0) + 4)
  expect(store.observerCalls.checks()).toEqual([limited, authorized, recovered])
  expect(store.observerCalls.get(id('limited'))).toBeNull()
  expect(store.observerCalls.unfinished()).toEqual([id('batch')])
  expect(store.observerCalls.latest(run)).toEqual({ id: id('batch'), started_at: at(-20) })
  expect(() => {
    store.transaction((transaction) => {
      transaction.observerCalls.finish({ id: id('recovered'), output: null, verdict: 'failed', reasons: [], at: at(30) })
    })
  }).toThrow('observer call recovered is missing or already finished')
})

test('the spending of the observer counts the tokens of batch calls and probes finished since a moment', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  onTestFinished(() => {
    store.close()
  })
  expect(store.observerCalls.spending(at(0))).toEqual({ tokens: 0, earliest: null })

  store.transaction((transaction) => {
    const finished = (name: string, seconds: number, spent: CallUsage | null): void => {
      transaction.observerCalls.start({ id: id(name), backend: 'claude', input: input(), at: at(seconds - 1) })
      transaction.observerCalls.finish({
        id: id(name),
        output: null,
        verdict: 'rejected',
        reasons: [],
        usage: spent,
        at: at(seconds),
      })
    }
    finished('before', 9, usage(1_000, 0, 0, 0))
    finished('counted', 12, usage(100, 20, 3, 40))
    finished('unmeasured', 13, null)
    finished('unknown-tokens', 14, { model: null, tokens: null, cost_usd: null })
    transaction.observerCalls.start({ id: id('running'), backend: 'codex', input: input(), at: at(11) })
    transaction.observerCalls.check(probe('probe', 15, { usage: usage(7, 0, 0, 1) }))
    transaction.observerCalls.check(probe('auth', 18, { kind: 'auth_status', input: null, usage: null }))
  })

  expect(store.observerCalls.spending(at(10))).toEqual({ tokens: 171, earliest: at(12) })
  expect(store.observerCalls.spending(at(17))).toEqual({ tokens: 8, earliest: at(17) })
  expect(store.observerCalls.spending(at(18))).toEqual({ tokens: 0, earliest: null })
})

const chatInput = (question: string, version = 0): ChatInput => ({
  question,
  history: [],
  run: { id: run, runtime: 'claude', goal: null, brief: null, sessions: [], agents: [] },
  model: { version: ModelVersion.parse(version), stages: [], criteria: [], attention: [] },
  focus: { kind: 'run', attention: [], recent_changes: [] },
  materials: [],
})

const chatCall = (name: string, seconds: number, changes: Partial<ChatCallRecord> = {}): ChatCallRecord => ({
  id: id(name),
  run,
  backend: 'claude',
  base_version: ModelVersion.parse(0),
  previous: null,
  input: chatInput('What is left?'),
  output: { needs: [], answer: 'Two stages remain.', citations: [], insufficient_data: false, view_rule: null },
  verdict: 'accepted',
  error: null,
  usage: usage(30, 400, 50, 60),
  started_at: at(seconds),
  finished_at: at(seconds + 4),
  ...changes,
})

const journalOf = (call: ChatCallRecord): StoredChatCall => ({
  id: call.id,
  run: call.run,
  backend: call.backend,
  base_version: call.base_version,
  previous: call.previous,
  verdict: call.verdict,
  error: call.error,
  usage: call.usage,
  started_at: call.started_at,
  finished_at: call.finished_at,
})

test('chat calls stay in the chat journal of their run, apart from the batch calls, checks and budget of the observer', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const other = RunId.parse('b'.repeat(32))
  const asked = chatCall('asked', 0, { verdict: 'needs_requested', output: { needs: [], answer: null } })
  const answered = chatCall('answered', 5, { previous: id('asked'), usage: { ...usage(8, 0, 0, 9), cost_usd: 0.25 } })
  const failed = chatCall('failed', 2, {
    run: other,
    backend: 'codex',
    base_version: ModelVersion.parse(3),
    input: chatInput('Why did the check fail?', 3),
    output: null,
    verdict: 'failed',
    error: { class: 'timeout', message: 'the chat call timed out' },
    usage: null,
  })
  store.transaction((transaction) => {
    for (const call of [asked, answered, failed]) {
      transaction.observerCalls.chat(call)
    }
  })
  store.close()

  const reopened = home.open()
  onTestFinished(() => {
    reopened.close()
  })
  expect(reopened.observerCalls.chats(run)).toEqual([journalOf(asked), journalOf(answered)])
  expect(reopened.observerCalls.chats(other)).toEqual([journalOf(failed)])
  expect(reopened.observerCalls.ofRun(run)).toEqual([])
  expect(reopened.observerCalls.get(id('asked'))).toBeNull()
  expect(reopened.observerCalls.unfinished()).toEqual([])
  expect(reopened.observerCalls.latest(run)).toBeNull()
  expect(reopened.observerCalls.checks()).toEqual([])
  expect(reopened.observerCalls.spending(at(0))).toEqual({ tokens: 0, earliest: null })
})

test.for([
  { name: 'an unknown call', previous: 'missing', problem: 'is not a chat call' },
  { name: 'a batch call', previous: 'batch', problem: 'is not a chat call' },
  { name: 'a chat call of another run', previous: 'elsewhere', problem: 'belongs to another run' },
  { name: 'a chat call on another model version', previous: 'older', problem: 'answered another model version' },
  { name: 'a chat call that did not request materials', previous: 'answered', problem: 'did not request materials' },
  { name: 'a chat call that already has its follow-up', previous: 'followed', problem: 'already has its follow-up' },
  { name: 'a chat call still running when the follow-up started', previous: 'late', problem: 'finished after the follow-up started' },
])('a follow-up chat call is refused when it follows $name', async ({ previous, problem }, { expect, onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  onTestFinished(() => {
    store.close()
  })
  const requested = { verdict: 'needs_requested', output: null } as const
  store.transaction((transaction) => {
    transaction.observerCalls.start({ id: id('batch'), backend: 'claude', input: input(), at: at(0) })
    transaction.observerCalls.chat(chatCall('elsewhere', 0, { ...requested, run: RunId.parse('b'.repeat(32)) }))
    transaction.observerCalls.chat(chatCall('older', 0, { ...requested, base_version: ModelVersion.parse(1) }))
    transaction.observerCalls.chat(chatCall('answered', 0))
    transaction.observerCalls.chat(chatCall('followed', 0, requested))
    transaction.observerCalls.chat(chatCall('follow-up', 10, { previous: id('followed') }))
    transaction.observerCalls.chat(chatCall('late', 0, { ...requested, finished_at: at(12) }))
  })
  const before = store.observerCalls.chats(run)

  expect(() => {
    store.transaction((transaction) => {
      transaction.observerCalls.chat(chatCall('refused', 10, { previous: id(previous) }))
    })
  }).toThrow(`chat call refused follows ${previous}, which ${problem}`)
  expect(store.observerCalls.chats(run)).toEqual(before)
})

test('pruning a run removes its chat journal with the follow-ups and keeps the journal of another run', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  onTestFinished(() => {
    store.close()
  })
  const other = RunId.parse('b'.repeat(32))
  const kept = chatCall('kept', 0, { run: other })
  store.transaction((transaction) => {
    transaction.observerCalls.chat(chatCall('asked', 0, { verdict: 'needs_requested', output: null }))
    transaction.observerCalls.chat(chatCall('answered', 5, { previous: id('asked') }))
    transaction.observerCalls.chat(kept)
  })

  store.transaction((transaction) => {
    transaction.pruning.remove({ runs: [run], sessions: [], streams: [], records: [] })
  })

  expect(store.observerCalls.chats(run)).toEqual([])
  expect(store.observerCalls.chats(other)).toEqual([journalOf(kept)])
})
