import { join } from 'node:path'
import {
  type ActionId,
  type AgentId,
  type AppliedViewRule,
  type ArtifactVersionId,
  type AttentionItem,
  type Fact,
  type JsonValue,
  type RunId,
  RunSnapshot,
  StageId,
  type ViewPlacement,
  ViewRuleId,
  type ViewRuleSource,
  type ViewRuleSpec,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import {
  addViewRule,
  createReadQueries,
  revokeViewRule,
  solverUsage,
  stageUsage,
  ViewRuleError,
} from '@aang/engine'
import type { Store } from '@aang/store'
import { describe, expect, onTestFinished, test } from 'vitest'
import { jsonlFile, snapshotBatch } from './batches.js'
import { sessionKey } from './harness.js'
import { at } from './model.js'
import { createStage, temporary } from './observer-fixtures.js'
import { expectFeedReproduces, openScene, type Scene, type Source } from './read-scene.js'
import { claudeHook, codexGuardianRollout, codexHook, codexRollout } from './samples.js'

const session = 'review-run'
const reviewer = 'rev'
const origin = Date.parse('2026-10-01T12:00:00.000Z')

const isoAt = (second: number): string => new Date(origin + second * 1000).toISOString()

interface Reply {
  readonly id: string
  readonly content: readonly object[]
  readonly output: number
  readonly stop: string
}

const prompt = (uuid: string, second: number, text: string) => ({
  type: 'user',
  uuid,
  timestamp: isoAt(second),
  message: { role: 'user', content: text },
})

const reply = (uuid: string, second: number, { id, content, output, stop }: Reply) => ({
  type: 'assistant',
  uuid,
  timestamp: isoAt(second),
  message: {
    id,
    model: 'claude-opus-5-5',
    role: 'assistant',
    content,
    stop_reason: stop,
    usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: output },
  },
})

const toolResult = (uuid: string, second: number, call: string, content = 'ok', extra: object = {}, error = false) => ({
  type: 'user',
  uuid,
  timestamp: isoAt(second),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content, is_error: error }] },
  ...extra,
})

const text = (value: string) => ({ type: 'text', text: value })

const toolUse = (id: string, name: string, input: Record<string, JsonValue>) => ({ type: 'tool_use', id, name, input })

const spawnLines = (agent: string, call: string, second: number) => [
  reply(`spawn-${agent}`, second, {
    id: `msg-spawn-${agent}`,
    content: [toolUse(call, 'Agent', { description: 'Review the parser', prompt: 'Review it' })],
    output: 40,
    stop: 'tool_use',
  }),
  toolResult(`spawned-${agent}`, second + 20, call, 'Reviewed', { toolUseResult: { agentId: agent } }),
]

const mainRecords = (project: string) => [
  prompt('p-1', 0, 'Write the parser and have it reviewed'),
  reply('m-1', 1, {
    id: 'msg-main-1',
    content: [toolUse('main-write', 'Write', { file_path: join(project, 'parser.ts'), content: 'export {}\n' })],
    output: 30,
    stop: 'tool_use',
  }),
  toolResult('r-main-write', 2, 'main-write'),
  ...spawnLines(reviewer, 'call-review', 3),
  reply('m-3', 31, { id: 'msg-main-3', content: [text('Reviewed')], output: 10, stop: 'end_turn' }),
]

const reviewerRecords = (agent: string, project: string) => [
  prompt(`${agent}-p`, 4, 'Review the parser'),
  reply(`${agent}-1`, 5, {
    id: `msg-${agent}-1`,
    content: [toolUse(`${agent}-read`, 'Read', { file_path: join(project, 'parser.ts') })],
    output: 20,
    stop: 'tool_use',
  }),
  toolResult(`${agent}-r1`, 6, `${agent}-read`, 'export {}'),
  reply(`${agent}-2`, 7, {
    id: `msg-${agent}-2`,
    content: [toolUse(`${agent}-write`, 'Write', { file_path: join(project, `${agent}.md`), content: '# Review\n' })],
    output: 25,
    stop: 'tool_use',
  }),
  toolResult(`${agent}-r2`, 8, `${agent}-write`),
  reply(`${agent}-3`, 9, {
    id: `msg-${agent}-3`,
    content: [toolUse(`${agent}-test`, 'Bash', { command: 'pnpm test' })],
    output: 15,
    stop: 'tool_use',
  }),
  toolResult(`${agent}-r3`, 10, `${agent}-test`, 'Exit code 1\ntests failed', {}, true),
  reply(`${agent}-4`, 11, { id: `msg-${agent}-4`, content: [text('Found issues')], output: 12, stop: 'end_turn' }),
]

