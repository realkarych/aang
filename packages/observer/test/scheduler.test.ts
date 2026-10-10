import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type FactId, ObserverCallId, ObserverOperation, type RunId } from '@aang/contract'
import { applyChangeSet, observerInputTokens, startObserverBatch } from '@aang/engine'
import { type CliCommand, createObserverScheduler, observerSystemPrompt } from '@aang/observer'
import type { ClaudeReply } from '@aang/testkit'
import { expect, test } from 'vitest'
import { accepted, briefed, createScene, epochOf, gated, needing, outdated, start, structured, until, wrapped } from './scene.js'


const zombieTree = (directory: string, helper: string, cli: CliCommand): CliCommand => {
  mkdirSync(directory)
  return wrapped('zombie-wrapper.ts', helper, directory, cli.command, ...(cli.args ?? []))
}

const rejection = 'version: base_version does not match the saved observer call'

const batchLimits = { facts: 30, bytes: 96_000, textLength: 4_000, inputTokens: 24_000 }


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

const unreadable: ClaudeReply = { kind: 'answer', output: { base_version: 0, ops: 'none' } }

test.for([
  ['an accepted', briefed],
  ['an unreadable', unreadable],
] as const)('%s response to a call that a session transfer ended keeps its usage and changes nothing else', async ([, reply], context) => {
  let gate = ''
  const scene = await createScene(context, {
    claude: [reply, accepted],
    limits: { concurrency: 1 },
    executors: ({ root, claude, launcher }) => {
      gate = join(root, 'gate')
      return { claude: launcher(gated(gate, claude)) }
    },
  })
  const [moving, target] = [scene.claudeSession('session-moving'), scene.claudeSession('session-target')]
  await target.start()
  await moving.start()
  await moving.permission()
  scene.scheduler.wake()
  expect(scene.tally(moving.run)).toEqual({ in_call: 2 })
  const [call] = scene.calls(moving.run)
  const session = scene.store.observations.sessions().find(({ key }) => key.session === 'session-moving')
  if (call === undefined || session === undefined) {
    throw new Error('the moving session must be in a call')
  }
  await scene.engine.bind({ kind: 'attach', session: session.id, run: target.run })
  const version = scene.store.model.head(moving.run)
  expect(scene.store.observerCalls.get(call.id)).toMatchObject({ verdict: 'rejected', reasons: [{ cause: 'scope' }], usage: null })
  expect(scene.tally(moving.run)).toEqual({})
  scene.scheduler.wake()
  expect(scene.tally(target.run)).toEqual({ pending: 3 })

  await writeFile(gate, '')
  await until(() => scene.prompts('claude').length === 2)
  await scene.scheduler.idle()
  expect(scene.failure()).toBeNull()
  expect(scene.store.observerCalls.get(call.id)).toMatchObject({
    verdict: 'rejected',
    output: null,
    reasons: [{ op_index: null, cause: 'scope', message: expect.stringContaining(target.run) as unknown }],
    usage: { model: 'claude-opus-5-5' },
  })
  expect(scene.store.model.head(moving.run)).toBe(version)
  expect(scene.store.model.entity(moving.run, { kind: 'run', id: moving.run })).toMatchObject({ value: { brief: null } })
  expect(scene.tally(moving.run)).toEqual({})
  expect(scene.calls(target.run).map(({ verdict }) => verdict)).toEqual(['accepted'])
  expect(scene.tally(target.run)).toEqual({ interpreted: 3 })
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
    ['schema: Observer output does not match its schema: output: Invalid input: expected object, received undefined'],
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

test('an answer that names a file as the artifact of a stage dependency is rejected with that field, and the next attempt is told about it', async (context) => {
  const stage = (temp_id: string, title: string) => ({
    op: 'stage.create',
    temp_id,
    title,
    expected_result: null,
    summary: null,
    parent: null,
    origin: 'inferred',
    evidence: { $input: '/batch/facts/*/id' },
    rationale: 'Permission request',
  })
  const fileAsVia: ClaudeReply = {
    kind: 'answer',
    output: {
      base_version: { $input: '/model/version' },
      ops: [
        stage('read', 'Read the specification'),
        stage('plan', 'Write the plan'),
        {
          op: 'stage.depends',
          stage: { kind: 'new', temp_id: 'plan' },
          depends_on: { kind: 'new', temp_id: 'read' },
          via: 'SPEC.md',
          evidence: { $input: '/batch/facts/*/id' },
          rationale: 'The plan follows the specification',
        },
      ],
      needs: [],
    },
  }
  const scene = await createScene(context, { claude: [fileAsVia, accepted] })
  const session = scene.claudeSession('session-via')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  scene.advance(10_000)
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['rejected', 'accepted'])
  expect(scene.prompts('claude').map(({ previous_attempt: previous }) => previous?.reasons ?? null)).toEqual([
    null,
    ['schema: Observer output does not match its schema: ops.2.via: Invalid string: must match pattern /^[0-9a-f]{32}$/'],
  ])
  expect(observerSystemPrompt).toContain('its via is the id of the artifact version from batch.artifact_versions that carries that result, or null, never a path or a file name')
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

const planSteps = [
  'Stage 1: Parse the commands',
  'Stage 2: Keep the values in memory',
  'Stage 3: Write the log to disk',
  'Stage 4: Recover the store after a crash',
  'Stage 5: Document the command line',
  'Stage 6: Test the failure modes',
]

const longPlan = [
  '# Plan',
  '',
  ...planSteps.flatMap((step, stage) => [
    `## ${step}`,
    '',
    ...Array.from(
      { length: 14 },
      (_, task) =>
        `- Task ${String(stage + 1)}.${String(task + 1)}: change the code of this stage, cover it with a test, run the whole suite and note the result.`,
    ),
    '',
  ]),
].join('\n')

test('a plan file longer than a batch line reaches the follow-up whole, and every step of it becomes a planned stage', async (context) => {
  const scene = await createScene(context, { claude: [{ kind: 'script', script: 'plan' }] })
  const session = scene.claudeSession('session-plan')
  await session.start()
  await session.write('PLAN.md', longPlan)
  scene.scheduler.wake()
  scene.advance(5_000)
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict }) => verdict)).toEqual(['needs_requested', 'accepted'])
  const [first, followUp] = scene.prompts('claude')
  const written = first?.batch.facts.find(({ kind }) => kind === 'action_start')
  expect(written?.truncated).toEqual([{ path: 'payload.input.content', length: longPlan.length }])
  expect(followUp?.batch).toEqual(first?.batch)
  expect(followUp?.materials).toMatchObject([{ kind: 'raw_record', seq: written?.seq, truncated: null }])
  const [material] = followUp?.materials ?? []
  expect(material?.kind === 'raw_record' ? JSON.parse(material.payload) : null).toMatchObject({ tool_input: { content: longPlan } })
  expect(followUp === undefined ? Infinity : observerInputTokens(followUp)).toBeLessThanOrEqual(batchLimits.inputTokens)
  const stages = scene.store.model
    .entities(session.run)
    .flatMap((entity) => (entity.kind === 'stage' ? [[entity.value.title, entity.value.origin, entity.value.execution.value.state]] : []))
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
  expect(stages).toEqual(planSteps.map((title) => [title, 'inferred', 'planned']))
})

