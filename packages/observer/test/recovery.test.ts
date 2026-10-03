import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ObserverCallId, type ObserverState, RunId } from '@aang/contract'
import { startObserverBatch } from '@aang/engine'
import { createObserverScheduler } from '@aang/observer'
import type { ClaudeReply, CodexReply } from '@aang/testkit'
import { expect, test } from 'vitest'
import { accepted, createScene, epochOf, gated, needing, outdated, start, until, wrapped } from './scene.js'

const minute = 60_000

const network = { kind: 'network' } as const

const limited = { kind: 'limit' } as const

const probeRun = '0'.repeat(32)

test('three transient failures and a success leave the batch interpreted after pauses of 10, 20 and 40 seconds', async (context) => {
  const scene = await createScene(context, { claude: [network, network, network, accepted] })
  const session = scene.claudeSession('session-transient')
  const states: ObserverState[] = []
  const unsubscribe = scene.scheduler.subscribe(() => {
    states.push(scene.scheduler.backendState('claude'))
  })
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()

  expect(scene.scheduler.state(session.run)).toEqual({ state: 'backoff', attempt: 1, until: epochOf(start + 10_000) })
  scene.advance(9_999)
  expect(scene.calls(session.run)).toHaveLength(1)
  scene.advance(1)
  await scene.scheduler.idle()
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'backoff', attempt: 2, until: epochOf(start + 30_000) })
  scene.advance(19_999)
  expect(scene.calls(session.run)).toHaveLength(2)
  scene.advance(1)
  await scene.scheduler.idle()
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'backoff', attempt: 3, until: epochOf(start + 70_000) })
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['pending', 0],
    ['pending', 0],
  ])
  unsubscribe()
  scene.advance(40_000)
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict, error, started_at: started }) => [verdict, error, started])).toEqual([
    ['failed', { class: 'network', message: 'Claude did not produce a successful result: API Error: Connection error.' }, epochOf(start)],
    ['failed', { class: 'network', message: 'Claude did not produce a successful result: API Error: Connection error.' }, epochOf(start + 10_000)],
    ['failed', { class: 'network', message: 'Claude did not produce a successful result: API Error: Connection error.' }, epochOf(start + 30_000)],
    ['accepted', null, epochOf(start + 70_000)],
  ])
  expect(scene.calls(session.run).map(({ delay_ms: delay }) => delay)).toEqual([null, null, null, 70_000])
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['interpreted', 1],
    ['interpreted', 1],
  ])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
  expect(states).toEqual([
    { state: 'ok' },
    { state: 'backoff', attempt: 1, until: epochOf(start + 10_000) },
    { state: 'backoff', attempt: 2, until: epochOf(start + 30_000) },
    { state: 'backoff', attempt: 3, until: epochOf(start + 70_000) },
  ])
  expect(scene.store.observerCalls.checks()).toEqual([])
})

test('six pauses in a row end in an unavailable backend that probes synthetic input with a doubling interval', async (context) => {
  const scene = await createScene(context, {
    claude: [network, network, network, network, network, network, network, network, network, accepted, accepted],
  })
  const session = scene.claudeSession('session-unavailable')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  let now = start
  for (const pause of [10_000, 20_000, 40_000, 80_000, 160_000, 300_000]) {
    expect(scene.scheduler.backendState('claude')).toMatchObject({ state: 'backoff', until: epochOf(now + pause) })
    scene.advance(pause)
    now += pause
    await scene.scheduler.idle()
  }

  expect(scene.calls(session.run).map(({ started_at: started }) => started)).toEqual(
    [0, 10, 30, 70, 150, 310, 610].map((seconds) => epochOf(start + seconds * 1_000)),
  )
  expect(scene.scheduler.state(session.run)).toEqual({
    state: 'unavailable',
    reason: 'transient',
    retry_at: epochOf(now + 30 * minute),
  })
  scene.advance(30 * minute - 1)
  await scene.scheduler.idle()
  expect(scene.store.observerCalls.checks()).toEqual([])
  scene.advance(1)
  await scene.scheduler.idle()
  expect(scene.scheduler.backendState('claude')).toEqual({
    state: 'unavailable',
    reason: 'transient',
    retry_at: epochOf(now + 90 * minute),
  })
  scene.advance(60 * minute)
  await scene.scheduler.idle()
  expect(scene.calls(session.run)).toHaveLength(7)
  scene.advance(120 * minute)
  await scene.scheduler.idle()

  const probes = scene.store.observerCalls.checks()
  expect(probes.map(({ kind, verdict, error, started_at: started }) => [kind, verdict, error?.class ?? null, started])).toEqual([
    ['probe', 'failed', 'network', epochOf(now + 30 * minute)],
    ['probe', 'failed', 'network', epochOf(now + 90 * minute)],
    ['probe', 'accepted', null, epochOf(now + 210 * minute)],
  ])
  expect(probes.map(({ backend, input, usage }) => [backend, input?.run.id, input?.batch.facts, usage?.model])).toEqual(
    Array.from({ length: 3 }, () => ['claude', probeRun, [], 'claude-opus-5-5']),
  )
  const prompted = scene.prompts('claude').filter(({ run }) => run.id === probeRun)
  expect(prompted.map(({ run, batch, model }) => [run.sessions, run.agents, batch.facts, model.version])).toEqual(
    Array.from({ length: 3 }, () => [[], [], [], 0]),
  )
  expect(scene.calls(session.run).map(({ verdict }) => verdict).slice(-2)).toEqual(['failed', 'accepted'])
  expect(scene.calls(session.run).at(-1)?.started_at).toBe(epochOf(now + 210 * minute))
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['interpreted', 1],
    ['interpreted', 1],
  ])
  expect(scene.scheduler.backendState('claude')).toEqual({ state: 'ok' })
})