const lineOf = (source: Source, agent: string | null, record: object): string =>
  JSON.stringify({
    sessionId: source.session,
    cwd: source.cwd,
    version: '2.1.286',
    ...(agent === null ? {} : { isSidechain: true, agentId: agent }),
    ...record,
  })

const subagentOf = (agent: string): AgentId =>
  objectId({ kind: 'agent', runtime: 'claude', session, agent: { kind: 'subagent', agent_id: agent } })
const mainAgent = objectId({ kind: 'agent', runtime: 'claude', session, agent: { kind: 'main' } })
const actionOf = (call: string): ActionId => objectId({ kind: 'action', runtime: 'claude', session, call })

interface ReviewRun {
  readonly scene: Scene
  readonly store: Store
  readonly source: Source
  readonly run: RunId
  readonly stage: (title: string) => StageId
  readonly snapshot: () => RunSnapshot
  readonly add: (rule: ViewRuleSpec, second: number, source?: ViewRuleSource) => AppliedViewRule
  readonly revoke: (id: ViewRuleId, second: number) => ReturnType<typeof revokeViewRule>
  readonly reviewerFile: (agent: string, ino: bigint) => Promise<void>
  readonly mainFile: (records: readonly object[]) => Promise<void>
}

const placementOf = (snapshot: RunSnapshot, kind: ViewPlacement['element']['kind'], id: string) =>
  snapshot.view.placements.find(({ element }) => element.kind === kind && element.id === id)

const attentionOf = (snapshot: RunSnapshot, kind: AttentionItem['kind']): AttentionItem => {
  const item = snapshot.attention.items.find((own) => own.kind === kind)
  if (item === undefined) {
    throw new Error(`the run has no ${kind} item`)
  }
  return item
}

const versionAt = (store: Store, run: RunId, path: string): ArtifactVersionId => {
  const version = store.artifacts.versions(run).find(({ ref }) => ref.kind === 'file' && ref.path === path)
  if (version === undefined) {
    throw new Error(`the run has no version of ${path}`)
  }
  return version.id
}

const openReviewRun = async (): Promise<ReviewRun> => {
  const scene = await openScene(onTestFinished)
  const { store, reads, projects } = scene
  const source = scene.source(session)
  const run = scene.runOf(session)
  let mainLines: string[] = []
  const mainFile = async (records: readonly object[]) => {
    const start = mainLines.length + 1
    mainLines = [...mainLines, ...records.map((record) => lineOf(source, null, record))]
    const file = jsonlFile({ runtime: 'claude', path: join(projects, `${session}.jsonl`), lines: mainLines, ino: 1n })
    await scene.ingest(file.batch(start, mainLines.length))
  }
  const reviewerFile = async (agent: string, ino: bigint) => {
    const lines = reviewerRecords(agent, scene.project).map((record) => lineOf(source, agent, record))
    const path = join(projects, session, 'subagents', `agent-${agent}.jsonl`)
    await scene.ingest(jsonlFile({ runtime: 'claude', path, lines, ino }).batch(1, lines.length))
    await scene.ingest(
      snapshotBatch({
        path: join(projects, session, 'subagents', `agent-${agent}.meta.json`),
        content: { agentType: 'code-reviewer', description: 'Review the parser', toolUseId: `call-${agent}` },
      }),
    )
  }
  const snapshot = (): RunSnapshot => {
    const value = reads.snapshot(run)
    if (value === null) {
      throw new Error('the review run must exist')
    }
    expect(RunSnapshot.safeParse(value).error).toBeUndefined()
    return value
  }
  return {
    scene,
    store,
    source,
    run,
    stage: (title) => {
      const found = snapshot().model.stages.find((own) => own.title === title)
      if (found === undefined) {
        throw new Error(`the run has no stage ${title}`)
      }
      return found.id
    },
    snapshot,
    add: (rule, second, origin = 'ui') => {
      const applied = store.transaction((transaction) =>
        addViewRule(transaction, { run, rule, source: origin, at: at(second) }),
      )
      if (applied === null) {
        throw new Error('the review run must accept view rules')
      }
      return applied
    },
    revoke: (id, second) => store.transaction((transaction) => revokeViewRule(transaction, { run, id, at: at(second) })),
    reviewerFile,
    mainFile,
  }
}

