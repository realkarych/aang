import { setTimeout as sleep } from 'node:timers/promises'
import { EpochNs, ObserverCallId, type RunId } from '@aang/contract'
import { startObserverBatch } from '@aang/engine'
import { createObserverScheduler } from '@aang/observer'
import { expect, test } from 'vitest'
import { accepted, briefed, createScene, needing, outdated, start, structured } from './scene.js'

const until = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 15_000
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('the condition did not hold in time')
    }
    await sleep(20)
  }
}

test('an urgent fact starts a call at once and the next batch sees the model the response built', async (context) => {
  const scene = await createScene(context, { claude: [structured, accepted] })
  const session = scene.claudeSession('session-urgent')
  await session.start()
  await session.permission()
  scene.scheduler.wake()

  expect(scene.tally(session.run)).toEqual({ in_call: 2 })
  await scene.scheduler.idle()

  expect(scene.tally(session.run)).toEqual({ interpreted: 2 })
  const [call] = scene.calls(session.run)
  expect(call?.verdict).toBe('accepted')
  expect(call?.usage).toMatchObject({ model: 'claude-opus-5-5' })
  const [input] = scene.prompts('claude')
  expect(input?.run).toMatchObject({ id: session.run, runtime: 'claude', sessions: [{ runtime: 'claude' }] })
  expect(input?.batch.facts.map(({ kind, urgent }) => [kind, urgent])).toEqual([
    ['session_start', false],
    ['permission_request', true],
  ])
  expect(input?.model.stages).toEqual([])
  const run = scene.store.model.entity(session.run, { kind: 'run', id: session.run })
  expect(run?.kind === 'run' ? run.value.brief : null).toMatchObject({
    text: 'The observer read the batch',
    evidence: input?.batch.facts.map(({ id }) => id),
  })

  scene.advance(10_000)
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  const [, next] = scene.prompts('claude')
  expect(next?.model.version).toBe(scene.calls(session.run)[1]?.base_version)
  expect(next?.model.version).toBeGreaterThan(input?.model.version ?? Infinity)
  expect(next?.model.stages).toMatchObject([
    { title: 'Review the requested command', expected_result: 'A decision on the command', origin: 'inferred' },
  ])
  expect(next?.model.criteria).toMatchObject([
    { stage: next?.model.stages[0]?.id, text: 'The command is allowed or denied', source: 'task', status: 'not_checked' },
  ])
  expect(next?.model.attention.map(({ kind, author }) => [kind, author])).toContainEqual(['permission', 'rule'])
  expect(next?.batch.facts.map(({ kind }) => kind)).toEqual(['permission_request'])
  expect(scene.tally(session.run)).toEqual({ interpreted: 3 })
  expect(scene.failure()).toBeNull()
})

test('a rare fact is sent when the batch timer expires', async (context) => {
  const scene = await createScene(context, { claude: [accepted] })
  const session = scene.claudeSession('session-rare')
  await session.start()
  scene.scheduler.wake()
  expect(scene.tally(session.run)).toEqual({ pending: 1 })

  scene.advance(4_999)
  expect(scene.tally(session.run)).toEqual({ pending: 1 })
  expect(scene.calls(session.run)).toEqual([])

  scene.advance(1)
  expect(scene.tally(session.run)).toEqual({ in_call: 1 })
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ interpreted: 1 })
})

test('a full batch starts at once and calls of a run stay ten seconds apart, urgent or not', async (context) => {
  const scene = await createScene(context, { claude: [accepted, accepted, accepted] })
  const session = scene.claudeSession('session-full')
  await session.start()
  await session.tools(30)
  scene.scheduler.wake()
  expect(scene.tally(session.run)).toEqual({ in_call: 30, pending: 1 })
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ interpreted: 30, pending: 1 })

  scene.advance(9_999)
  expect(scene.tally(session.run)).toEqual({ interpreted: 30, pending: 1 })
  scene.advance(1)
  expect(scene.tally(session.run)).toEqual({ interpreted: 30, in_call: 1 })
  await scene.scheduler.idle()

  scene.advance(1_000)
  await session.permission()
  scene.scheduler.wake()
  scene.advance(8_999)
  expect(scene.tally(session.run)).toEqual({ interpreted: 31, pending: 1 })
  scene.advance(1)
  expect(scene.tally(session.run)).toEqual({ interpreted: 31, in_call: 1 })
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ input }) => input.batch.facts.length)).toEqual([30, 1, 1])
  expect(scene.tally(session.run)).toEqual({ interpreted: 32 })
})