test('an authorization error is checked by auth status every 10 minutes without a model call and resumes when it passes', async (context) => {
  const scene = await createScene(context, { claude: [{ kind: 'auth' }] })
  const session = scene.claudeSession('session-auth')
  const prints = (): number => scene.fakeClaude.calls().filter(({ command }) => command === 'print').length
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ error }) => error?.class)).toEqual(['auth'])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'unavailable', reason: 'auth', retry_at: epochOf(start + 10 * minute) })
  const printed = prints()
  scene.fakeClaude.setScenario({ loggedIn: false, replies: [accepted] })
  scene.advance(10 * minute - 1)
  await scene.scheduler.idle()
  expect(scene.store.observerCalls.checks()).toEqual([])
  scene.advance(1)
  await scene.scheduler.idle()
  expect(scene.scheduler.backendState('claude')).toEqual({
    state: 'unavailable',
    reason: 'auth',
    retry_at: epochOf(start + 20 * minute),
  })
  scene.fakeClaude.setScenario({ loggedIn: true, replies: [accepted] })
  scene.advance(10 * minute)
  await scene.scheduler.idle()

  expect(scene.store.observerCalls.checks().map(({ kind, verdict, error, input, usage, started_at: started }) => [kind, verdict, error, input, usage, started])).toEqual([
    ['auth_status', 'failed', { class: 'auth', message: 'Claude is not logged in' }, null, null, epochOf(start + 10 * minute)],
    ['auth_status', 'accepted', null, null, null, epochOf(start + 20 * minute)],
  ])
  expect(prints()).toBe(printed + 1)
  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['failed', 'accepted'])
  expect(scene.tally(session.run)).toEqual({ interpreted: 2 })
})

test('a long limit waits for the reported reset, then probes every 1, 2 and 4 hours, and never asks auth status', { timeout: 60_000 }, async (context) => {
  const resets = start + 20 * minute
  const scene = await createScene(context, {
    claude: [{ kind: 'limit', resetsAt: resets / 1_000 }, limited, limited, limited, limited, accepted, accepted],
  })
  const session = scene.claudeSession('session-limit')
  const authChecks = (): number => scene.fakeClaude.calls().filter(({ command }) => command === 'auth_status').length
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  const checked = authChecks()

  expect(scene.calls(session.run).map(({ error }) => error?.class)).toEqual(['limit'])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'unavailable', reason: 'limit', retry_at: epochOf(resets) })
  scene.advance(10 * minute)
  await scene.scheduler.idle()
  scene.advance(10 * minute - 1)
  await scene.scheduler.idle()
  expect(scene.store.observerCalls.checks()).toEqual([])
  expect(scene.calls(session.run)).toHaveLength(1)
  for (const wait of [1, 60, 120, 240, 240]) {
    scene.advance(wait === 1 ? 1 : wait * minute)
    await scene.scheduler.idle()
  }

  expect(scene.store.observerCalls.checks().map(({ kind, verdict, error, started_at: started }) => [kind, verdict, error?.class ?? null, started])).toEqual([
    ['probe', 'failed', 'limit', epochOf(resets)],
    ['probe', 'failed', 'limit', epochOf(resets + 60 * minute)],
    ['probe', 'failed', 'limit', epochOf(resets + 180 * minute)],
    ['probe', 'failed', 'limit', epochOf(resets + 420 * minute)],
    ['probe', 'accepted', null, epochOf(resets + 660 * minute)],
  ])
  expect(authChecks()).toBe(checked)
  expect(scene.calls(session.run).map(({ verdict, started_at: started }) => [verdict, started])).toEqual([
    ['failed', epochOf(start)],
    ['accepted', epochOf(resets + 660 * minute)],
  ])
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['interpreted', 1],
    ['interpreted', 1],
  ])
  expect(scene.prompts('claude').at(-1)?.batch.backlog).toBeNull()
  expect(scene.store.gaps.open('summarized_backlog')).toEqual([])
})