const reviewRun = async (): Promise<ReviewRun> => {
  const review = await openReviewRun()
  const { scene, source, run } = review
  await review.mainFile(mainRecords(scene.project))
  await review.reviewerFile(reviewer, 2n)
  await scene.hooks({
    file: '1-permission.evt',
    payload: claudeHook('PermissionRequest.Bash.json', source, { agent_id: reviewer, agent_type: 'code-reviewer' }),
  })
  const facts = scene.factsOf(source).filter(({ kind }) => kind !== 'git_snapshot')
  const evidence = evidenceOf(facts)
  const grounds = { evidence, rationale: 'The reviewer works on its own stage' }
  const answered = scene.observe(
    run,
    'map-call',
    facts,
    [
      { ...createStage(evidence, 'main'), title: 'Write the parser' },
      { ...createStage(evidence, 'review'), title: 'Review the parser', parent: temporary('main') },
      {
        ...grounds,
        op: 'actions.assign',
        actions: [actionOf('main-write'), actionOf('call-review')],
        stage: temporary('main'),
      },
      { ...grounds, op: 'agents.participate', agents: [mainAgent], stage: temporary('main') },
      {
        ...grounds,
        op: 'actions.assign',
        actions: [actionOf('rev-read'), actionOf('rev-write'), actionOf('rev-test')],
        stage: temporary('review'),
      },
      { ...grounds, op: 'agents.participate', agents: [subagentOf(reviewer)], stage: temporary('review') },
    ],
    { at: 40 },
  )
  expect(answered).toMatchObject({ status: 'accepted' })
  return review
}

const evidenceOf = (facts: readonly Fact[]): Fact['id'][] => {
  const [first] = facts
  if (first === undefined) {
    throw new Error('the run must have facts')
  }
  return [first.id]
}

const withoutView = (snapshot: RunSnapshot): object =>
  Object.fromEntries(Object.entries(snapshot).filter(([field]) => field !== 'view' && field !== 'change_seq'))

const collapseReviewers: ViewRuleSpec = {
  action: 'collapse',
  selector: { kind: 'agent_type', agent_type: 'Code-Reviewer' },
  params: null,
}