test('one call per run, two observer calls at once, chat keeps its own slot, and timeouts pause the backend', { timeout: 90_000 }, async (context) => {
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
  expect(scene.calls(a).map(({ verdict, error }) => [verdict, error?.class])).toEqual([['failed', 'timeout']])
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
  expect(scene.tally(c)).toEqual({ pending: 2 })
  expect(scene.scheduler.backendState('claude')).toEqual({ state: 'backoff', attempt: 1, until: epochOf(start + 10_000) })

  scene.advance(10_000)
  expect([a, b, c].map((run) => scene.tally(run))).toEqual([{ in_call: 2 }, { pending: 2 }, { pending: 2 }])
  await scene.scheduler.idle()
  expect([a, b, c].map((run) => scene.tally(run))).toEqual([{ interpreted: 2 }, { interpreted: 2 }, { interpreted: 2 }])
  expect(scene.scheduler.backendState('claude')).toEqual({ state: 'ok' })
})

test('a run waits for an admitted backend of its vendor', async (context) => {
  const scene = await createScene(context, { admit: [], claude: [accepted], codex: [accepted] })
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

test('an overridden backend gets no facts of another vendor without crossVendor', async (context) => {
  const scene = await createScene(context, { admit: ['codex'], backend: 'codex', codex: [accepted] })
  const session = scene.claudeSession('session-excluded')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ not_interpreted: 2 })
  expect(scene.calls(session.run)).toEqual([])
  expect(scene.store.gaps.open('cross_vendor_excluded')).toMatchObject([
    { run: session.run, details: 'facts of this session are not sent to the codex observer without observer.crossVendor' },
  ])
})

