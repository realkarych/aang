import { readFileSync } from 'node:fs'
import { codexAdapter } from '@aang/adapter-codex'
import { CollectedRecord, EpochNs, type FactDraft, type OperatingSystem } from '@aang/contract'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { factsOf, parseFacts, record, streamFrom, threadStream, withPayload } from './rollout-records.js'

const planRecordings = new URL('../../../fixtures/sessions/codex/0.160.0/codex_exec/', import.meta.url)
const goalNotification = new URL(
  '../../../docs/research/samples/codex-app-server/notification.thread-goal-updated.json',
  import.meta.url,
)
const published = 'call_aang_1_0'
const completed = 'call_aang_3_0'
const observedAt = EpochNs.parse(1_791_076_742_988_323_785n)

const Playback = z.looseObject({
  steps: z.array(
    z.looseObject({
      kind: z.string(),
      source: z.string().optional(),
      target: z.looseObject({ root: z.string(), path: z.string() }).optional(),
    }),
  ),
})

const GoalNotification = z.looseObject({
  message: z.looseObject({
    params: z.looseObject({
      threadId: z.string(),
      goal: z.looseObject({ threadId: z.string(), objective: z.string() }),
    }),
  }),
})

const RolloutLine = z.looseObject({
  type: z.string(),
  payload: z.looseObject({ id: z.string().optional(), type: z.string().optional(), turn_id: z.string().optional() }),
})

interface PlanRecording {
  readonly rollout: readonly string[]
  readonly hooks: readonly string[]
  readonly thread: string
  readonly turn: string
}

const readPlanRecording = (os: OperatingSystem): PlanRecording => {
  const directory = new URL(`${os}/plan/`, planRecordings)
  const read = (source: string): string => readFileSync(new URL(source, directory), 'utf8')
  const { steps } = Playback.parse(JSON.parse(read('playback.json')))
  const sources = (kind: string, root?: string): string[] =>
    steps.flatMap((step) =>
      step.kind === kind && step.source !== undefined && (root === undefined || step.target?.root === root)
        ? [step.source]
        : [],
    )
  const rollout = sources('append', 'codex').flatMap((source) => read(source).split('\n').filter((line) => line !== ''))
  const lines = rollout.map((line) => RolloutLine.parse(JSON.parse(line)))
  return {
    rollout,
    hooks: sources('hook').map(read),
    thread: lines.find(({ type }) => type === 'session_meta')?.payload.id ?? '',
    turn: lines.find(({ payload }) => payload.type === 'task_started')?.payload.turn_id ?? '',
  }
}

const hookFacts = (payload: string, index: number): FactDraft[] =>
  factsOf(
    codexAdapter.parse(
      CollectedRecord.parse({
        channel: 'hook',
        runtime: 'codex',
        stream: null,
        position: { kind: 'spool', file: `codex-plan-${String(index)}.spool` },
        hook: { registration: 'user', env: { CODEX_HOME: '/Users/USER/.codex' } },
        observed_at: observedAt,
        payload,
      }),
    ),
  )

const action = (session: string, call: string) => ({ kind: 'action', runtime: 'codex', session, call })

const goalLine = (changes: Record<string, unknown> = {}): string => {
  const { params } = GoalNotification.parse(JSON.parse(readFileSync(goalNotification, 'utf8'))).message
  return JSON.stringify({
    timestamp: '2026-10-01T12:05:09.700Z',
    ordinal: 7,
    type: 'event_msg',
    payload: { type: 'thread_goal_updated', threadId: params.threadId, goal: params.goal, ...changes },
  })
}