describe('view rules', () => {
  test('collapsing the reviewers from the chat keeps their usage, results and questions', async () => {
    const review = await reviewRun()
    const { store, run, scene } = review
    const before = review.snapshot()
    const head = store.model.head(run)
    const usage = solverUsage(store, run)
    const reviewStage = review.stage('Review the parser')
    const stageTotals = stageUsage(store, run, reviewStage)
    const inspected = scene.reads.inspector(run, reviewStage)

    const applied = review.add(collapseReviewers, 50, 'chat')

    expect(applied).toEqual({
      rule: {
        id: expect.any(String) as unknown,
        run,
        source: 'chat',
        created_at: at(50),
        revoked_at: null,
        action: 'collapse',
        selector: { kind: 'agent_type', agent_type: 'Code-Reviewer' },
        params: null,
      },
      affected: [{ kind: 'agent', id: subagentOf(reviewer) }],
    })
    const after = expectFeedReproduces(scene.reads, run, before)
    const permission = attentionOf(after, 'permission')
    const failed = attentionOf(after, 'failed_check')
    expect(after.view.rules).toEqual([applied])
    expect(after.view.placements).toEqual([
      {
        element: { kind: 'agent', id: subagentOf(reviewer) },
        visibility: {
          state: 'collapsed',
          rule: applied.rule.id,
          totals: {
            agents: 1,
            actions: 3,
            running_actions: 0,
            outcomes: { ok: 2, error: 1, denied: 0, interrupted: 0, unknown: 0 },
            usage: usage.agents.find(({ agent }) => agent === subagentOf(reviewer))?.totals,
            outputs: [versionAt(store, run, join(scene.project, 'rev.md'))],
          },
        },
        group: null,
        detail: null,
        attention: [failed.id, permission.id].sort(),
      },
    ])
    expect(after.view.placements[0]?.visibility).toMatchObject({ totals: { usage: { records: 4 } } })
    expect([permission.resolution, permission.runtime_wait, failed.resolution]).toEqual(['open', 'active', 'open'])
    expect(withoutView(after)).toEqual(withoutView(before))
    expect(store.model.head(run)).toBe(head)
    expect(solverUsage(store, run)).toEqual(usage)
    expect(stageUsage(store, run, reviewStage)).toEqual(stageTotals)
    expect(scene.reads.inspector(run, reviewStage)).toEqual({
      ...inspected,
      change_seq: after.change_seq,
    })
  })

  test('a hidden agent keeps its contribution to the run usage, its stage and the attention zone', async () => {
    const review = await reviewRun()
    const { store, run, scene } = review
    const before = review.snapshot()
    const usage = solverUsage(store, run)

    const hidden = review.add({ action: 'hide', selector: { kind: 'agent_name', name: 'nobody' }, params: null }, 50)
    const byRole = review.add({ action: 'hide', selector: { kind: 'agent_role', role: 'SUBAGENT' }, params: null }, 51)

    expect(hidden.affected).toEqual([])
    expect(byRole.affected).toEqual([{ kind: 'agent', id: subagentOf(reviewer) }])
    const after = expectFeedReproduces(scene.reads, run, before)
    expect(after.view.rules.map(({ rule }) => rule.id)).toEqual([hidden.rule.id, byRole.rule.id])
    expect(placementOf(after, 'agent', subagentOf(reviewer))).toEqual({
      element: { kind: 'agent', id: subagentOf(reviewer) },
      visibility: { state: 'hidden', rule: byRole.rule.id },
      group: null,
      detail: null,
      attention: [attentionOf(after, 'failed_check').id, attentionOf(after, 'permission').id].sort(),
    })
    expect(after.summary).toEqual(before.summary)
    expect(after.attention).toEqual(before.attention)
    expect(after.objects).toEqual(before.objects)
    expect(solverUsage(store, run)).toEqual(usage)
    const inspected = scene.reads.inspector(run, review.stage('Review the parser'))
    expect(inspected?.agents.map(({ id }) => id)).toEqual([subagentOf(reviewer)])
    expect(inspected?.actions.map(({ id }) => id).sort()).toEqual(
      [actionOf('rev-read'), actionOf('rev-write'), actionOf('rev-test')].sort(),
    )
  })

  test('a collapsed main agent sums its subagents, a collapsed stage sums its substages', async () => {
    const review = await reviewRun()
    const { store, run, scene } = review
    await review.mainFile([
      reply('m-4', 32, {
        id: 'msg-main-4',
        content: [toolUse('main-grep', 'Grep', { pattern: 'TODO' })],
        output: 5,
        stop: 'tool_use',
      }),
    ])
    const before = review.snapshot()
    const usage = solverUsage(store, run)
    const mainStage = review.stage('Write the parser')
    const reviewStage = review.stage('Review the parser')

    const mainRule = review.add({ action: 'collapse', selector: { kind: 'agent_role', role: 'main' }, params: null }, 50)
    const stageRule = review.add(
      { action: 'collapse', selector: { kind: 'stage_ids', stages: [mainStage, mainStage] }, params: null },
      51,
    )

    expect(stageRule.rule.selector).toEqual({ kind: 'stage_ids', stages: [mainStage] })
    const after = expectFeedReproduces(scene.reads, run, before)
    const attention = [attentionOf(after, 'failed_check').id, attentionOf(after, 'permission').id].sort()
    const outputs = [
      versionAt(store, run, join(scene.project, 'parser.ts')),
      versionAt(store, run, join(scene.project, 'rev.md')),
    ].sort()
    expect(placementOf(after, 'agent', mainAgent)).toEqual({
      element: { kind: 'agent', id: mainAgent },
      visibility: {
        state: 'collapsed',
        rule: mainRule.rule.id,
        totals: {
          agents: 2,
          actions: 6,
          running_actions: 1,
          outcomes: { ok: 4, error: 1, denied: 0, interrupted: 0, unknown: 0 },
          usage: usage.journal.totals,
          outputs,
        },
      },
      group: null,
      detail: null,
      attention,
    })
    const stages = usage.journal.stages.filter(({ stage }) => stage === mainStage || stage === reviewStage)
    expect(stages).toHaveLength(2)
    expect(placementOf(after, 'stage', mainStage)).toMatchObject({
      visibility: {
        state: 'collapsed',
        rule: stageRule.rule.id,
        totals: {
          agents: 2,
          actions: 5,
          outputs,
          usage: {
            records: stages.reduce((sum, { totals }) => sum + totals.records, 0),
            tokens: {
              output_tokens: stages.reduce((sum, { totals }) => sum + totals.tokens.output_tokens, 0),
            },
          },
        },
      },
      attention,
    })
  })

  test('a rule applies to agents, stages and actions that appear after it', async () => {
    const review = await reviewRun()
    const { run, scene } = review
    const collapse = review.add(collapseReviewers, 50)
    const titled = review.add(
      { action: 'group', selector: { kind: 'stage_title', contains: ' second ' }, params: { name: ' Reviews ' } },
      51,
    )
    const tools = review.add({ action: 'hide', selector: { kind: 'action_tool', tool: 'read' }, params: null }, 52)
    const before = review.snapshot()

    expect(titled.affected).toEqual([])
    expect(titled.rule).toMatchObject({ selector: { contains: 'second' }, params: { name: 'Reviews' } })
    expect(tools.affected).toEqual([{ kind: 'action', id: actionOf('rev-read') }])
    await review.mainFile(spawnLines('rev2', 'call-rev2', 60))
    await review.reviewerFile('rev2', 3n)
    const facts = scene.factsOf(review.source).filter(({ kind }) => kind !== 'git_snapshot')
    const evidence = evidenceOf(facts)
    expect(
      scene.observe(
        run,
        'second-call',
        facts,
        [{ ...createStage(evidence, 'second'), title: 'The second review' }],
        { at: 90 },
      ),
    ).toMatchObject({ status: 'accepted' })
    const after = expectFeedReproduces(scene.reads, run, before)

    const affected = new Map(after.view.rules.map(({ rule, affected: elements }) => [rule.id, elements]))
    expect(affected.get(collapse.rule.id)).toEqual(
      [subagentOf(reviewer), subagentOf('rev2')].sort().map((id) => ({ kind: 'agent', id })),
    )
    expect(affected.get(titled.rule.id)).toEqual([{ kind: 'stage', id: review.stage('The second review') }])
    expect(affected.get(tools.rule.id)).toEqual(
      [actionOf('rev-read'), actionOf('rev2-read')].sort().map((id) => ({ kind: 'action', id })),
    )
    expect(placementOf(after, 'agent', subagentOf('rev2'))?.visibility).toMatchObject({
      state: 'collapsed',
      rule: collapse.rule.id,
      totals: { agents: 1, actions: 3, outcomes: { ok: 2, error: 1 }, usage: { records: 4 } },
    })
    expect(placementOf(after, 'stage', review.stage('The second review'))).toEqual({
      element: { kind: 'stage', id: review.stage('The second review') },
      visibility: null,
      group: { name: 'Reviews', rule: titled.rule.id },
      detail: null,
      attention: [],
    })
    expect(placementOf(after, 'action', actionOf('rev2-read'))).toMatchObject({
      visibility: { state: 'hidden', rule: tools.rule.id },
      attention: [],
    })
  })

  test('the latest rule wins on an element, and a detail level takes the questions below it off the map', async () => {
    const review = await reviewRun()
    const { run, scene } = review
    const before = review.snapshot()
    const reviewStage = review.stage('Review the parser')
    const failed = attentionOf(before, 'failed_check')
    const permission = attentionOf(before, 'permission')

    const commands = review.add(
      { action: 'collapse', selector: { kind: 'action_kind', action_kind: 'command' }, params: null },
      50,
    )
    const hidden = review.add({ action: 'hide', selector: { kind: 'action_tool', tool: 'Bash' }, params: null }, 51)
    const grouped = review.add(
      { action: 'group', selector: { kind: 'stage_ids', stages: [reviewStage] }, params: { name: 'A' } },
      52,
    )
    const regrouped = review.add(
      { action: 'group', selector: { kind: 'stage_title', contains: 'REVIEW' }, params: { name: 'B' } },
      53,
    )
    const stagesOnly = review.add(
      { action: 'detail', selector: { kind: 'stage_ids', stages: [reviewStage] }, params: { level: 'stages' } },
      54,
    )
    const reviewerActions = review.add(
      {
        action: 'detail',
        selector: { kind: 'agent_type', agent_type: 'code-reviewer' },
        params: { level: 'all_actions' },
      },
      55,
    )
    const reviewerAlone = review.add(
      { action: 'detail', selector: { kind: 'agent_role', role: 'subagent' }, params: { level: 'stages' } },
      56,
    )
    const mainAgents = review.add(
      { action: 'detail', selector: { kind: 'agent_role', role: 'main' }, params: { level: 'stages_and_agents' } },
      57,
    )
    const mainStage = review.add(
      { action: 'detail', selector: { kind: 'stage_title', contains: 'write' }, params: { level: 'all_actions' } },
      58,
    )

    expect(commands.affected).toEqual([{ kind: 'action', id: actionOf('rev-test') }])
    expect(reviewerActions.affected).toEqual(reviewerAlone.affected)
    const after = expectFeedReproduces(scene.reads, run, before)
    expect(placementOf(after, 'action', actionOf('rev-test'))).toEqual({
      element: { kind: 'action', id: actionOf('rev-test') },
      visibility: { state: 'hidden', rule: hidden.rule.id },
      group: null,
      detail: null,
      attention: [failed.id],
    })
    expect(placementOf(after, 'stage', reviewStage)).toEqual({
      element: { kind: 'stage', id: reviewStage },
      visibility: null,
      group: { name: 'B', rule: regrouped.rule.id },
      detail: { level: 'stages', rule: stagesOnly.rule.id },
      attention: [failed.id, permission.id].sort(),
    })
    expect(grouped.affected).toEqual([{ kind: 'stage', id: reviewStage }])
    expect(placementOf(after, 'agent', subagentOf(reviewer))).toEqual({
      element: { kind: 'agent', id: subagentOf(reviewer) },
      visibility: null,
      group: null,
      detail: { level: 'stages', rule: reviewerAlone.rule.id },
      attention: [failed.id],
    })
    expect(placementOf(after, 'agent', mainAgent)).toEqual({
      element: { kind: 'agent', id: mainAgent },
      visibility: null,
      group: null,
      detail: { level: 'stages_and_agents', rule: mainAgents.rule.id },
      attention: [failed.id],
    })
    expect(placementOf(after, 'stage', review.stage('Write the parser'))).toEqual({
      element: { kind: 'stage', id: review.stage('Write the parser') },
      visibility: null,
      group: null,
      detail: { level: 'all_actions', rule: mainStage.rule.id },
      attention: [],
    })
    expect(after.attention).toEqual(before.attention)

    review.revoke(hidden.rule.id, 60)
    expect(placementOf(review.snapshot(), 'action', actionOf('rev-test'))?.visibility).toMatchObject({
      state: 'collapsed',
      rule: commands.rule.id,
      totals: { agents: 0, actions: 1, outcomes: { error: 1 }, usage: null, outputs: [] },
    })
  })

  test('revoking a rule restores the view once and keeps the revoked rule', async () => {
    const review = await reviewRun()
    const { store, run, scene } = review
    const initial = review.snapshot()
    const applied = review.add(collapseReviewers, 50, 'chat')
    const id = applied.rule.id
    const collapsed = expectFeedReproduces(scene.reads, run, initial)

    const revoked = review.revoke(id, 60)

    expect(revoked).toEqual({ ...applied.rule, revoked_at: at(60) })
    const restored = expectFeedReproduces(scene.reads, run, collapsed)
    expect(restored.view).toEqual(initial.view)
    expect(withoutView(restored)).toEqual(withoutView(initial))
    const position = store.changes.head()
    expect(review.revoke(id, 70)).toEqual(revoked)
    expect(store.changes.head()).toBe(position)
    expect(store.views.rules(run)).toEqual([revoked])
    expect(review.revoke(ViewRuleId.parse('999'), 70)).toBeNull()
    expect(review.revoke(ViewRuleId.parse('not-a-rule'), 70)).toBeNull()
    expect(
      store.transaction((transaction) =>
        revokeViewRule(transaction, { run: runId(sessionKey('claude', 'other')), id, at: at(70) }),
      ),
    ).toBeNull()
    expect(store.changes.head()).toBe(position)
  })

  test('a revocation before the creation time is recorded at the creation time', async () => {
    const review = await reviewRun()
    const applied = review.add(collapseReviewers, 50)

    expect(review.revoke(applied.rule.id, 10)).toMatchObject({ revoked_at: at(50) })
  })

  test('rules and their effect survive a restart', async () => {
    const review = await reviewRun()
    const { scene, run } = review
    const collapse = review.add(collapseReviewers, 50)
    review.add({ action: 'hide', selector: { kind: 'action_tool', tool: 'Read' }, params: null }, 51)
    review.revoke(collapse.rule.id, 52)
    const before = review.snapshot()

    scene.store.close()
    const reopened = scene.home.open()
    const reads = createReadQueries({
      store: reopened,
      observer: () => ({ state: { state: 'ok' }, isolation_unverified: false }),
    })

    expect(reads.snapshot(run)).toEqual(before)
    expect(reopened.views.rules(run)).toHaveLength(2)
  })

  test('an invalid rule is rejected with an explanation and changes nothing', async () => {
    const review = await reviewRun()
    const { store, run } = review
    const position = store.changes.head()
    const rejected = (rule: ViewRuleSpec) => {
      try {
        review.add(rule, 50)
      } catch (error) {
        return error instanceof ViewRuleError ? { code: error.code, message: error.message } : error
      }
      return null
    }

    const missing = StageId.parse('missing')
    expect(rejected({ action: 'hide', selector: { kind: 'stage_ids', stages: [missing] }, params: null })).toEqual({
      code: 'invalid_selector',
      message: 'the run has no stages missing',
    })
    expect(rejected({ action: 'hide', selector: { kind: 'stage_ids', stages: [] }, params: null })).toEqual({
      code: 'invalid_selector',
      message: 'the selector names no stages',
    })
    expect(rejected({ action: 'collapse', selector: { kind: 'agent_type', agent_type: '  ' }, params: null })).toEqual({
      code: 'invalid_selector',
      message: 'the agent type of the selector must not be empty',
    })
    for (const selector of [
      { kind: 'agent_name', name: '' },
      { kind: 'agent_role', role: '' },
      { kind: 'stage_title', contains: '' },
      { kind: 'action_tool', tool: '' },
    ] as const) {
      expect(rejected({ action: 'hide', selector, params: null })).toMatchObject({ code: 'invalid_selector' })
    }
    expect(
      rejected({ action: 'group', selector: { kind: 'service_agents' }, params: { name: ' ' } }),
    ).toEqual({ code: 'invalid_params', message: 'the group name must not be empty' })
    expect(
      rejected({ action: 'hide', selector: { kind: 'service_agents' }, params: { name: 'x' } } as unknown as ViewRuleSpec),
    ).toMatchObject({ code: 'invalid_rule' })
    expect(store.changes.head()).toBe(position)
    expect(store.views.rules(run)).toEqual([])
    expect(
      store.transaction((transaction) =>
        addViewRule(transaction, {
          run: runId(sessionKey('claude', 'other')),
          rule: collapseReviewers,
          source: 'ui',
          at: at(50),
        }),
      ),
    ).toBeNull()
    expect(store.changes.head()).toBe(position)
  })
})

