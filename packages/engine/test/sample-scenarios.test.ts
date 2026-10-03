import type { ActionId, AgentId, Fact, Gap, Runtime, Session } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import { createPlayer } from '@aang/testkit'
import { describe, expect, test, vi } from 'vitest'
import { factsOf, gapsOf, recordsOf, sessionKey } from './harness.js'
import { filesReplay, settle, startScenario } from './scenarios.js'

const original = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const forked = 'cdfb3544-67c1-4590-a4d9-280593b6ed55'
const thread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'
const agentCall = 'toolu_01D254DDPoZEYPvJBjampKox'
const bashCall = 'toolu_017B7FeHZ4yDzFdvKQMwDJB8'

const sessionsOf = (store: Store): Session['key'][] => store.observations.sessions().map(({ key }) => key)

const sessionId = (runtime: Runtime, session: string) => objectId(sessionKey(runtime, session))

const mainAgent = (runtime: Runtime, session: string): AgentId =>
  objectId({ kind: 'agent', runtime, session, agent: { kind: 'main' } })

const claudeAction = (session: string, call: string): ActionId =>
  objectId({ kind: 'action', runtime: 'claude', session, call })

const sessionGaps = (store: Store): [Gap['kind'], Gap['session'], boolean][] =>
  gapsOf(store).map(({ kind, session, closed_at }) => [kind, session, closed_at === null])

const filesOnly = (runtime: Runtime, session: string): [Gap['kind'], Gap['session'], boolean] =>
  ['hooks_inactive', sessionId(runtime, session), true]

const factsOfKind = (store: Store, kind: Fact['kind']): Fact[] => factsOf(store).filter((fact) => fact.kind === kind)

const executionOf = (store: Store, session: string, call: string): string | undefined => {
  const actions = store.observations.actions(sessionId('claude', session))
  return actions.find(({ id }) => id === claudeAction(session, call))?.execution.state
}

describe('the sample scenarios played into watched runtime roots pass through the real collector and adapters', () => {
  test('the Claude subagent scenario shows the subagent spawned by its Agent call before the call returns', async () => {
    const scenario = await startScenario('claude-subagent')
    const replay = filesReplay(scenario)
    const { store } = scenario

    await replay.play({ until: 'subagent-result' })
    const subagent = {
      key: {
        kind: 'agent',
        runtime: 'claude',
        session: original,
        agent: { kind: 'subagent', agent_id: 'aad616394e806288d' },
      },
      role: 'subagent',
      agent_type: 'pinger',
      spawned_by: claudeAction(original, agentCall),
    }
    expect(store.observations.agents(sessionId('claude', original))).toEqual(
      expect.arrayContaining([expect.objectContaining(subagent)]),
    )
    expect(executionOf(store, original, agentCall)).not.toBe('done')

    await replay.play()
    expect(sessionsOf(store)).toEqual([sessionKey('claude', original)])
    expect(store.observations.agents(sessionId('claude', original))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...subagent, parent: mainAgent('claude', original) }),
        expect.objectContaining({ id: mainAgent('claude', original), role: 'main' }),
      ]),
    )
    expect(store.observations.agents(sessionId('claude', original))).toHaveLength(2)
    expect([executionOf(store, original, bashCall), executionOf(store, original, agentCall)]).toEqual(['done', 'done'])
    expect(new Set(recordsOf(store).map(({ parse_state }) => parse_state))).toEqual(new Set(['parsed']))
    expect(sessionGaps(store)).toEqual([filesOnly('claude', original)])
  })

  test('the Claude fork scenario adds the forked session next to the original, each from its own transcript', async () => {
    const scenario = await startScenario('claude-fork')
    const replay = filesReplay(scenario)
    const { store } = scenario

    await replay.play({ until: 'fork' })
    expect(sessionsOf(store)).toEqual([sessionKey('claude', original)])

    await replay.play()
    expect(sessionsOf(store)).toEqual([sessionKey('claude', original), sessionKey('claude', forked)])
    expect(store.cursors.list().map(({ stream, line }) => [stream, line])).toEqual(
      expect.arrayContaining([
        [JSON.stringify(['claude', original, 'main']), 52],
        [JSON.stringify(['claude', forked, 'main']), 49],
      ]),
    )
    expect(sessionGaps(store)).toEqual([filesOnly('claude', original), filesOnly('claude', forked)])
    const forkLinks = store.model
      .entities(runId(sessionKey('claude', forked)))
      .flatMap((entity) => (entity.kind === 'link' ? [entity.value] : []))
    expect(forkLinks).toMatchObject([
      {
        kind: 'common_origin',
        sessions: [sessionId('claude', original)],
        parent_candidate: sessionId('claude', original),
      },
    ])
    expect(store.observations.actions(sessionId('claude', forked)).map(({ inherited }) => inherited)).toEqual([
      true,
      true,
    ])
  })

  test('the Claude compaction scenario records the compaction without turning it into an agent', async () => {
    const scenario = await startScenario('claude-compaction')
    const replay = filesReplay(scenario)
    const { store } = scenario

    await replay.play({ until: 'compact-boundary' })
    expect(factsOfKind(store, 'compaction')).toEqual([])

    await replay.play({ until: 'post-compaction' })
    expect(factsOfKind(store, 'compaction').length).toBeGreaterThan(0)

    await replay.play()
    expect(sessionsOf(store)).toEqual([sessionKey('claude', original)])
    expect(store.observations.agents(sessionId('claude', original)).map(({ role }) => role).sort()).toEqual([
      'main',
      'subagent',
    ])
    expect(store.observations.actions(sessionId('claude', original)).map(({ execution }) => execution.state)).toEqual([
      'done',
      'done',
      'done',
    ])
    expect(sessionGaps(store)).toEqual([filesOnly('claude', original)])
  })

  test('the Codex scenario is one thread whose resumed turn carries the compaction', async () => {
    const scenario = await startScenario('codex-resume-compaction')
    const replay = filesReplay(scenario)
    const { store } = scenario

    await replay.play({ until: 'resume' })
    expect(sessionsOf(store)).toEqual([sessionKey('codex', thread)])
    expect(factsOfKind(store, 'turn_end')).toHaveLength(1)
    expect(factsOfKind(store, 'compaction')).toEqual([])

    await replay.play()
    expect(sessionsOf(store)).toEqual([sessionKey('codex', thread)])
    expect(store.observations.agents(sessionId('codex', thread)).map(({ id }) => id)).toEqual([
      mainAgent('codex', thread),
    ])
    expect(factsOfKind(store, 'turn_end')).toHaveLength(2)
    expect(factsOfKind(store, 'compaction').length).toBeGreaterThan(0)
    expect(recordsOf(store).filter(({ parse_state }) => parse_state === 'invalid')).toEqual([])
    expect(sessionGaps(store)).toEqual([
      filesOnly('codex', thread),
      ['unknown_records', sessionId('codex', thread), true],
    ])
  })
})

