import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentId,
  type ChatInput,
  CheckContract,
  type JsonValue,
  ModelVersion,
  type RunDescription,
  type RunId,
  type Stage,
  type StageId,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { createEngine, createReadQueries, startChat, verifyCitations } from '@aang/engine'
import type { Store } from '@aang/store'
import {
  agentStageTitle,
  branchStageTitles,
  continuationQuestionText,
  continuedStageTitle,
  goalCriterionText,
  mainStageTitle,
  mergedStageTitle,
  nestedStageTitles,
  observerScenarios,
  preparationStageTitle,
  reportQuestionText,
  reportStageTitle,
  splitStageTitles,
} from '@aang/testkit'
import { describe, expect, onTestFinished, test } from 'vitest'
import { codexHooks, millisecond, otelDecision } from './attention-fixtures.js'
import { hookBatch, jsonlFile, snapshotBatch } from './batches.js'
import { adapters, factsOf, sessionKey, startEngine } from './harness.js'
import { createHome } from './home.js'
import { at } from './model.js'
import {
  answerChat,
  type ObservedCall,
  observeBatch,
  observeQueued,
  pendingFacts,
  runDescription,
  valuesOf,
} from './observer-scenario.js'
import { playSample } from './scenarios.js'
import {
  claudeAgentMeta,
  claudeHook,
  claudeSubagentTranscript,
  claudeTranscript,
  codexChildRollout,
  codexRollout,
  codexSpawnLines,
} from './samples.js'

const original = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const sampleThread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'
const sampleSubagent = 'aad616394e806288d'

const ms = (value: number): number => value * millisecond

const accepted = (...calls: readonly ObservedCall[]): void => {
  expect(calls.map(({ result }) => result)).toEqual(
    calls.map(() => ({ status: 'accepted', version: expect.any(Number) as unknown })),
  )
}

const stageTitled = (store: Store, run: RunId, title: string): Stage => {
  const stage = valuesOf(store, run, 'stage').find((value) => value.title === title)
  if (stage === undefined) {
    throw new Error(`run ${run} has no stage ${title}`)
  }
  return stage
}

const linksOf = (store: Store, run: RunId) => valuesOf(store, run, 'link')

const assignedTo = (store: Store, run: RunId, stage: Stage): string[] =>
  linksOf(store, run)
    .flatMap((link) => (link.kind === 'assignment' && link.stage === stage.id ? [link.action] : []))
    .sort()

const participantsOf = (store: Store, run: RunId, stage: Stage): string[] =>
  linksOf(store, run).flatMap((link) => (link.kind === 'participation' && link.stage === stage.id ? [link.agent] : []))

const stagesUnder = (store: Store, run: RunId, parent: Stage): Stage[] =>
  valuesOf(store, run, 'stage').filter((stage) => stage.parent === parent.id)

const participations = (store: Store, run: RunId): string[][] =>
  linksOf(store, run).flatMap((link) => (link.kind === 'participation' ? [[link.stage, link.agent]] : []))

const agentWhere = (store: Store, run: RunId, matches: (agent: RunDescription['agents'][number]) => boolean) => {
  const agent = runDescription(store, run).agents.find(matches)
  if (agent === undefined) {
    throw new Error(`run ${run} has no such agent`)
  }
  return agent
}

const agentTyped = (store: Store, run: RunId, type: string) =>
  agentWhere(store, run, ({ agent_type }) => agent_type === type)

const observerChanges = (store: Store, run: RunId) =>
  store.model.changes(run, ModelVersion.parse(0)).filter(({ author }) => author === 'observer')

const observerEvidence = (store: Store, run: RunId) => observerChanges(store, run).flatMap(({ evidence }) => evidence)

const expectGroundedInRecords = (store: Store, run: RunId): void => {
  const evidence = observerEvidence(store, run)
  expect(evidence.length).toBeGreaterThan(0)
  expect(observerChanges(store, run).filter(({ basis }) => basis?.kind === 'observed')).toEqual([])
  for (const id of evidence) {
    const fact = store.facts.get(id)
    expect(fact).not.toBeNull()
    expect(fact === null ? null : store.rawRecords.get(fact.seq)?.seq).toBe(fact?.seq)
  }
}

const claudeAction = (session: string, call: string) => objectId({ kind: 'action', runtime: 'claude', session, call })

const codexAction = (session: string, call: string) => objectId({ kind: 'action', runtime: 'codex', session, call })

const attentionOf = (store: Store, run: RunId) => valuesOf(store, run, 'attention_item')