const codexRoot = 'codex-root'
const codexRun = runId(sessionKey('codex', codexRoot))
const guardianAgent = objectId({
  kind: 'agent',
  runtime: 'codex',
  session: codexRoot,
  agent: { kind: 'thread', thread_id: 'guardian-thread' },
})

const openCodexRun = async () => {
  const scene = await openScene(onTestFinished)
  const sessions = join(scene.home.path, 'codex-sessions')
  const file = (name: string, lines: readonly string[], ino: bigint) =>
    jsonlFile({ runtime: 'codex', path: join(sessions, `${name}.jsonl`), lines, ino }).batch(1, lines.length)
  await scene.ingest(file('root', codexRollout({ thread: codexRoot, cwd: scene.project }), 1n))
  await scene.ingest(
    file('guardian', codexGuardianRollout({ root: codexRoot, thread: 'guardian-thread', cwd: scene.project }), 2n),
  )
  const add = (rule: ViewRuleSpec, second: number): AppliedViewRule => {
    const applied = scene.store.transaction((transaction) =>
      addViewRule(transaction, { run: codexRun, rule, source: 'ui', at: at(second) }),
    )
    if (applied === null) {
      throw new Error('the Codex run must accept view rules')
    }
    return applied
  }
  const snapshot = (): RunSnapshot => {
    const value = scene.reads.snapshot(codexRun)
    if (value === null) {
      throw new Error('the Codex run must exist')
    }
    return value
  }
  return { scene, add, snapshot }
}