test.for([
  ['limit', { kind: 'limit', resetsAt: (start + 60 * minute) / 1_000 }, 60 * minute, 'probe'],
  ['auth', { kind: 'auth' }, 10 * minute, 'auth_status'],
] as const)(
  'a late success of a call that started before a %s failure leaves the backend to its recovery check',
  async ([reason, failure, retry, check], context) => {
    let held = ''
    const scene = await createScene(context, {
      claude: [accepted, failure, accepted],
      executors: ({ root, claude, launcher }) => {
        held = join(root, 'held')
        mkdirSync(held)
        return { claude: launcher(wrapped('hold-wrapper.ts', held, claude.command, ...(claude.args ?? []))) }
      },
    })
    const sessions = [scene.claudeSession('session-late'), scene.claudeSession('session-failing')]
    for (const session of sessions) {
      await session.start()
      await session.permission()
    }
    scene.scheduler.wake()
    await until(() => sessions.some(({ run }) => scene.calls(run).some(({ finished_at: finished }) => finished !== null)))
    const [failing, late] = sessions.toSorted(
      (left, right) => scene.calls(right.run).filter(({ finished_at: finished }) => finished !== null).length -
        scene.calls(left.run).filter(({ finished_at: finished }) => finished !== null).length,
    ) as [(typeof sessions)[number], (typeof sessions)[number]]
    const unavailable = { state: 'unavailable', reason, retry_at: epochOf(start + retry) }
    expect(scene.scheduler.backendState('claude')).toEqual(unavailable)

    await writeFile(join(held, 'release'), '')
    await scene.scheduler.idle()
    expect(scene.calls(late.run).map(({ verdict }) => verdict)).toEqual(['accepted'])
    expect(scene.scheduler.backendState('claude')).toEqual(unavailable)
    scene.advance(retry - 1)
    await scene.scheduler.idle()
    expect(scene.calls(failing.run).map(({ verdict, error }) => [verdict, error?.class])).toEqual([['failed', reason]])
    expect(scene.store.observerCalls.checks()).toEqual([])
    scene.advance(1)
    await scene.scheduler.idle()

    expect(scene.store.observerCalls.checks().map(({ kind, verdict, started_at: started }) => [kind, verdict, started])).toEqual([
      [check, 'accepted', epochOf(start + retry)],
    ])
    expect(scene.calls(failing.run).map(({ verdict, started_at: started }) => [verdict, started])).toEqual([
      ['failed', epochOf(start)],
      ['accepted', epochOf(start + retry)],
    ])
    expect(scene.scheduler.backendState('claude')).toEqual({ state: 'ok' })
  },
)

test.for([
  ['limit', { kind: 'limit', resetsAt: (start + 60 * minute) / 1_000 }, 60 * minute, 'probe'],
  ['auth', { kind: 'auth' }, 10 * minute, 'auth_status'],
] as const)(
  'a late needs response of a call that started before a %s failure gets no follow-up and returns its batch and summary without an attempt',
  async ([reason, failure, retry, check], context) => {
    let held = ''
    const scene = await createScene(context, {
      claude: [needing, failure, accepted],
      limits: { queueFacts: 1 },
      executors: ({ root, claude, launcher }) => {
        held = join(root, 'held')
        mkdirSync(held)
        return { claude: launcher(wrapped('hold-wrapper.ts', held, claude.command, ...(claude.args ?? []))) }
      },
    })
    const sessions = [scene.claudeSession('session-late-needs'), scene.claudeSession('session-failing')]
    for (const session of sessions) {
      await session.start()
      await session.permission()
    }
    scene.scheduler.wake()
    await until(() => sessions.some(({ run }) => scene.calls(run).some(({ finished_at: finished }) => finished !== null)))
    const [failing, late] = sessions.toSorted(
      (left, right) => scene.calls(right.run).filter(({ finished_at: finished }) => finished !== null).length -
        scene.calls(left.run).filter(({ finished_at: finished }) => finished !== null).length,
    ) as [(typeof sessions)[number], (typeof sessions)[number]]
    const unavailable = { state: 'unavailable', reason, retry_at: epochOf(start + retry) }
    const queue = (): [string, number, string | null][] =>
      scene.statuses(late.run).map(({ status, attempts, observer_call: call }): [string, number, string | null] => [status, attempts, call]).toSorted()
    expect(scene.calls(late.run).map(({ input }) => [input.batch.facts.length, input.batch.backlog?.facts])).toEqual([[1, 1]])

    await writeFile(join(held, 'release'), '')
    await scene.scheduler.idle()
    const [needs] = scene.calls(late.run)
    expect(scene.calls(late.run).map(({ verdict }) => verdict)).toEqual(['needs_requested'])
    expect(queue()).toEqual([
      ['deferred', 0, null],
      ['pending', 0, needs?.id],
    ])
    expect(scene.scheduler.backendState('claude')).toEqual(unavailable)
    expect(scene.scheduler.state(late.run)).toEqual(unavailable)
    scene.advance(retry - 1)
    await scene.scheduler.idle()
    expect(scene.store.observerCalls.checks()).toEqual([])
    expect(scene.calls(late.run)).toHaveLength(1)
    scene.advance(1)
    await scene.scheduler.idle()

    expect(scene.store.observerCalls.checks().map(({ kind, verdict, started_at: started }) => [kind, verdict, started])).toEqual([
      [check, 'accepted', epochOf(start + retry)],
    ])
    const calls = scene.calls(late.run)
    expect(calls.map(({ verdict, started_at: started }) => [verdict, started])).toEqual([
      ['needs_requested', epochOf(start)],
      ['accepted', epochOf(start + retry)],
    ])
    expect(queue()).toEqual([
      ['deferred', 1, calls[1]?.id],
      ['interpreted', 1, calls[1]?.id],
    ])
    expect(scene.calls(failing.run).map(({ verdict }) => verdict)).toEqual(['failed', 'accepted'])
    expect(scene.scheduler.backendState('claude')).toEqual({ state: 'ok' })
  },
)