test('an overridden backend gets facts of another vendor with crossVendor', async (context) => {
  const scene = await createScene(context, { admit: ['codex'], backend: 'codex', crossVendor: true, codex: [accepted] })
  const session = scene.claudeSession('session-crossing')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ interpreted: 2 })
  expect(scene.prompts('codex').map(({ run }) => [run.id, run.runtime])).toEqual([[session.run, 'claude']])
  expect(scene.calls(session.run).map(({ backend }) => backend)).toEqual(['codex'])
})

test('facts beyond the active queue are deferred from the oldest with a visible gap', async (context) => {
  const scene = await createScene(context, { claude: [accepted, accepted], limits: { queueFacts: 3 } })
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
  const [summary] = scene.calls(stale.run)
  expect(summary?.verdict).toBe('accepted')
  expect(summary?.input.batch).toMatchObject({ facts: [], backlog: { facts: 2 } })
  expect(scene.statuses(stale.run).map(({ status, observer_call: call }) => [status, call])).toEqual([
    ['deferred', summary?.id],
    ['deferred', summary?.id],
  ])
})

test('the system clock drives the batch timer', async (context) => {
  const scene = await createScene(context, { claude: [accepted], systemClock: true, limits: { delayMs: 2_000 } })
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
  await expect(scene.scheduler.chat((signal) => scene.claude.execute({ input: {}, signal }))).rejects.toThrow('closed')
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
      at: epochOf(start),
      limits: batchLimits,
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
  scene.advance(9_999)
  expect(scene.tally(session.run)).toEqual({ pending: 2 })
  scene.advance(1)
  expect(scene.tally(session.run)).toEqual({ in_call: 2 })
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
  await scene.scheduler.close()
})

test('a restart after a finished call keeps calls of a run ten seconds apart', async (context) => {
  const scene = await createScene(context, { claude: [accepted, accepted] })
  const session = scene.claudeSession('session-paced')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ interpreted: 2 })

  await scene.restart()
  await session.permission()
  scene.scheduler.wake()
  scene.advance(9_999)
  expect(scene.tally(session.run)).toEqual({ interpreted: 2, pending: 1 })
  scene.advance(1)
  expect(scene.tally(session.run)).toEqual({ interpreted: 2, in_call: 1 })
  await scene.scheduler.idle()
  expect(scene.calls(session.run).map(({ started_at: started }) => started)).toEqual([epochOf(start), epochOf(start + 10_000)])
})

test('a fact that arrives during a call ages from its arrival, so its batch starts as soon as the call ends', async (context) => {
  let gate = ''
  const scene = await createScene(context, {
    claude: [accepted, accepted],
    executors: ({ root, claude, launcher }) => {
      gate = join(root, 'gate')
      return { claude: launcher(gated(gate, claude)) }
    },
  })
  const session = scene.claudeSession('session-arrival')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  scene.advance(1_000)
  await session.tools(1)
  scene.scheduler.wake()
  scene.advance(19_000)
  expect(scene.tally(session.run)).toEqual({ in_call: 2, pending: 1 })

  await writeFile(gate, '')
  await until(() => scene.calls(session.run).length === 2)
  expect(scene.calls(session.run).map(({ started_at: started }) => started)).toEqual([epochOf(start), epochOf(start + 20_000)])
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ interpreted: 3 })
})