const noOutcomes = { ok: 0, error: 0, denied: 0, interrupted: 0, unknown: 0 }

describe('the default view rule', () => {
  test('collapses service agents until a later rule overrides it, and returns once that rule is revoked', async () => {
    const { scene, add, snapshot } = await openCodexRun()
    const collapsedByDefault = {
      element: { kind: 'agent', id: guardianAgent },
      visibility: {
        state: 'collapsed',
        rule: null,
        totals: {
          agents: 1,
          actions: 0,
          running_actions: 0,
          outcomes: noOutcomes,
          usage: { tokens: expect.any(Object) as unknown, records: 0, output_lower_bound: false, cost_usd: null },
          outputs: [],
        },
      },
      group: null,
      detail: null,
      attention: [],
    }
    const initial = snapshot()

    expect(initial.view.rules).toEqual([])
    expect(initial.view.placements).toEqual([collapsedByDefault])
    const hide = add({ action: 'hide', selector: { kind: 'service_agents' }, params: null }, 10)
    expect(hide.affected).toEqual([{ kind: 'agent', id: guardianAgent }])
    const hidden = expectFeedReproduces(scene.reads, codexRun, initial)
    expect(hidden.view.placements).toEqual([{ ...collapsedByDefault, visibility: { state: 'hidden', rule: hide.rule.id } }])
    scene.store.transaction((transaction) => revokeViewRule(transaction, { run: codexRun, id: hide.rule.id, at: at(20) }))
    expect(expectFeedReproduces(scene.reads, codexRun, hidden).view.placements).toEqual([collapsedByDefault])
  })
})