test('a rejected response returns the whole batch to pending, and the third content failure leaves it not interpreted', async (context) => {
  const scene = await createScene(context, {
    claude: [outdated, { kind: 'invalid_json', text: 'not a structured answer' }, outdated],
  })
  const session = scene.claudeSession('session-rejected')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()

  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['pending', 1],
    ['pending', 1],
  ])
  scene.advance(10_000)
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ pending: 2 })
  scene.advance(10_000)
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict, reasons }) => [verdict, reasons.map(({ cause }) => cause)])).toEqual([
    ['rejected', ['version']],
    ['rejected', ['schema']],
    ['rejected', ['version']],
  ])
  expect(scene.prompts('claude').map(({ previous_attempt: previous }) => previous?.reasons ?? null)).toEqual([
    null,
    ['version: base_version does not match the saved observer call'],
    ['schema: Observer output does not match its schema'],
  ])
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['not_interpreted', 3],
    ['not_interpreted', 3],
  ])
  expect(scene.store.gaps.open('not_interpreted')).toMatchObject([
    { run: session.run, details: '2 facts were not interpreted after 3 rejected observer responses' },
  ])
  scene.advance(60_000)
  await scene.scheduler.idle()
  expect(scene.calls(session.run)).toHaveLength(3)
})

test('needs get exactly one immediate follow-up that does not spend an attempt', async (context) => {
  const scene = await createScene(context, { claude: [needing, briefed] })
  const session = scene.claudeSession('session-needs')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['needs_requested', 'accepted'])
  const [first, followUp] = scene.prompts('claude')
  expect(first?.materials).toEqual([])
  expect(followUp?.batch).toEqual(first?.batch)
  expect(followUp?.materials.map(({ kind }) => kind)).toEqual(['raw_record'])
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['interpreted', 1],
    ['interpreted', 1],
  ])
})

test('one call per run, two observer calls at once, and chat keeps its own slot', async (context) => {
  const hang = { kind: 'timeout' } as const
  const scene = await createScene(context, {
    claude: [hang, hang, hang, accepted, accepted, accepted],
    timeoutMs: 5_000,
  })
  const sessions = ['session-a', 'session-b', 'session-c'].map((name) => scene.claudeSession(name))
  for (const session of sessions) {
    await session.start()
    await session.permission()
  }
  scene.scheduler.wake()
  const [a, b, c] = sessions.map(({ run }) => run) as [RunId, RunId, RunId]
  expect([a, b, c].map((run) => scene.tally(run))).toEqual([{ in_call: 2 }, { in_call: 2 }, { pending: 2 }])

  const chat = scene.scheduler.chat((signal) => scene.claude.execute({ input: { chat: 'Which stage is blocked?' }, signal }))
  await until(
    () =>
      scene.prompts('claude').length === 2 &&
      scene.fakeClaude.calls().some((call) => call.prompt?.includes('Which stage is blocked?') === true),
  )
  expect(scene.prompts('claude').map(({ run }) => run.id).toSorted()).toEqual([a, b].toSorted())
  expect(scene.tally(c)).toEqual({ pending: 2 })

  expect(await chat).toMatchObject({ ok: false, error: { class: 'timeout' } })
  await scene.scheduler.idle()
  expect(scene.calls(a).map(({ verdict }) => verdict)).toEqual(['failed'])
  expect([a, b].map((run) => scene.statuses(run).map(({ status, attempts }) => [status, attempts]))).toEqual([
    [
      ['pending', 0],
      ['pending', 0],
    ],
    [
      ['pending', 0],
      ['pending', 0],
    ],
  ])
  expect(scene.tally(c)).toEqual({ interpreted: 2 })

  scene.advance(10_000)
  await scene.scheduler.idle()
  expect([a, b].map((run) => scene.tally(run))).toEqual([{ interpreted: 2 }, { interpreted: 2 }])
})

test('a run waits for an admitted backend of its vendor', async (context) => {
  const scene = await createScene(context, { admit: false, claude: [accepted], codex: [accepted] })
  const claudeSession = scene.claudeSession('session-claude')
  const codexSession = scene.codexSession('thread-codex')
  await claudeSession.start()
  await claudeSession.permission()
  await codexSession.start()
  await codexSession.permission()
  scene.scheduler.wake()
  expect(scene.tally(claudeSession.run)).toEqual({ pending: 2 })
  expect(scene.tally(codexSession.run)).toEqual({ pending: 2 })

  await scene.codex.admit()
  await until(() => scene.tally(codexSession.run)['in_call'] === 2)
  await scene.scheduler.idle()
  expect(scene.tally(codexSession.run)).toEqual({ interpreted: 2 })
  expect(scene.tally(claudeSession.run)).toEqual({ pending: 2 })
  expect(scene.prompts('codex').map(({ run }) => run.id)).toEqual([codexSession.run])

  await scene.claude.admit()
  await until(() => scene.tally(claudeSession.run)['interpreted'] === 2)
  await scene.scheduler.idle()
  expect(scene.prompts('claude').map(({ run }) => run.id)).toEqual([claudeSession.run])
})