test('a late needs response during a pause gets no follow-up, and its batch goes again after the pause', async (context) => {
  let held = ''
  const scene = await createScene(context, {
    claude: [needing, network, accepted],
    executors: ({ root, claude, launcher }) => {
      held = join(root, 'held')
      mkdirSync(held)
      return { claude: launcher(wrapped('hold-wrapper.ts', held, claude.command, ...(claude.args ?? []))) }
    },
  })
  const sessions = [scene.claudeSession('session-paused-needs'), scene.claudeSession('session-timed-out')]
  for (const session of sessions) {
    await session.start()
    await session.permission()
  }
  scene.scheduler.wake()
  await until(() => sessions.some(({ run }) => scene.calls(run).some(({ finished_at: finished }) => finished !== null)))
  const [failing, late] = sessions.toSorted(
    (left, right) => scene.calls(right.run).filter(({ finished_at: finished }) => finished !== null).length -
      scene.calls(left.run).filter(({ finished_at: finished }) => finished !== null).length,
  ) as [(typeof sessions)[number], (typeof sessions)[number]]
  const paused = { state: 'backoff', attempt: 1, until: epochOf(start + 10_000) }
  expect(scene.scheduler.backendState('claude')).toEqual(paused)

  await writeFile(join(held, 'release'), '')
  await scene.scheduler.idle()
  expect(scene.calls(late.run).map(({ verdict }) => verdict)).toEqual(['needs_requested'])
  expect(scene.statuses(late.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['pending', 0],
    ['pending', 0],
  ])
  expect(scene.scheduler.backendState('claude')).toEqual(paused)
  scene.advance(10_000)
  await scene.scheduler.idle()

  expect(scene.calls(late.run).map(({ verdict, started_at: started }) => [verdict, started])).toEqual([
    ['needs_requested', epochOf(start)],
    ['accepted', epochOf(start + 10_000)],
  ])
  expect(scene.calls(failing.run).map(({ verdict }) => verdict)).toEqual(['failed', 'accepted'])
  expect(scene.scheduler.backendState('claude')).toEqual({ state: 'ok' })
})

test('a reported limit outlives a SIGKILL of the daemon, and the restarted scheduler probes at the reset before any batch', async (context) => {
  const resets = start + 60 * minute
  const scene = await createScene(context, { claude: [{ kind: 'limit', resetsAt: resets / 1_000 }, accepted, accepted] })
  const session = scene.claudeSession('session-killed-limit')
  await session.start()
  await session.permission()
  await scene.kill()

  expect(scene.calls(session.run).map(({ verdict, error }) => [verdict, error?.class])).toEqual([['failed', 'limit']])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'unavailable', reason: 'limit', retry_at: epochOf(resets) })
  scene.scheduler.wake()
  scene.advance(60 * minute - 1)
  await scene.scheduler.idle()
  expect(scene.calls(session.run)).toHaveLength(1)
  expect(scene.store.observerCalls.checks()).toEqual([])
  scene.advance(1)
  await scene.scheduler.idle()

  expect(scene.store.observerCalls.checks().map(({ kind, verdict, started_at: started }) => [kind, verdict, started])).toEqual([
    ['probe', 'accepted', epochOf(resets)],
  ])
  expect(scene.calls(session.run).map(({ verdict, started_at: started }) => [verdict, started])).toEqual([
    ['failed', epochOf(start)],
    ['accepted', epochOf(resets)],
  ])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
})

test('the pause count outlives a SIGKILL of the daemon, so the next timeout doubles the pause', async (context) => {
  const scene = await createScene(context, { claude: [network, network, accepted] })
  const session = scene.claudeSession('session-killed-backoff')
  await session.start()
  await session.permission()
  await scene.kill()

  expect(scene.scheduler.state(session.run)).toEqual({ state: 'backoff', attempt: 1, until: epochOf(start + 10_000) })
  scene.scheduler.wake()
  scene.advance(9_999)
  await scene.scheduler.idle()
  expect(scene.calls(session.run)).toHaveLength(1)
  scene.advance(1)
  await scene.scheduler.idle()
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'backoff', attempt: 2, until: epochOf(start + 30_000) })
  scene.advance(20_000)
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict, started_at: started }) => [verdict, started])).toEqual([
    ['failed', epochOf(start)],
    ['failed', epochOf(start + 10_000)],
    ['accepted', epochOf(start + 30_000)],
  ])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
})