const readsOf = (store: Store) =>
  createReadQueries({ store, observer: () => ({ state: { state: 'ok' }, isolation_unverified: false }) })

describe('observer scenarios pass the operation checks of M.2 and M.3 on the records of their E2E (T.6)', () => {
  test('E2E 1: the live map nests the subagent stage under the main work and grounds every operation in raw records', async () => {
    const sample = await playSample('claude-subagent')
    const { store } = sample
    const run = runId(sessionKey('claude', original))
    const [reply] = observerScenarios['live-map'].live.replies

    await sample.play({ until: 'subagent' })
    const first = observeBatch(store, run, 'claude', reply, at(10))
    await sample.play()
    const second = observeBatch(store, run, 'claude', reply, at(20))

    accepted(first, second)
    const main = stageTitled(store, run, mainStageTitle)
    const pinger = agentTyped(store, run, 'pinger')
    const delegated = stageTitled(store, run, agentStageTitle(pinger))
    expect([main.parent, delegated.parent]).toEqual([null, main.id])
    expect(participantsOf(store, run, delegated)).toEqual([pinger.id])
    expect(assignedTo(store, run, main)).toEqual(
      [claudeAction(original, 'toolu_017B7FeHZ4yDzFdvKQMwDJB8'), claudeAction(original, 'toolu_01D254DDPoZEYPvJBjampKox')].sort(),
    )
    expect(valuesOf(store, run, 'criterion')).toMatchObject([
      { stage: main.id, text: goalCriterionText, status: { value: 'not_checked' } },
    ])
    expect(runDescription(store, run).brief).toMatch(/^Working towards: Step 1: run `echo hi`/)
    expect(pendingFacts(store, run)).toEqual([])
    expectGroundedInRecords(store, run)
  })

  test('E2E 1: the map layout holds a done preparation and a claimed report that depends on the subagent stage', async () => {
    const sample = await playSample('claude-subagent')
    const { store } = sample
    const run = runId(sessionKey('claude', original))
    const [reply] = observerScenarios['map-layout'].live.replies

    await sample.play({ until: 'subagent' })
    const first = observeBatch(store, run, 'claude', reply, at(10))
    await sample.play()
    const second = observeBatch(store, run, 'claude', reply, at(20))

    accepted(first, second)
    const main = stageTitled(store, run, mainStageTitle)
    const preparation = stageTitled(store, run, preparationStageTitle)
    const report = stageTitled(store, run, reportStageTitle)
    const pinger = agentStageTitle(agentTyped(store, run, 'pinger'))
    const delegated = stageTitled(store, run, pinger)
    expect(main.parent).toBeNull()
    expect(stagesUnder(store, run, main).map(({ title }) => title).sort()).toEqual(
      [preparationStageTitle, reportStageTitle, pinger].sort(),
    )
    const bash = claudeAction(original, 'toolu_017B7FeHZ4yDzFdvKQMwDJB8')
    expect(
      linksOf(store, run).flatMap((link) => (link.kind === 'assignment' && link.action === bash ? [link.stage] : [])),
    ).toEqual([preparation.id])
    expect(assignedTo(store, run, main)).toEqual([claudeAction(original, 'toolu_01D254DDPoZEYPvJBjampKox')])
    expect(preparation.execution).toMatchObject({ value: { state: 'done' }, basis: { kind: 'interpreted' } })
    expect(report.execution).toMatchObject({ value: { state: 'done' }, basis: { kind: 'claimed' } })
    expect(linksOf(store, run).filter(({ kind }) => kind === 'dependency')).toMatchObject([
      { stage: report.id, depends_on: delegated.id, via: null },
    ])
    expect(
      attentionOf(store, run).filter(({ author, kind }) => author === 'observer' && kind === 'question'),
    ).toMatchObject([{ text: reportQuestionText, stage: report.id, resolution: 'open' }])
    expectGroundedInRecords(store, run)
  })

  test('E2E 1: the map branches put a dependency across two branches and one of a parent on its substage', async () => {
    const sample = await playSample('claude-subagent')
    const { store } = sample
    const run = runId(sessionKey('claude', original))
    const [reply] = observerScenarios['map-branches'].live.replies

    await sample.play({ until: 'subagent' })
    const first = observeBatch(store, run, 'claude', reply, at(10))
    await sample.play()
    const second = observeBatch(store, run, 'claude', reply, at(20))

    accepted(first, second)
    const [build, compile, verify, check] = [
      branchStageTitles.build,
      branchStageTitles.compile,
      branchStageTitles.verify,
      branchStageTitles.test,
    ].map((title) => stageTitled(store, run, title))
    expect(valuesOf(store, run, 'stage')).toHaveLength(4)
    expect([build?.parent, compile?.parent, verify?.parent, check?.parent]).toEqual([null, build?.id, null, verify?.id])
    const dependencies = linksOf(store, run).flatMap((link) =>
      link.kind === 'dependency' ? [[link.stage, link.depends_on]] : [],
    )
    expect(dependencies).toHaveLength(2)
    expect(dependencies).toEqual(
      expect.arrayContaining([
        [check?.id, compile?.id],
        [verify?.id, check?.id],
      ]),
    )
    expectGroundedInRecords(store, run)
  })

  test('E2E 1: the nested map puts a stage over its substage over another and both lower ones on the top one', async () => {
    const sample = await playSample('claude-subagent')
    const { store } = sample
    const run = runId(sessionKey('claude', original))
    const [reply] = observerScenarios['map-nested'].live.replies

    await sample.play({ until: 'subagent' })
    const first = observeBatch(store, run, 'claude', reply, at(10))
    await sample.play()
    const second = observeBatch(store, run, 'claude', reply, at(20))

    accepted(first, second)
    const [release, bundle, sign] = [nestedStageTitles.release, nestedStageTitles.bundle, nestedStageTitles.sign].map(
      (title) => stageTitled(store, run, title),
    )
    expect(valuesOf(store, run, 'stage')).toHaveLength(3)
    expect([release?.parent, bundle?.parent, sign?.parent]).toEqual([null, release?.id, bundle?.id])
    const dependencies = linksOf(store, run).flatMap((link) =>
      link.kind === 'dependency' ? [[link.stage, link.depends_on]] : [],
    )
    expect(dependencies).toHaveLength(2)
    expect(dependencies).toEqual(
      expect.arrayContaining([
        [bundle?.id, release?.id],
        [sign?.id, release?.id],
      ]),
    )
    expectGroundedInRecords(store, run)
  })

  test('E2E 1: the subagent stage and its participation stay single when the agent type arrives after a map', async () => {
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { all: true })
    const session = 'late-type-session'
    const source = { session, cwd: home.path }
    const projects = join(home.path, 'projects', '-work-project')
    const lead = claudeTranscript(source)
    const own = claudeSubagentTranscript(source)
    const spawn = lead.findIndex((line) => line.includes('"id":"toolu_01D254DDPoZEYPvJBjampKox"'))
    const leadFile = jsonlFile({ runtime: 'claude', path: join(projects, `${session}.jsonl`), lines: lead, ino: 1n })
    const ownPath = join(projects, session, 'subagents', `agent-${sampleSubagent}.jsonl`)
    const run = runId(sessionKey('claude', session))
    const [reply] = observerScenarios['live-map'].live.replies
    await engine.ingest(leadFile.batch(1, spawn))
    await engine.ingest(jsonlFile({ runtime: 'claude', path: ownPath, lines: own, ino: 2n }).batch(1, own.length))
    const early = observeBatch(store, run, 'claude', reply, at(10))
    const untyped = agentWhere(store, run, ({ role }) => role === 'subagent')
    await engine.ingest(
      snapshotBatch({
        path: join(projects, session, 'subagents', `agent-${sampleSubagent}.meta.json`),
        content: JSON.parse(claudeAgentMeta()) as JsonValue,
      }),
    )
    await engine.ingest(leadFile.batch(spawn + 1, lead.length))
    const late = observeBatch(store, run, 'claude', reply, at(20))

    accepted(early, late)
    const pinger = agentTyped(store, run, 'pinger')
    expect([spawn > 0, untyped.id, untyped.agent_type]).toEqual([true, pinger.id, null])
    const delegated = stageTitled(store, run, agentStageTitle(pinger))
    expect(stagesUnder(store, run, stageTitled(store, run, mainStageTitle))).toEqual([delegated])
    expect(participations(store, run)).toEqual([[delegated.id, pinger.id]])
    expectGroundedInRecords(store, run)
  })

  test('E2E 3: the solver claim of done over a failed check is a claimed state and the rule item stays open', async () => {
    const home = await createHome(onTestFinished)
    const project = join(home.path, '..', 'project')
    await mkdir(project, { recursive: true })
    const store = home.open()
    const contract = CheckContract.parse({ name: 'test', command: '^pnpm test' })
    const engine = createEngine({ store, adapters, watch: { all: true, roots: [{ path: project, contracts: [contract] }] } })
    const session = 'claimed-done-session'
    const line = (uuid: string, type: 'assistant' | 'user', message: JsonValue): string =>
      JSON.stringify({ type, sessionId: session, uuid, timestamp: '2026-10-01T12:00:00.000Z', cwd: project, message })
    const lines = [
      ...claudeTranscript({ session, cwd: project }),
      line('check-call', 'assistant', {
        id: 'message-check-call',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_check', name: 'Bash', input: { command: 'pnpm test' } }],
      }),
      line('check-result', 'user', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_check', content: 'Exit code 1\nfailed', is_error: true }],
      }),
      line('done', 'assistant', {
        id: 'message-done',
        role: 'assistant',
        content: [{ type: 'text', text: 'All done: the tests pass.' }],
        stop_reason: 'end_turn',
      }),
    ]
    await engine.ingest(
      jsonlFile({ runtime: 'claude', path: `${project}/${session}.jsonl`, lines, ino: 7n }).batch(1, lines.length),
    )
    const run = runId(sessionKey('claude', session))
    const failedCheck = () => attentionOf(store, run).filter(({ kind }) => kind === 'failed_check')
    expect(failedCheck()).toMatchObject([{ author: 'rule', resolution: 'open' }])

    const call = observeBatch(store, run, 'claude', observerScenarios['claimed-done'].live.replies[0], at(10))

    accepted(call)
    const done = factsOf(store).find(
      ({ kind, payload }) => kind === 'message' && 'text' in payload && payload.text === 'All done: the tests pass.',
    )
    expect(done).toMatchObject({ speaker: 'solver', payload: { final: true, audience: 'user' } })
    expect(stageTitled(store, run, mainStageTitle).execution).toEqual({
      value: { state: 'done' },
      basis: { kind: 'claimed' },
      evidence: [done?.id],
    })
    const criteria = valuesOf(store, run, 'criterion')
    expect(criteria.filter(({ source }) => source !== 'contract')).toMatchObject([
      { text: goalCriterionText, status: { value: 'reported_done', basis: { kind: 'claimed' }, evidence: [done?.id] } },
    ])
    expect(criteria.filter(({ source }) => source === 'contract')).toMatchObject([
      { contract: 'test', status: { value: 'failed', basis: { kind: 'observed' } } },
    ])
    expect(failedCheck()).toMatchObject([{ author: 'rule', resolution: 'open', closed_at: null }])
    expect(assignedTo(store, run, stageTitled(store, run, mainStageTitle))).toContain(claudeAction(session, 'toolu_check'))
  })

  test('E2E 4: the continued run replaces the earlier stage once, asks one question and cites each final text', async () => {
    const sample = await playSample('claude-fork')
    const { store } = sample
    const run = runId(sessionKey('claude', original))
    const phases = observerScenarios['since-last-view']

    await sample.play({ until: 'resume' })
    const before = observeBatch(store, run, 'claude', phases.before.replies[0], at(10))
    const replaced = stageTitled(store, run, mainStageTitle)
    await sample.play({ until: 'continue' })
    const resumed = observeBatch(store, run, 'claude', phases.after.replies[0], at(20))
    await sample.play({ until: 'fork' })
    const continued = observeBatch(store, run, 'claude', phases.after.replies[0], at(30))

    accepted(before, resumed, continued)
    const successor = stageTitled(store, run, continuedStageTitle)
    expect(stageTitled(store, run, mainStageTitle).lifecycle).toEqual({ state: 'replaced', by: [successor.id] })
    expect(replaced.lifecycle).toEqual({ state: 'active' })
    expect(
      attentionOf(store, run).filter(({ author, kind }) => author === 'observer' && kind === 'question'),
    ).toMatchObject([{ text: continuationQuestionText, stage: successor.id, resolution: 'open' }])
    const cards = valuesOf(store, run, 'card').sort((left, right) => left.text.localeCompare(right.text))
    expect(cards.map(({ text, stages }) => [text, stages])).toEqual([
      ['OK2', [successor.id]],
      ['OK3', [successor.id]],
    ])
    for (const card of cards) {
      const fact = store.facts.get(card.source.fact)
      expect(fact).toMatchObject({ kind: 'message', payload: { text: card.text, final: true } })
      expect(card.source).toMatchObject({ start: 0, end: card.text.length })
      expect(fact === null ? null : store.rawRecords.get(fact.seq)).not.toBeNull()
    }
    expectGroundedInRecords(store, run)
  })

  test('E2E 14: new versions keep the main work stage, the continued run replaces it, its successor splits in two, then the two parts merge', async () => {
    const sample = await playSample('claude-compaction')
    const { store } = sample
    const run = runId(sessionKey('claude', original))
    const phases = observerScenarios['stage-succession']
    const versionOf = ({ result }: ObservedCall): number => (result.status === 'accepted' ? result.version : -1)

    await sample.play({ until: 'subagent' })
    const first = observeBatch(store, run, 'claude', phases.live.replies[0], at(10))
    const selected = stageTitled(store, run, mainStageTitle)
    expect(stagesUnder(store, run, selected)).toEqual([])
    await sample.play({ until: 'subagent-result' })
    const second = observeBatch(store, run, 'claude', phases.live.replies[0], at(20))
    expect(stagesUnder(store, run, selected).map(({ title }) => title)).toEqual([
      expect.stringMatching(/^pinger \(.+\)$/),
    ])
    await sample.play({ until: 'resume' })
    const third = observeBatch(store, run, 'claude', phases.live.replies[0], at(30))
    expect(stageTitled(store, run, mainStageTitle)).toMatchObject({ id: selected.id, lifecycle: { state: 'active' } })
    await sample.play({ until: 'continue' })
    const fourth = observeBatch(store, run, 'claude', phases.revised.replies[0], at(40))
    const successor = stageTitled(store, run, continuedStageTitle)
    expect(stageTitled(store, run, mainStageTitle).lifecycle).toEqual({ state: 'replaced', by: [successor.id] })
    await sample.play({ until: 'compaction' })
    const fifth = observeBatch(store, run, 'claude', phases.split.replies[0], at(50))
    const parts = splitStageTitles.map((title) => stageTitled(store, run, title))
    expect(stageTitled(store, run, continuedStageTitle).lifecycle).toEqual({
      state: 'split',
      into: parts.map(({ id }) => id),
    })
    expect(parts.map(({ lifecycle, parent }) => [lifecycle.state, parent])).toEqual([
      ['active', null],
      ['active', null],
    ])
    await sample.play({ until: 'compact-boundary' })
    const sixth = observeBatch(store, run, 'claude', phases.merged.replies[0], at(60))

    accepted(first, second, third, fourth, fifth, sixth)
    expect(versionOf(second)).toBeGreaterThan(versionOf(first))
    expect(versionOf(third)).toBeGreaterThan(versionOf(second))
    const merged = stageTitled(store, run, mergedStageTitle)
    expect(merged).toMatchObject({ lifecycle: { state: 'active' }, parent: null })
    for (const title of splitStageTitles) {
      expect(stageTitled(store, run, title).lifecycle).toEqual({ state: 'merged', into: merged.id })
    }
    expect(valuesOf(store, run, 'stage').map(({ title }) => title).sort()).toEqual(
      [
        mainStageTitle,
        continuedStageTitle,
        ...splitStageTitles,
        mergedStageTitle,
        stagesUnder(store, run, selected)[0]?.title,
      ].sort(),
    )
    expectGroundedInRecords(store, run)
  })

  test('E2E 4 on Codex: the resumed thread replaces the stage and cites the final text of the resumed turn', async () => {
    const sample = await playSample('codex-resume-compaction')
    const { store } = sample
    const run = runId(sessionKey('codex', sampleThread))
    const phases = observerScenarios['since-last-view']

    await sample.play({ until: 'resume' })
    const before = observeBatch(store, run, 'codex', phases.before.replies[0], at(10))
    await sample.play()
    const after = observeBatch(store, run, 'codex', phases.after.replies[0], at(20))

    accepted(before, after)
    const successor = stageTitled(store, run, continuedStageTitle)
    expect(stageTitled(store, run, mainStageTitle).lifecycle).toEqual({ state: 'replaced', by: [successor.id] })
    expect(valuesOf(store, run, 'card').map(({ text, source }) => [text, source.start, source.end])).toEqual([
      ['OK2', 0, 3],
    ])
    expectGroundedInRecords(store, run)
  })

  test('E2E 5: chat answers cite the map of their version and collapse the reviewer agents by type', async () => {
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { all: true })
    const session = 'chat-session'
    const source = { session, cwd: home.path }
    const projects = join(home.path, 'projects', '-work-project')
    const reviewer = (text: string): string => text.replaceAll('pinger', 'code-reviewer')
    const lines = claudeTranscript(source).map(reviewer)
    await engine.ingest(
      hookBatch({ file: '0-startup.evt', payload: claudeHook('SessionStart.startup.json', source) }),
    )
    await engine.ingest(
      jsonlFile({ runtime: 'claude', path: join(projects, `${session}.jsonl`), lines, ino: 3n }).batch(1, lines.length),
    )
    await engine.ingest(
      snapshotBatch({
        path: join(projects, session, 'subagents', `agent-${sampleSubagent}.meta.json`),
        content: JSON.parse(reviewer(claudeAgentMeta())) as JsonValue,
      }),
    )
    await engine.ingest(
      hookBatch({
        file: '1-permission.evt',
        arrival: ms(1),
        payload: claudeHook('PermissionRequest.Bash.json', source, { agent_id: sampleSubagent }),
      }),
    )
    const run = runId(sessionKey('claude', session))
    const chat = observerScenarios.chat.live

    accepted(observeBatch(store, run, 'claude', chat.replies[0], at(10)))
    const permission = attentionOf(store, run).find(({ kind }) => kind === 'permission')
    expect(permission).toMatchObject({ author: 'rule', resolution: 'open' })
    const ask = (question: string, stage: StageId | null = null): ChatInput => {
      const started = store.transaction((transaction) =>
        startChat(transaction, { run, stage, question, backend: 'claude', crossVendor: false, at: at(20) }),
      )
      if (started === null) {
        throw new Error('the chat must start in the run')
      }
      return started.input
    }
    const asked = ask('What is going on in the run?')
    const answer = answerChat(chat.chatReplies[0], asked)
    const collapse = answerChat(chat.chatReplies[1], ask('Сверни ревьюеров'))

    expect(answer).toMatchObject({ needs: [], insufficient_data: false, view_rule: null })
    expect(answer.answer).toContain(`By map version ${String(asked.model.version)}`)
    expect(verifyCitations(asked, answer.citations)).toEqual({ citations: answer.citations, unconfirmed: false })
    expect(answer.citations).toEqual(
      expect.arrayContaining([
        { kind: 'stage', id: stageTitled(store, run, mainStageTitle).id },
        { kind: 'question', id: permission?.id },
      ]),
    )
    expect(collapse).toMatchObject({
      insufficient_data: false,
      view_rule: { action: 'collapse', selector: { kind: 'agent_type', agent_type: 'code-reviewer' }, params: null },
    })
    const reviewing = stageTitled(store, run, agentStageTitle(agentTyped(store, run, 'code-reviewer')))
    expect(reviewing.parent).toBe(stageTitled(store, run, mainStageTitle).id)
    const focusedInput = ask('What does the reviewer wait for?', reviewing.id)
    const focused = answerChat(chat.chatReplies[0], focusedInput)
    const focus = focusedInput.focus.kind === 'stage' ? focusedInput.focus : null
    expect(focus?.facts.length).toBeGreaterThan(0)
    expect(focused.citations).toEqual([
      { kind: 'stage', id: reviewing.id },
      ...(focus?.facts ?? []).slice(0, 3).map(({ id }) => ({ kind: 'fact', id })),
      ...(focus?.actions ?? []).slice(0, 3).map(({ action }) => ({ kind: 'action', id: action })),
    ])
    expect(verifyCitations(focusedInput, focused.citations).unconfirmed).toBe(false)
  })

  test('E2E 7: after the failing phase the catch-up batch with collapsed facts and a backlog summary is accepted', async () => {
    const sample = await playSample('codex-resume-compaction')
    const { store } = sample
    const run = runId(sessionKey('codex', sampleThread))
    const phases = observerScenarios['llm-failure']

    await sample.play({ until: 'resume' })
    const healthy = observeBatch(store, run, 'codex', phases.healthy.replies[0], at(10))
    await sample.play()
    const pending = pendingFacts(store, run)
    const prompt = pending.findIndex(({ kind, speaker }) => kind === 'prompt' && speaker === 'human')
    const deferred = pending.slice(0, prompt)
    const tokens = (kind: string): boolean => kind === 'usage' || kind === 'usage_total'
    const collapsed = pending.slice(prompt).filter(({ kind }) => tokens(kind))
    const rest = pending.slice(prompt).filter(({ kind }) => !tokens(kind))
    const main = agentWhere(store, run, ({ role }) => role === 'main').id
    const window = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T00:01:00.000Z' }
    const recovered = observeBatch(store, run, 'codex', phases.recovered.replies[0], at(30), {
      facts: rest,
      collapsed: [{ tool: 'token_count', action_kind: 'other', agent: main, facts: collapsed.map(({ id }) => id), ...window }],
      backlog: { ...window, facts: deferred.length, agents: [{ agent: main, facts: deferred.length, tools: [] }] },
    })

    accepted(healthy, recovered)
    expect(phases.failing.replies.map(({ kind }) => kind)).toEqual(['limit'])
    expect([deferred.length, collapsed.length, rest.length].every((count) => count > 0)).toBe(true)
    expect(observerEvidence(store, run)).toEqual(expect.arrayContaining(collapsed.map(({ id }) => id)))
    expect(pendingFacts(store, run)).toEqual(deferred)
  })

  test('E2E 8: the Codex map holds the subagent and the approved action, and the fork gets a map of its own', async () => {
    const home = await createHome(onTestFinished)
    const store = home.open()
    const engine = startEngine(store, { all: true })
    const cwd = home.path
    const root = 'codex-root-thread'
    const child = 'codex-child-thread'
    const fork = 'codex-fork-thread'
    const file = (name: string, lines: readonly string[], ino: bigint) =>
      jsonlFile({ runtime: 'codex', path: join(home.path, 'sessions', `${name}.jsonl`), lines, ino }).batch(1, lines.length)
    const hooks = codexHooks(root)
    const rootRun = runId(sessionKey('codex', root))
    const forkRun = runId(sessionKey('codex', fork))
    const [reply] = observerScenarios['live-map'].live.replies
    await engine.ingest(
      file('root', [...codexRollout({ thread: root, cwd }), ...codexSpawnLines({ root, child, call: 'spawn-call', ordinal: 41 })], 1n),
    )
    const spawned = observeBatch(store, rootRun, 'codex', reply, at(10))
    await engine.ingest(file('child', codexChildRollout({ root, thread: child, cwd }), 2n))
    await engine.ingest(hookBatch(hooks.start(), hooks.pre('pre.evt', 'call', ms(1)), hooks.request('request.evt', ms(2))))
    await engine.ingest(otelDecision(root, 'call', 'User', 'approved', ms(3)))
    await engine.ingest(hookBatch(hooks.post('post.evt', 'call', ms(4))))
    await engine.ingest(file('fork', codexRollout({ thread: fork, cwd, sessionMeta: { forked_from_id: root } }), 3n))

    const rootCall = observeBatch(store, rootRun, 'codex', reply, at(20))
    const forkCall = observeBatch(store, forkRun, 'codex', reply, at(21))

    accepted(spawned, rootCall, forkCall)
    expect(forkRun).not.toBe(rootRun)
    const main = stageTitled(store, rootRun, mainStageTitle)
    const subagent = agentWhere(store, rootRun, ({ role }) => role === 'subagent')
    const childAgent: AgentId = objectId({
      kind: 'agent',
      runtime: 'codex',
      session: root,
      agent: { kind: 'thread', thread_id: child },
    })
    expect(subagent.id).toBe(childAgent)
    expect(subagent.name).not.toBeNull()
    const delegated = stageTitled(store, rootRun, agentStageTitle(subagent))
    expect(stagesUnder(store, rootRun, main)).toEqual([delegated])
    expect(participations(store, rootRun)).toEqual([[delegated.id, childAgent]])
    expect(assignedTo(store, rootRun, main)).toEqual(
      expect.arrayContaining([codexAction(root, 'call'), codexAction(root, 'spawn-call')]),
    )
    expect(attentionOf(store, rootRun).filter(({ kind }) => kind === 'permission')).toMatchObject([
      { author: 'rule', resolution: 'answered', action: codexAction(root, 'call') },
    ])
    expect(main.decision.value).toBe('approved')
    expect(valuesOf(store, forkRun, 'stage').map(({ title }) => title)).toEqual([mainStageTitle])
    expectGroundedInRecords(store, rootRun)
    expectGroundedInRecords(store, forkRun)
  })

  test('E2E 17: the report written through Bash becomes an output of the main work and stays readable after the file is gone', async () => {
    const home = await createHome(onTestFinished)
    const project = join(home.path, '..', 'project')
    await mkdir(join(project, 'reports'), { recursive: true })
    const report = join(project, 'reports', 'summary.md')
    const content = '# Summary\n\n14 tests passed\n'
    await writeFile(report, content)
    const store = home.open()
    const engine = startEngine(store, { all: true })
    const session = 'report-session'
    const line = (uuid: string, type: 'assistant' | 'user', message: JsonValue): string =>
      JSON.stringify({ type, sessionId: session, uuid, timestamp: '2026-10-01T12:00:00.000Z', cwd: project, message })
    const lines = [
      ...claudeTranscript({ session, cwd: project }),
      line('report-call', 'assistant', {
        id: 'message-report-call',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_report', name: 'Bash', input: { command: 'node scripts/report.js > reports/summary.md' } },
        ],
      }),
      line('report-result', 'user', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_report', content: 'done', is_error: false }],
      }),
    ]
    await engine.ingest(
      jsonlFile({ runtime: 'claude', path: `${project}/${session}.jsonl`, lines, ino: 7n }).batch(1, lines.length),
    )
    const run = runId(sessionKey('claude', session))
    const action = claudeAction(session, 'toolu_report')
    const version = store.artifacts.versions(run).find(({ ref }) => ref.kind === 'file' && ref.path === report)
    const start = factsOf(store).find(({ kind, entity_key: key }) => kind === 'action_start' && key.kind === 'action' && key.call === 'toolu_report')
    if (version === undefined || start === undefined) {
      throw new Error('the command must write the report')
    }
    const [reply] = observerScenarios.report.live.replies
    const queue = pendingFacts(store, run)

    const started = observeQueued(store, run, 'claude', reply, at(10), queue.findIndex(({ id }) => id === start.id) + 1)
    const ended = observeQueued(store, run, 'claude', reply, at(20))

    accepted(started, ended)
    const sent = { id: version.id, ref: version.ref, produced_by: action, retained: false }
    expect([started.input.batch.artifact_versions, ended.input.batch.artifact_versions]).toEqual([[sent], [sent]])
    const main = stageTitled(store, run, mainStageTitle)
    const outputs = linksOf(store, run).filter((link) => link.kind === 'artifact')
    expect(outputs).toMatchObject([{ stage: main.id, version: version.id, direction: 'output' }])
    expect(assignedTo(store, run, main)).toContain(action)
    expect(pendingFacts(store, run)).toEqual([])
    expectGroundedInRecords(store, run)

    expect(await engine.retainBases()).toMatchObject([{ id: version.id, retention: { kind: 'file_read' } }])
    await writeFile(report, '# Rewritten\n')
    await rm(report)
    store.close()
    const reopened = home.open()
    const [output, ...others] = readsOf(reopened).inspector(run, main.id)?.outputs ?? []
    expect(others).toEqual([])
    expect(output?.version).toMatchObject({ id: version.id, produced_by: action, retention: { kind: 'file_read' } })
    const retention = output?.version.retention
    const blob = retention?.kind === 'file_read' ? reopened.artifacts.blob(retention.blob) : null
    expect(blob === null ? null : Buffer.from(blob).toString('utf8')).toBe(content)
  })

  test('rejected answer: the observer nests the main work under itself, the inspector shows it, and the retried batch is mapped', async () => {
    const sample = await playSample('claude-subagent')
    const { store } = sample
    const run = runId(sessionKey('claude', original))
    const [map, rejected, retry] = observerScenarios['rejected-answer'].live.replies

    await sample.play({ until: 'subagent' })
    const first = observeBatch(store, run, 'claude', map, at(10))
    await sample.play()
    const queued = pendingFacts(store, run)
    const refused = observeBatch(store, run, 'claude', rejected, at(20))
    const main = stageTitled(store, run, mainStageTitle)

    expect(refused.result).toEqual({
      status: 'rejected',
      rejections: [{ op_index: 0, cause: 'invariant', message: 'cycle in stage nesting' }],
    })
    expect(refused.output.ops).toMatchObject([
      { op: 'stage.nest', stage: { kind: 'existing', id: main.id }, parent: { kind: 'existing', id: main.id } },
    ])
    expect(pendingFacts(store, run)).toEqual(queued)
    expect(readsOf(store).inspector(run, main.id)?.observer_calls.map(({ outcome, attempt }) => [outcome, attempt])).toEqual([
      ['accepted', 1],
      ['rejected', 1],
    ])

    const retried = observeBatch(store, run, 'claude', retry, at(30))

    accepted(first, retried)
    expect(stageTitled(store, run, mainStageTitle)).toMatchObject({ id: main.id, parent: null })
    expect(pendingFacts(store, run)).toEqual([])
    expect(readsOf(store).inspector(run, main.id)?.observer_calls.map(({ outcome, attempt }) => [outcome, attempt])).toEqual([
      ['accepted', 1],
      ['rejected', 1],
      ['accepted', 2],
    ])
    expectGroundedInRecords(store, run)
  })
})