test('the queue bound applies to a run while its call is running', async (context) => {
  let gate = ''
  const scene = await createScene(context, {
    claude: [accepted, accepted],
    limits: { queueFacts: 2 },
    executors: ({ root, claude, launcher }) => {
      gate = join(root, 'gate')
      return { claude: launcher(gated(gate, claude)) }
    },
  })
  const session = scene.claudeSession('session-busy')
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await session.tools(3)
  scene.scheduler.wake()
  expect(scene.tally(session.run)).toEqual({ in_call: 2, deferred: 1, pending: 2 })
  expect(scene.store.gaps.open('summarized_backlog')).toMatchObject([{ run: session.run }])

  await writeFile(gate, '')
  await scene.scheduler.idle()
  scene.advance(10_000)
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ interpreted: 4, deferred: 1 })
})

test('facts of a run whose backend is down are deferred after 24 hours without another wake', async (context) => {
  const scene = await createScene(context, { admit: [] })
  const session = scene.claudeSession('session-down')
  await session.start()
  scene.scheduler.wake()
  scene.advance(24 * 60 * 60 * 1_000)
  expect(scene.tally(session.run)).toEqual({ pending: 1 })
  expect(scene.store.gaps.open('summarized_backlog')).toEqual([])

  scene.advance(1)
  expect(scene.tally(session.run)).toEqual({ deferred: 1 })
  expect(scene.store.gaps.open('summarized_backlog')).toMatchObject([{ run: session.run }])
})

test('the reasons of a rejected response survive a backend failure and a restart, and neither spends an attempt', { timeout: 60_000 }, async (context) => {
  const scene = await createScene(context, { claude: [outdated, { kind: 'timeout' }, accepted], timeoutMs: 5_000 })
  const session = scene.claudeSession('session-reasons')
  const attempts = () => scene.statuses(session.run).map(({ status, attempts: count }) => [status, count])
  await session.start()
  await session.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  scene.advance(10_000)
  await scene.scheduler.idle()
  expect(attempts()).toEqual([
    ['pending', 1],
    ['pending', 1],
  ])

  scene.store.transaction((transaction) =>
    startObserverBatch(transaction, {
      run: session.run,
      backend: 'claude',
      crossVendor: false,
      id: ObserverCallId.parse('stopped-call'),
      at: epochOf(start + 10_000),
      limits: batchLimits,
    }),
  )
  await scene.restart()
  expect(attempts()).toEqual([
    ['pending', 1],
    ['pending', 1],
  ])
  scene.advance(10_000)
  scene.scheduler.wake()
  await scene.scheduler.idle()

  expect(scene.calls(session.run).map(({ verdict, input }) => [verdict, input.previous_attempt?.reasons ?? null])).toEqual([
    ['rejected', null],
    ['failed', [rejection]],
    ['failed', [rejection]],
    ['accepted', [rejection]],
  ])
  expect(attempts()).toEqual([
    ['interpreted', 2],
    ['interpreted', 2],
  ])
})

test('the batch size counts payload bytes, not characters', async (context) => {
  const scene = await createScene(context, { claude: [accepted, accepted], limits: { batchBytes: 5_000 } })
  const session = scene.claudeSession('session-bytes')
  await session.start()
  await session.command(`echo ${'я'.repeat(3_000)}`)
  const text = (fact: FactId): string =>
    JSON.stringify(scene.store.facts.get(fact)?.payload, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))
  const queued = scene.store.interpretations.pending(session.run)
  expect(queued.some(({ urgent }) => urgent)).toBe(false)
  expect(queued.reduce((total, { fact }) => total + text(fact).length, 0)).toBeLessThan(5_000)
  expect(queued.reduce((total, { fact }) => total + Buffer.byteLength(text(fact)), 0)).toBeGreaterThanOrEqual(5_000)

  scene.scheduler.wake()
  expect(scene.tally(session.run)).toEqual({ in_call: 1, pending: 1 })
  await scene.scheduler.idle()
  scene.advance(10_000)
  await scene.scheduler.idle()
  expect(scene.calls(session.run).map(({ input }) => input.batch.facts.map(({ kind }) => kind))).toEqual([
    ['session_start'],
    ['action_start'],
  ])
})