test('after an isolation violation the backend is disabled without probes until a new admission', async (context) => {
  const toolCall: CodexReply = { kind: 'answer', output: { base_version: { $input: '/model/version' }, ops: [], needs: [] }, toolAttempts: ['exec'] }
  const scene = await createScene(context, { admit: ['codex'], codex: [toolCall, accepted] })
  const session = scene.codexSession('thread-isolation')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict, error }) => [verdict, error?.class])).toEqual([['failed', 'isolation']])
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['pending', 0],
    ['pending', 0],
  ])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'disabled', reason: 'isolation' })
  scene.advance(5 * 60 * minute)
  await scene.scheduler.idle()
  expect(scene.calls(session.run)).toHaveLength(1)
  expect(scene.store.observerCalls.checks()).toEqual([])

  await scene.codex.admit()
  await until(() => scene.tally(session.run)['interpreted'] === 2)
  await scene.scheduler.idle()
  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['failed', 'accepted'])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
})

test('facts beyond the queue bound reach the observer only in a backlog summary that holds until a response is accepted', async (context) => {
  const scene = await createScene(context, { claude: [outdated, needing, accepted, accepted], limits: { queueFacts: 3 } })
  const session = scene.claudeSession('session-summary')
  await session.start()
  await session.tools(5)
  scene.scheduler.wake()
  const deferred = (): (string | null)[] =>
    scene.statuses(session.run).flatMap(({ status, observer_call: call }) => (status === 'deferred' ? [call] : []))
  expect(scene.tally(session.run)).toEqual({ deferred: 3, pending: 3 })

  scene.advance(5_000)
  await scene.scheduler.idle()
  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['rejected'])
  expect(deferred()).toEqual([null, null, null])
  scene.advance(10_000)
  await scene.scheduler.idle()

  const calls = scene.calls(session.run)
  expect(calls.map(({ verdict }) => verdict)).toEqual(['rejected', 'needs_requested', 'accepted'])
  expect(deferred()).toEqual([calls[2]?.id, calls[2]?.id, calls[2]?.id])
  const facts = scene.store.facts.ofSession({ kind: 'session', runtime: 'claude', session: 'session-summary' })
  const [first, , third] = facts
  const prompts = scene.prompts('claude')
  const agent = prompts[0]?.batch.facts[0]?.agent
  expect(agent).toEqual(expect.any(String))
  expect(prompts.map(({ batch }) => batch.backlog)).toEqual(
    Array.from({ length: 3 }, () => ({
      from: new Date(Number((first?.at ?? 0n) / 1_000_000n)).toISOString(),
      to: new Date(Number((third?.at ?? 0n) / 1_000_000n)).toISOString(),
      facts: 3,
      agents: [
        { agent: null, facts: 1, tools: [{ tool: 'session_start', count: 1 }] },
        { agent, facts: 2, tools: [{ tool: 'Bash', count: 2 }] },
      ],
    })),
  )
  expect(prompts.map(({ batch }) => batch.facts.length)).toEqual([3, 3, 3])

  scene.advance(10_000)
  await session.tools(1)
  scene.scheduler.wake()
  scene.advance(5_000)
  await scene.scheduler.idle()
  expect(scene.prompts('claude').at(-1)?.batch.backlog).toBeNull()
  expect(scene.tally(session.run)).toEqual({ deferred: 3, interpreted: 4 })
  expect(scene.store.gaps.open('summarized_backlog')).toMatchObject([{ run: session.run }])
})

test('a queue that expired during an outage goes as a summary call without another solver event, and the run lags until it is accepted', async (context) => {
  const scene = await createScene(context, { claude: [limited, accepted, outdated, accepted], limits: { queueAgeMs: minute } })
  const session = scene.claudeSession('session-expired')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'unavailable', reason: 'limit', retry_at: epochOf(start + 30 * minute) })
  scene.advance(2 * minute)
  expect(scene.tally(session.run)).toEqual({ deferred: 2 })
  scene.advance(28 * minute)
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['failed', 'rejected'])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'lagging', reason: 'backlog' })
  scene.advance(10_000)
  await scene.scheduler.idle()
  const calls = scene.calls(session.run)
  expect(calls.map(({ verdict, delay_ms: delay, started_at: started }) => [verdict, delay, started])).toEqual([
    ['failed', null, epochOf(start)],
    ['rejected', null, epochOf(start + 30 * minute)],
    ['accepted', null, epochOf(start + 30 * minute + 10_000)],
  ])
  const summaries = scene.prompts('claude').filter(({ run }) => run.id === session.run).slice(1)
  expect(summaries.map(({ batch, previous_attempt: previous }) => [batch.facts, batch.backlog?.facts, previous])).toEqual([
    [[], 2, null],
    [[], 2, { reasons: ['version: base_version does not match the saved observer call'] }],
  ])
  expect(scene.statuses(session.run).map(({ status, attempts, observer_call: call }) => [status, attempts, call])).toEqual([
    ['deferred', 2, calls[2]?.id],
    ['deferred', 2, calls[2]?.id],
  ])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
  scene.advance(60 * minute)
  await scene.scheduler.idle()
  expect(scene.calls(session.run)).toHaveLength(3)
})