interface OtlpRequest {
  readonly resourceLogs: readonly {
    readonly scopeLogs: readonly {
      readonly logRecords: readonly {
        readonly attributes: readonly { readonly key: string; readonly value: { readonly stringValue?: string } }[]
      }[]
    }[]
  }[]
}

const toolDecision = 'codex.tool_decision'

const isToolDecision = ({ resourceLogs }: OtlpRequest): boolean =>
  resourceLogs
    .flatMap(({ scopeLogs }) => scopeLogs.flatMap(({ logRecords }) => logRecords))
    .every(({ attributes }) =>
      attributes.some(({ key, value }) => key === 'event.name' && value.stringValue === toolDecision),
    )

test('the Codex OTel scenario delivers every tool decision through the real receiver and drops the other events', async () => {
  const scenario = await startScenario('codex-otel')
  const { store, live, roots, manifest } = scenario
  const token = 'sample-scenario-otel-0123456789abcdef'
  const listener = await live.listenOtel(token)
  const requests = manifest.steps.flatMap((step): OtlpRequest[] => {
    const body = step.kind === 'otlp' ? manifest.sources.get(step.source) : undefined
    return body === undefined ? [] : [JSON.parse(body.toString('utf8')) as OtlpRequest]
  })
  const decisions = requests.filter(isToolDecision)
  const player = createPlayer(manifest, {
    roots,
    otlp: `http://${listener.host}:${String(listener.port)}/otel/${token}/v1/logs`,
    timeScale: 0,
  })

  await player.play()

  await vi.waitFor(() => {
    expect(recordsOf(store)).toHaveLength(decisions.length)
  }, settle)
  expect(decisions.length).toBeGreaterThan(0)
  expect(requests.length).toBeGreaterThan(decisions.length)
  expect(recordsOf(store).map(({ channel, payload }) => [channel, JSON.parse(payload) as unknown])).toEqual(
    decisions.map((request) => ['otel', request]),
  )
  expect(gapsOf(store)).toEqual([])
})