test.skipIf(process.platform === 'win32')(
  'a process tree that has not stopped keeps its observer or chat slot until the backend confirms the stop',
  { timeout: 90_000 },
  async (context) => {
    let helper = ''
    const scene = await createScene(context, {
      admit: ['codex'],
      claude: [accepted, accepted],
      codex: [accepted, accepted, { kind: 'answer', output: { base_version: 0, ops: [], needs: [] } }],
      executors: ({ root, claude, launcher }) => {
        helper = join(root, 'zombie-helper')
        return { claude: launcher(zombieTree(join(root, 'observer-tree'), helper, claude)) }
      },
    })
    await promisify(execFile)('cc', [fileURLToPath(new URL('zombie.c', import.meta.url)), '-o', helper])
    const chatTree = scene.launcher(zombieTree(join(scene.root, 'chat-tree'), helper, scene.fakeClaude))
    const release = (tree: string): Promise<void> => writeFile(join(scene.root, tree, 'release'), '')
    const question = 'Which stage is blocked?'
    const asked = (): boolean => scene.fakeCodex.calls().some((call) => call.prompt?.includes(question) === true)
    const stuck = scene.claudeSession('session-stuck')
    const [first, second] = [scene.codexSession('thread-first'), scene.codexSession('thread-second')]
    let idled = false
    try {
      await stuck.start()
      await stuck.permission()
      scene.scheduler.wake()
      expect(scene.tally(stuck.run)).toEqual({ in_call: 2 })
      const stuckChat = scene.scheduler.chat((signal) => chatTree.execute({ input: { chat: 'first' }, signal }))
      expect(await stuckChat).toMatchObject({ ok: false, error: { class: 'process_stuck' } })
      await until(() => scene.calls(stuck.run)[0]?.verdict === 'failed')
      expect(scene.statuses(stuck.run).map(({ status, attempts }) => [status, attempts])).toEqual([
        ['pending', 0],
        ['pending', 0],
      ])

      const idle = scene.scheduler.idle().then(() => {
        idled = true
      })
      const following = scene.scheduler.chat((signal) => scene.codex.execute({ input: { chat: question }, signal }))
      for (const session of [first, second]) {
        await session.start()
        await session.permission()
      }
      scene.scheduler.wake()
      expect([first, second].map(({ run }) => scene.tally(run))).toEqual([{ in_call: 2 }, { pending: 2 }])
      await until(() => scene.tally(second.run)['interpreted'] === 2)
      await sleep(200)
      expect(asked()).toBe(false)

      await release('chat-tree')
      expect(await following).toMatchObject({ ok: true })
      expect(asked()).toBe(true)
      expect(idled).toBe(false)

      await scene.scheduler.close()
      expect(idled).toBe(false)
      await release('observer-tree')
      await idle
      expect(scene.tally(stuck.run)).toEqual({ pending: 2 })
    } finally {
      await Promise.all(['observer-tree', 'chat-tree'].map(release))
    }
  },
)

const attachedCriterion: ClaudeReply = {
  kind: 'answer',
  output: {
    base_version: { $input: '/model/version' },
    ops: [
      {
        op: 'criterion.add',
        temp_id: 'attached',
        stage: { kind: 'existing', id: { $input: '/model/stages/0/id' } },
        text: 'The attached session ran its check',
        source: 'task',
        evidence: { $input: '/batch/facts/*/id' },
        rationale: 'Attached session',
      },
    ],
    needs: [],
  },
}