test('a rejected summary passes its reasons to the next attempt that also carries a fresh fact', async (context) => {
  const scene = await createScene(context, { claude: [limited, accepted, outdated, accepted], limits: { queueAgeMs: minute } })
  const session = scene.claudeSession('session-expired-fresh')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  scene.advance(30 * minute)
  await scene.scheduler.idle()
  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['failed', 'rejected'])

  await session.tools(1)
  scene.scheduler.wake()
  scene.advance(10_000)
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['failed', 'rejected', 'accepted'])
  const [, summary, fresh] = scene.prompts('claude').filter(({ run }) => run.id === session.run)
  expect([summary, fresh].map((input) => [input?.batch.facts.length, input?.batch.backlog?.facts, input?.previous_attempt])).toEqual([
    [0, 2, null],
    [1, 2, { reasons: ['version: base_version does not match the saved observer call'] }],
  ])
  expect(scene.tally(session.run)).toEqual({ deferred: 2, interpreted: 1 })
})

test('a run lags while its summary is in a call and catches up once the summary is accepted', async (context) => {
  let gate = ''
  const scene = await createScene(context, {
    claude: [accepted],
    limits: { queueAgeMs: minute },
    executors: ({ root, claude, launcher }) => {
      gate = join(root, 'gate')
      return { claude: launcher(gated(gate, claude)) }
    },
  })
  const session = scene.claudeSession('session-summary-running')
  const states: ObserverState[] = []
  scene.scheduler.subscribe(() => {
    states.push(scene.scheduler.state(session.run))
  })
  await session.start(-2 * minute)
  await session.permission(-2 * minute)
  scene.scheduler.wake()

  expect(scene.calls(session.run).map(({ verdict, input }) => [verdict, input.batch.facts.length, input.batch.backlog?.facts])).toEqual([
    [null, 0, 2],
  ])
  expect(scene.store.interpretations.pending(session.run)).toEqual([])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'lagging', reason: 'backlog' })
  expect(states.at(-1)).toEqual({ state: 'lagging', reason: 'backlog' })
  await writeFile(gate, '')
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['accepted'])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
  expect(states.at(-1)).toEqual({ state: 'ok' })
})

test('a summary call rejected three times leaves its deferred facts not interpreted, and a backend failure spends no attempt', async (context) => {
  const scene = await createScene(context, {
    claude: [limited, accepted, outdated, network, outdated, outdated],
    limits: { queueAgeMs: minute },
  })
  const session = scene.claudeSession('session-expired-rejected')
  const summaries = (): [string, number, string | null][] =>
    scene.statuses(session.run).map(({ status, attempts, observer_call: call }) => [status, attempts, call])
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  scene.advance(30 * minute)
  await scene.scheduler.idle()
  expect(summaries()).toEqual([
    ['deferred', 1, null],
    ['deferred', 1, null],
  ])
  scene.advance(10_000)
  await scene.scheduler.idle()
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'backoff', attempt: 1, until: epochOf(start + 30 * minute + 20_000) })
  expect(summaries()).toEqual([
    ['deferred', 1, null],
    ['deferred', 1, null],
  ])
  scene.advance(10_000)
  await scene.scheduler.idle()
  scene.advance(10_000)
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict, error }) => [verdict, error?.class ?? null])).toEqual([
    ['failed', 'limit'],
    ['rejected', null],
    ['failed', 'network'],
    ['rejected', null],
    ['rejected', null],
  ])
  expect(scene.tally(session.run)).toEqual({ not_interpreted: 2 })
  expect(scene.store.gaps.open('not_interpreted')).toMatchObject([
    { run: session.run, details: '2 facts were not interpreted after 3 rejected observer responses' },
  ])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
  scene.advance(60 * minute)
  await scene.scheduler.idle()
  expect(scene.calls(session.run)).toHaveLength(5)
})