describe.each<OperatingSystem>(['macos', 'linux', 'windows'])('the reference plan session of codex exec on %s', (os) => {
  const recording = readPlanRecording(os)
  const { thread, turn } = recording
  const stream = codexAdapter.streamKey(recording.rollout.slice(0, 1))

  test('parses every rollout line and publishes the plan, then its completion, from the update_plan calls', () => {
    const results = recording.rollout.map((line) => codexAdapter.parse(record(line, stream)))
    const plans = results.flatMap(factsOf).filter((fact) => fact.kind === 'plan_update')

    expect(thread).not.toBe('')
    expect(stream).toBe(`codex:${thread}:${thread}`)
    expect(results.map(({ parse_state: state }) => state)).toEqual(results.map(() => 'parsed'))
    expect(plans).toMatchObject([
      {
        entity_key: action(thread, published),
        speaker: 'solver',
        urgent: true,
        format_verified: true,
        runtime_ids: { session_id: thread, thread_id: thread, turn_id: turn, call_id: published },
        payload: {
          source: 'rollout_plan',
          text: null,
          items: [
            { id: null, text: 'Inspect the project', status: 'in_progress' },
            { id: null, text: 'Write the summary', status: 'pending' },
          ],
        },
      },
      {
        entity_key: action(thread, completed),
        format_verified: true,
        payload: {
          source: 'rollout_plan',
          items: [
            { id: null, text: 'Inspect the project', status: 'completed' },
            { id: null, text: 'Write the summary', status: 'completed' },
          ],
        },
      },
    ])
  })

  test('starts the same plan actions from the rollout and the hooks, while only the rollout carries the plan', () => {
    const rolloutFacts = recording.rollout.flatMap((line) => factsOf(codexAdapter.parse(record(line, stream))))
    const hooks = recording.hooks.flatMap(hookFacts)
    const planActions = (facts: readonly FactDraft[]) =>
      facts.flatMap((fact) =>
        fact.kind === 'action_start' && fact.payload.action_kind === 'plan'
          ? [[fact.payload.tool, fact.entity_key]]
          : [],
      )

    expect(planActions(rolloutFacts)).toEqual([
      ['update_plan', action(thread, published)],
      ['update_plan', action(thread, completed)],
    ])
    expect(planActions(hooks)).toEqual(planActions(rolloutFacts))
    expect(hooks.filter((fact) => fact.kind === 'plan_update')).toEqual([])
  })
})

describe('an update_plan call', () => {
  const planner = threadStream('01a1047e-3735-7e52-9cfe-4d4707f85084')
  const planCall = (args: unknown) =>
    parseFacts(
      withPayload('response_item.function_call.exec_command.mock.json', {
        name: 'update_plan',
        arguments: JSON.stringify(args),
        call_id: published,
      }),
      planner,
    )

  test('keeps its explanation and reads a step status it does not know as unknown', () => {
    expect(
      planCall({ explanation: 'Narrowed the scope', plan: [{ step: 'Check', status: 'blocked' }, { step: 'Ship' }] }),
    ).toMatchObject([
      { kind: 'action_start', payload: { tool: 'update_plan', action_kind: 'plan' } },
      {
        kind: 'plan_update',
        payload: {
          source: 'rollout_plan',
          text: 'Narrowed the scope',
          items: [
            { id: null, text: 'Check', status: 'unknown' },
            { id: null, text: 'Ship', status: 'unknown' },
          ],
        },
      },
    ])
  })

  test('without a readable plan only starts the action, and under a namespace is not a plan', () => {
    expect(planCall({ steps: ['Check'] }).map(({ kind }) => kind)).toEqual(['action_start'])
    expect(
      parseFacts(
        withPayload('response_item.function_call.exec_command.mock.json', {
          namespace: 'mcp__planner',
          name: 'update_plan',
          arguments: JSON.stringify({ plan: [{ step: 'Check', status: 'pending' }] }),
        }),
        planner,
      ),
    ).toMatchObject([{ kind: 'action_start', payload: { tool: 'mcp__planner/update_plan', action_kind: 'mcp' } }])
  })
})

describe('a thread goal update', () => {
  test('is an unverified plan fact of its thread with the objective as the text', () => {
    const line = goalLine()
    const { params } = GoalNotification.parse(JSON.parse(readFileSync(goalNotification, 'utf8'))).message
    const root = threadStream(params.threadId)

    expect(parseFacts(line, root)).toMatchObject([
      {
        kind: 'plan_update',
        entity_key: { kind: 'session', runtime: 'codex', session: params.threadId },
        speaker: 'runtime',
        urgent: true,
        format_verified: false,
        runtime_ids: { session_id: params.threadId, thread_id: params.threadId, ordinal: 7 },
        payload: { source: 'thread_goal', text: 'Say hi', items: [] },
      },
    ])
  })

  test('of a subagent thread belongs to the subagent, and without an objective stays unknown', () => {
    const root = '01a0f75c-465e-7a01-876f-c7df6fc989a0'
    const child = '01a0f75c-46d2-7430-92a2-c3b0cd5d85b6'
    const subagent = streamFrom(
      JSON.stringify({
        timestamp: '2026-10-01T12:05:09.000Z',
        ordinal: 0,
        type: 'session_meta',
        payload: { id: child, session_id: root, source: { subagent: { thread_spawn: { parent_thread_id: root, depth: 1 } } } },
      }),
    )

    expect(parseFacts(goalLine(), subagent)).toMatchObject([
      { kind: 'plan_update', entity_key: { kind: 'agent', session: root, agent: { kind: 'thread', thread_id: child } } },
    ])
    expect(codexAdapter.parse(record(goalLine({ goal: { status: 'active' } }), subagent))).toMatchObject({
      parse_state: 'unknown',
    })
  })
})