test('an overridden backend gets facts of another vendor only with crossVendor', async (context) => {
  const excluded = await createScene(context, { backend: 'codex', codex: [accepted] })
  const session = excluded.claudeSession('session-excluded')
  await session.start()
  await session.permission()
  excluded.scheduler.wake()
  await excluded.scheduler.idle()
  expect(excluded.tally(session.run)).toEqual({ not_interpreted: 2 })
  expect(excluded.calls(session.run)).toEqual([])
  expect(excluded.store.gaps.open('cross_vendor_excluded')).toMatchObject([
    { run: session.run, details: 'facts of this session are not sent to the codex observer without observer.crossVendor' },
  ])

  const shared = await createScene(context, { backend: 'codex', crossVendor: true, codex: [accepted] })
  const crossing = shared.claudeSession('session-crossing')
  await crossing.start()
  await crossing.permission()
  shared.scheduler.wake()
  await shared.scheduler.idle()
  expect(shared.tally(crossing.run)).toEqual({ interpreted: 2 })
  expect(shared.prompts('codex').map(({ run }) => [run.id, run.runtime])).toEqual([[crossing.run, 'claude']])
  expect(shared.calls(crossing.run).map(({ backend }) => backend)).toEqual(['codex'])
})

test('facts beyond the active queue are deferred from the oldest with a visible gap', async (context) => {
  const scene = await createScene(context, { claude: [accepted], limits: { queueFacts: 3 } })
  const session = scene.claudeSession('session-backlog')
  await session.start(-25 * 60 * 60 * 1_000)
  await session.tools(5)
  scene.scheduler.wake()

  const deferred = scene.statuses(session.run).filter(({ status }) => status === 'deferred').map(({ fact }) => fact)
  const facts = scene.store.facts.ofSession({ kind: 'session', runtime: 'claude', session: 'session-backlog' })
  expect(deferred.toSorted()).toEqual(facts.slice(0, 3).map(({ id }) => id).toSorted())
  expect(scene.tally(session.run)).toEqual({ deferred: 3, pending: 3 })
  expect(scene.store.gaps.open('summarized_backlog')).toMatchObject([{ run: session.run }])

  scene.advance(5_000)
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ deferred: 3, interpreted: 3 })

  const stale = scene.claudeSession('session-stale')
  await stale.start(-25 * 60 * 60 * 1_000)
  await stale.permission(-25 * 60 * 60 * 1_000)
  scene.scheduler.wake()
  await scene.scheduler.idle()
  expect(scene.tally(stale.run)).toEqual({ deferred: 2 })
  expect(scene.calls(stale.run)).toEqual([])
})

test('the system clock drives the batch timer', async (context) => {
  const scene = await createScene(context, { claude: [accepted], systemClock: true, limits: { delayMs: 100 } })
  expect(() => createObserverScheduler({ store: scene.store, backends: {}, limits: { concurrency: 0 } })).toThrow(RangeError)
  const session = scene.claudeSession('session-clock')
  await session.start()
  scene.scheduler.wake()
  expect(scene.tally(session.run)).toEqual({ pending: 1 })
  await until(() => scene.tally(session.run)['interpreted'] === 1)
  await scene.scheduler.idle()
})

test('closing the scheduler cancels a running call without spending its attempt', async (context) => {
  const scene = await createScene(context, { claude: [{ kind: 'timeout' }] })
  const session = scene.claudeSession('session-closed')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  expect(scene.tally(session.run)).toEqual({ in_call: 2 })
  await until(() => scene.prompts('claude').length === 1)

  await scene.scheduler.close()
  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['failed'])
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['pending', 0],
    ['pending', 0],
  ])
  await expect(scene.scheduler.chat(() => Promise.resolve(null))).rejects.toThrow('closed')
  scene.scheduler.wake()
  expect(scene.tally(session.run)).toEqual({ pending: 2 })
})

test('a restart ends the call of the stopped process and sends its batch again without spending an attempt', async (context) => {
  const scene = await createScene(context, { claude: [accepted] })
  const session = scene.claudeSession('session-restart')
  await session.start()
  await session.permission()
  const stopped = ObserverCallId.parse('stopped-call')
  scene.store.transaction((transaction) =>
    startObserverBatch(transaction, {
      run: session.run,
      backend: 'claude',
      crossVendor: false,
      id: stopped,
      at: EpochNs.parse(BigInt(start) * 1_000_000n),
      limits: { facts: 30, bytes: 96_000, textLength: 4_000 },
    }),
  )
  expect(scene.tally(session.run)).toEqual({ in_call: 2 })

  await scene.restart()
  expect(scene.calls(session.run).map(({ id, verdict }) => [id, verdict])).toEqual([[stopped, 'failed']])
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['pending', 0],
    ['pending', 0],
  ])
  scene.scheduler.wake()
  await scene.scheduler.idle()
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['interpreted', 1],
    ['interpreted', 1],
  ])
})

test('a store failure surfaces through the scheduler instead of stopping the process', async (context) => {
  const scene = await createScene(context, { claude: [{ kind: 'timeout' }], timeoutMs: 5_000 })
  const session = scene.claudeSession('session-broken')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await until(() => scene.prompts('claude').length === 1)
  scene.store.close()

  scene.scheduler.wake()
  expect(await scene.scheduler.failure).toBeInstanceOf(Error)
  await scene.scheduler.idle()
})