test('without crossVendor no text grounded on facts of another vendor reaches the observer', async (context) => {
  const scene = await createScene(context, {
    backend: 'claude',
    crossVendor: true,
    claude: [structured, attachedCriterion, accepted],
  })
  const root = scene.codexSession('thread-root')
  const attached = scene.claudeSession('session-attached')
  await root.start()
  scene.attach('claude', 'session-attached', root.run)
  await attached.start()
  await root.permission()
  scene.scheduler.wake()
  await scene.scheduler.idle()
  await attached.permission()
  scene.scheduler.wake()
  scene.advance(10_000)
  await scene.scheduler.idle()

  const [goal] = scene.store.facts.ofSession({ kind: 'session', runtime: 'codex', session: 'thread-root' })
  const run = scene.store.model.entity(root.run, { kind: 'run', id: root.run })
  if (goal === undefined || run?.kind !== 'run') {
    throw new Error('the codex root must start the run')
  }
  scene.store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run: root.run,
      author: 'rule',
      at: epochOf(start + 10_000),
      changes: [
        {
          op: 'run.goal',
          put: { kind: 'run', value: { ...run.value, goal: { text: 'Ship the codex task', fact: goal.id } } },
          basis: { kind: 'observed' },
          evidence: [goal.id],
        },
      ],
    })
  })
  await scene.restart({ crossVendor: false })
  await attached.tools(1)
  scene.advance(10_000)
  scene.scheduler.wake()
  await scene.scheduler.idle()

  const attention = scene.store.model.entities(root.run).flatMap((entity) => (entity.kind === 'attention_item' ? [entity.value] : []))
  const codexAttention = attention.find(({ evidence }) => evidence.every((id) => scene.store.facts.get(id)?.entity_key.runtime === 'codex'))
  const claudeAttention = attention.find(({ evidence }) => evidence.every((id) => scene.store.facts.get(id)?.entity_key.runtime === 'claude'))
  expect([codexAttention?.kind, claudeAttention?.kind]).toEqual(['permission', 'permission'])
  const [, crossing, separated] = scene.prompts('claude')
  const withheld = [codexAttention?.text ?? '', 'The observer read the batch', 'Review the requested command', 'The command is allowed or denied']
  for (const text of withheld) {
    expect(JSON.stringify(crossing)).toContain(text)
  }
  for (const text of [...withheld, 'Ship the codex task']) {
    expect(JSON.stringify(separated)).not.toContain(text)
  }
  expect(separated?.run).toMatchObject({ id: root.run, runtime: 'codex', goal: null, brief: null, sessions: [{ runtime: 'claude' }] })
  expect(separated?.model.stages).toEqual([])
  expect(separated?.model.criteria).toMatchObject([{ text: 'The attached session ran its check', stage: null }])
  expect(separated?.model.attention.map(({ id }) => id)).toEqual([claudeAttention?.id])
  expect(scene.tally(root.run)).toEqual({ interpreted: 5 })
})

test('the observer gets the protocol prompt and inputs within the token limit until the whole queue is interpreted', async (context) => {
  const scene = await createScene(context, { claude: [accepted, accepted, accepted, accepted], limits: { inputTokens: 2_000 } })
  const session = scene.claudeSession('session-limit')
  await session.start()
  await session.commands(16, `echo ${'x'.repeat(6_000)}`)
  scene.scheduler.wake()
  scene.advance(5_000)
  await scene.scheduler.idle()
  for (let call = 0; call < 3 && scene.tally(session.run)['pending'] !== undefined; call += 1) {
    scene.advance(10_000)
    await scene.scheduler.idle()
  }

  expect(scene.tally(session.run)).toEqual({ interpreted: 17 })
  const inputs = scene.prompts('claude')
  expect(inputs.length).toBeGreaterThan(1)
  expect(inputs.every((input) => observerInputTokens(input) <= 2_000)).toBe(true)
  expect(inputs.flatMap(({ batch }) => batch.facts.map(({ id }) => id))).toEqual(
    scene.store.interpretations.ofRun(session.run).map(({ fact }) => fact).toSorted((left, right) =>
      (scene.store.facts.get(left)?.seq ?? 0) - (scene.store.facts.get(right)?.seq ?? 0),
    ),
  )
  const calls = scene.fakeClaude.calls().filter(({ command }) => command === 'print')
  expect(calls.map(({ systemPrompt }) => systemPrompt)).toEqual(calls.map(() => observerSystemPrompt))
  for (const name of [...ObserverOperation.options, 'base_version', 'needs', 'evidence', 'temp_id']) {
    expect(observerSystemPrompt).toContain(name)
  }
})