test('a summary that was in a call of a stopped process is summarized again after the restart', async (context) => {
  const scene = await createScene(context, { claude: [accepted], limits: { queueFacts: 2 } })
  const session = scene.claudeSession('session-summary-restart')
  await session.start()
  await session.tools(3)
  scene.scheduler.wake()
  const stopped = ObserverCallId.parse('stopped-call')
  scene.store.transaction((transaction) =>
    startObserverBatch(transaction, {
      run: session.run,
      backend: 'claude',
      crossVendor: false,
      id: stopped,
      at: epochOf(start),
      limits: { facts: 30, bytes: 96_000, textLength: 4_000 },
    }),
  )
  expect(
    scene.statuses(session.run).map(({ status, observer_call: call }) => [status, call]).filter(([status]) => status === 'deferred'),
  ).toEqual([
    ['deferred', stopped],
    ['deferred', stopped],
  ])

  await scene.restart()
  expect(
    scene.statuses(session.run).flatMap(({ status, attempts, observer_call: call }) => (status === 'deferred' ? [[call, attempts]] : [])),
  ).toEqual([
    [null, 0],
    [null, 0],
  ])
  scene.scheduler.wake()
  scene.advance(10_000)
  await scene.scheduler.idle()
  expect(scene.prompts('claude').at(-1)?.batch.backlog).toMatchObject({ facts: 2 })
  expect(scene.tally(session.run)).toEqual({ deferred: 2, interpreted: 2 })
})

test('when the observer falls behind, the earlier facts go as a summary and the latest batch in detail', async (context) => {
  let gate = ''
  const scene = await createScene(context, {
    claude: [accepted, accepted],
    limits: { batchFacts: 3 },
    executors: ({ root, claude, launcher }) => {
      gate = join(root, 'gate')
      return { claude: launcher(gated(gate, claude)) }
    },
  })
  const session = scene.claudeSession('session-behind')
  const states: ObserverState[] = []
  scene.scheduler.subscribe(() => {
    states.push(scene.scheduler.state(session.run))
  })
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  scene.advance(minute)
  await session.tools(3)
  scene.scheduler.wake()
  scene.advance(5 * minute)
  await session.tools(2)
  scene.scheduler.wake()
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
  scene.advance(1)
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'lagging', reason: 'backlog' })
  expect(states.at(-1)).toEqual({ state: 'lagging', reason: 'backlog' })

  await writeFile(gate, '')
  await until(() => scene.calls(session.run).length === 2)
  await scene.scheduler.idle()
  const [, behind] = scene.prompts('claude')
  const facts = scene.store.facts.ofSession({ kind: 'session', runtime: 'claude', session: 'session-behind' })
  expect(behind?.batch.facts.map(({ id }) => id)).toEqual(facts.slice(-3).map(({ id }) => id))
  expect(behind?.batch.backlog).toMatchObject({ facts: 2, agents: [{ facts: 2, tools: [{ tool: 'Bash', count: 2 }] }] })
  expect(scene.tally(session.run)).toEqual({ interpreted: 5, deferred: 2 })
  expect(scene.store.gaps.open('summarized_backlog')).toMatchObject([
    { run: session.run, details: 'facts that waited longer than 300000 ms for the observer are summarized' },
  ])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
  expect(states.at(-1)).toEqual({ state: 'ok' })
})

test('an exceeded hourly budget lengthens the batch timer to 60 seconds and makes the observer lag without stopping it', async (context) => {
  const scene = await createScene(context, { claude: [accepted, accepted, accepted, accepted], budgetTokensPerHour: 5_000 })
  const session = scene.claudeSession('session-budget')
  await session.start()
  scene.scheduler.wake()
  scene.advance(5_000)
  await scene.scheduler.idle()
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
  await session.tools(1)
  scene.scheduler.wake()
  scene.advance(10_000)
  await scene.scheduler.idle()

  expect(scene.store.observerCalls.spending(epochOf(start))).toEqual({ tokens: 7_876, earliest: epochOf(start + 5_000) })
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'lagging', reason: 'budget' })
  expect(scene.scheduler.backendState('claude')).toEqual({ state: 'lagging', reason: 'budget' })
  await session.tools(1)
  scene.scheduler.wake()
  scene.advance(59_999)
  expect(scene.tally(session.run)).toEqual({ interpreted: 2, pending: 1 })
  scene.advance(1)
  expect(scene.tally(session.run)).toEqual({ interpreted: 2, in_call: 1 })
  await scene.scheduler.idle()

  scene.advance(60 * minute - 60_000)
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'lagging', reason: 'budget' })
  scene.advance(1)
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
  await session.tools(1)
  scene.scheduler.wake()
  scene.advance(5_000)
  await scene.scheduler.idle()
  expect(scene.calls(session.run).map(({ started_at: started }) => started)).toEqual([
    epochOf(start + 5_000),
    epochOf(start + 15_000),
    epochOf(start + 75_000),
    epochOf(start + 60 * minute + 20_001),
  ])
})

test('deferred facts of another vendor stay out of the summary without crossVendor', async (context) => {
  const scene = await createScene(context, { backend: 'claude', claude: [accepted], limits: { queueFacts: 2 } })
  const root = scene.codexSession('thread-root')
  const attached = scene.claudeSession('session-attached')
  await root.start()
  scene.attach('claude', 'session-attached', root.run)
  await attached.start()
  await root.permission()
  await attached.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()

  const [input] = scene.prompts('claude')
  expect(input?.batch.facts.map(({ kind }) => kind)).toEqual(['permission_request'])
  expect(input?.batch.backlog).toMatchObject({ facts: 1, agents: [{ tools: [{ tool: 'session_start', count: 1 }] }] })
  expect(scene.tally(root.run)).toEqual({ not_interpreted: 2, deferred: 1, interpreted: 1 })
})

