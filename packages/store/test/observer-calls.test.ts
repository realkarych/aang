import { type CallUsage, EpochNs, ModelVersion, ObserverCallId, type ObserverInput, RunId } from '@aang/contract'
import type { ObserverCheck } from '@aang/store'
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