test('a fact too large for the input goes without its payload, and the fact after it follows on the timer without another wake', async (context) => {
  const scene = await createScene(context, { claude: [accepted, accepted, accepted] })
  const session = scene.claudeSession('session-large')
  await session.start()
  scene.scheduler.wake()
  scene.advance(5_000)
  await scene.scheduler.idle()
  await session.actions([{ command: 'ls', many: Array<string>(22_000).fill('x') }, { command: 'ls' }])
  scene.scheduler.wake()
  scene.advance(10_000)
  await scene.scheduler.idle()
  expect(scene.tally(session.run)).toEqual({ interpreted: 2, pending: 1 })
  scene.advance(10_000)
  await scene.scheduler.idle()

  expect(scene.tally(session.run)).toEqual({ interpreted: 3 })
  const inputs = scene.prompts('claude')
  expect(inputs.map(({ batch }) => batch.facts.map(({ kind, payload, truncated }) => [kind, payload === null, truncated.map(({ path }) => path)]))).toEqual([
    [['session_start', false, []]],
    [['action_start', true, ['payload']]],
    [['action_start', false, []]],
  ])
  expect(inputs.every((input) => observerInputTokens(input) <= batchLimits.inputTokens)).toBe(true)
  expect(scene.store.gaps.open('not_interpreted')).toEqual([])
})

const unfitNeeds: ClaudeReply = {
  kind: 'answer',
  output: {
    base_version: { $input: '/model/version' },
    ops: [],
    needs: [{ kind: 'action', action: { $input: '/batch/facts/0/action' } }],
  },
}

test('needs whose materials cannot fit get no follow-up: each answer spends an attempt of the batch and says why', async (context) => {
  const scene = await createScene(context, {
    claude: [accepted, unfitNeeds, unfitNeeds, unfitNeeds],
    limits: { inputTokens: 2_000 },
  })
  const session = scene.claudeSession('session-unfit-needs')
  await session.start()
  scene.scheduler.wake()
  scene.advance(5_000)
  await scene.scheduler.idle()
  await session.actions([{ command: 'ls', many: Array<string>(6_000).fill('x') }])
  scene.scheduler.wake()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    scene.advance(10_000)
    await scene.scheduler.idle()
  }

  expect(scene.calls(session.run).map(({ verdict, reasons }) => [verdict, reasons.map(({ cause }) => cause)])).toEqual([
    ['accepted', []],
    ['rejected', ['limit']],
    ['rejected', ['limit']],
    ['rejected', ['limit']],
  ])
  const inputs = scene.prompts('claude')
  expect(inputs.map(({ materials }) => materials.length)).toEqual([0, 0, 0, 0])
  const reason = 'limit: needs: none of the requested materials fits the input limit of 2000 tokens'
  expect(inputs.map(({ previous_attempt: previous }) => previous?.reasons ?? null)).toEqual([null, null, [reason], [reason]])
  expect(scene.statuses(session.run).map(({ status, attempts }) => [status, attempts])).toEqual([
    ['interpreted', 1],
    ['not_interpreted', 3],
  ])
})

test('the context of a run reaches its calls and is recorded again after each call', async (context) => {
  const scene = await createScene(context, { claude: [accepted, accepted] })
  const instructions = join(scene.workspace, 'CLAUDE.md')
  await writeFile(instructions, 'Run the checks before every commit')
  const session = scene.claudeSession('session-context')
  const contexts = (): number =>
    scene.store.facts.ofEntity({ kind: 'run', runtime: 'claude', session: 'session-context' }).filter(({ kind }) => kind === 'context')
      .length
  await session.start()
  scene.scheduler.wake()
  await until(() => contexts() === 1)
  scene.advance(5_000)
  await scene.scheduler.idle()

  await writeFile(instructions, 'Ask before every commit')
  await session.tools(1)
  scene.scheduler.wake()
  await until(() => contexts() === 2)
  scene.advance(10_000)
  await scene.scheduler.idle()

  const texts = scene
    .prompts('claude')
    .map((input) => input.context?.entries.find(({ kind }) => kind === 'instructions')?.text)
  expect(texts).toEqual(['Run the checks before every commit', 'Ask before every commit'])
  expect(scene.tally(session.run)).toEqual({ interpreted: 2 })
})