test('a probe cancelled by closing the scheduler is recorded without an error and leaves the backend waiting', async (context) => {
  const scene = await createScene(context, { claude: [limited, { kind: 'timeout' }] })
  const session = scene.claudeSession('session-closing')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  scene.advance(30 * minute)
  await until(() => scene.prompts('claude').some(({ run }) => run.id === probeRun))

  await scene.scheduler.close()
  expect(scene.store.observerCalls.checks().map(({ kind, verdict, error }) => [kind, verdict, error])).toEqual([['probe', 'failed', null]])
  expect(scene.scheduler.backendState('claude')).toEqual({ state: 'unavailable', reason: 'limit', retry_at: epochOf(start + 30 * minute) })
  expect(scene.scheduler.state(RunId.parse('f'.repeat(32)))).toEqual({ state: 'ok' })
})

test('a response that is not valid output keeps its error class and spends an attempt of the batch', async (context) => {
  const invalid: ClaudeReply = { kind: 'invalid_json', text: 'not a structured answer' }
  const scene = await createScene(context, { claude: [invalid, accepted] })
  const session = scene.claudeSession('session-invalid')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict, error }) => [verdict, error])).toEqual([
    ['rejected', { class: 'invalid_output', message: 'Observer output does not match its schema' }],
  ])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'ok' })
  scene.advance(10_000)
  await scene.scheduler.idle()
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['interpreted', 2],
    ['interpreted', 2],
  ])
})

test('project instructions above the observer directory disable the backend and the call counts as an isolation failure', async (context) => {
  const scene = await createScene(context, { claude: [accepted] })
  const session = scene.claudeSession('session-instructions')
  await writeFile(join(scene.root, 'CLAUDE.md'), 'Follow the project rules')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict, error }) => [verdict, error?.class, error?.message])).toEqual([
    ['failed', 'isolation', expect.stringContaining('Instructions in observer directory ancestry')],
  ])
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'disabled', reason: 'unsafe_workdir' })
  expect(scene.tally(session.run)).toEqual({ pending: 2 })
})

test('a store failure while a probe is recorded surfaces through the scheduler', async (context) => {
  const scene = await createScene(context, { claude: [limited, { kind: 'timeout' }], timeoutMs: 1_500 })
  const session = scene.claudeSession('session-probe-store')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  scene.advance(30 * minute)
  await until(() => scene.prompts('claude').some(({ run }) => run.id === probeRun))
  scene.store.close()

  expect(await scene.scheduler.failure).toBeInstanceOf(Error)
  await scene.scheduler.close()
})

test('a store failure while an admitted backend resets its recovery state surfaces through the scheduler', async (context) => {
  const scene = await createScene(context, { admit: [] })
  expect(scene.scheduler.backendState('claude')).toMatchObject({ state: 'disabled' })
  scene.store.close()
  await scene.claude.admit()

  expect(await scene.scheduler.failure).toBeInstanceOf(Error)
  await scene.scheduler.close()
})

test('a backend that the scheduler was not given is disabled, and the budget must be a positive integer', async (context) => {
  const scene = await createScene(context)
  expect(() => createObserverScheduler({ store: scene.store, backends: {}, budgetTokensPerHour: 0 })).toThrow(RangeError)
  const scheduler = createObserverScheduler({ store: scene.store, backends: {} })
  expect(scheduler.backendState('codex')).toEqual({ state: 'disabled', reason: 'cli_missing' })
  await scheduler.close()
})

test('a Codex network failure pauses the backend and a Codex limit waits for the reset it reports', async (context) => {
  const resets = start + 10_000 + 20 * minute
  const scene = await createScene(context, {
    admit: ['codex'],
    codex: [network, { kind: 'limit', resetsAt: resets / 1_000 }, accepted, accepted],
  })
  const session = scene.codexSession('thread-limit')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'backoff', attempt: 1, until: epochOf(start + 10_000) })
  scene.advance(10_000)
  await scene.scheduler.idle()
  expect(scene.scheduler.state(session.run)).toEqual({ state: 'unavailable', reason: 'limit', retry_at: epochOf(resets) })
  scene.advance(20 * minute)
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict, error }) => [verdict, error?.class ?? null])).toEqual([
    ['failed', 'network'],
    ['failed', 'limit'],
    ['accepted', null],
  ])
  expect(scene.calls(session.run)[0]?.error?.message).toContain('stream disconnected before completion')
  expect(scene.store.observerCalls.checks().map(({ kind, backend, verdict, started_at: started }) => [kind, backend, verdict, started])).toEqual([
    ['probe', 'codex', 'accepted', epochOf(resets)],
  ])
  expect(scene.tally(session.run)).toEqual({ interpreted: 2 })
})