describe('code cells', () => {
  test('a collapsed code cell sums the commands it ran, and its detail level hides them', async () => {
    const { scene, add, snapshot } = await openCodexRun()
    await scene.hooks({
      runtime: 'codex',
      file: 'command.evt',
      payload: codexHook('PreToolUse.Bash.codemode-nested.json', scene.source(codexRoot), {
        tool_use_id: 'exec-a8b47079-66cf-4c58-ba7c-268717fda6fb',
      }),
    })
    const ingested = snapshot().objects.actions
    const cell = ingested.find(({ is_container }) => is_container)
    const command = ingested.find(({ is_container }) => !is_container)
    if (cell === undefined || command === undefined) {
      throw new Error('the code cell must run a command')
    }
    scene.store.transaction((transaction) => {
      transaction.observations.save({ ...command, container: cell.id })
    })
    const before = snapshot()

    const collapse = add(
      { action: 'collapse', selector: { kind: 'action_kind', action_kind: 'code_cell' }, params: null },
      10,
    )
    const detail = add(
      { action: 'detail', selector: { kind: 'action_kind', action_kind: 'code_cell' }, params: { level: 'stages' } },
      11,
    )

    expect(collapse.affected).toEqual([{ kind: 'action', id: cell.id }])
    const after = expectFeedReproduces(scene.reads, codexRun, before)
    expect(placementOf(after, 'action', cell.id)).toEqual({
      element: { kind: 'action', id: cell.id },
      visibility: {
        state: 'collapsed',
        rule: collapse.rule.id,
        totals: {
          agents: 0,
          actions: 2,
          running_actions: 0,
          outcomes: { ...noOutcomes, ok: 1, unknown: 1 },
          usage: null,
          outputs: [],
        },
      },
      group: null,
      detail: { level: 'stages', rule: detail.rule.id },
      attention: [],
    })
  })
})
