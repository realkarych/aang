import type { Execution } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import { applyChangeSet, applyObserverResponse, refreshStageExecution } from '@aang/engine'
import { expect, test } from 'vitest'
import { hookBatch } from './batches.js'
import { factsOf, startEngine } from './harness.js'
import { at, drafts, observed, put, runA, runB, stages } from './model.js'
import { callId, existing, response, setupObserver } from './observer-fixtures.js'
import { claudeHook } from './samples.js'
import { observationsFor, recordObjectOwners } from './stage-observations.js'

test.for(['empty', 'stale'] as const)(
  'moving an action with an open permission restores its old stage claim with the %s snapshot',
  async (snapshot, { onTestFinished }) => {
    const { store, home, facts, solver, begin, stage } = await setupObserver(onTestFinished)
    const { action } = observationsFor(facts)
    recordObjectOwners(store, [action])
    await startEngine(store, { all: true }).ingest(hookBatch({
      file: 'moving-permission.evt',
      payload: claudeHook('PermissionRequest.Bash.json', { session: 'session-a', cwd: home.path }),
    }))
    const permission = factsOf(store).find((fact) => fact.kind === 'permission_request')
    if (permission === undefined) { throw new Error('missing permission request') }
    store.transaction((transaction) => applyChangeSet(transaction, {
      run: runA, author: 'rule', at: at(10),
      changes: [put('attention.open', {
        kind: 'attention_item',
        value: { ...drafts.permission, action: action.id, evidence: [permission.id] },
      }, observed, [permission.id])],
    }))
    const input = begin([solver])
    const grounds = { evidence: [solver.id], rationale: 'Completed action awaiting permission' }
    const waiting = { ...action, execution: { state: 'waiting', reason: 'human' } as const }
    expect(store.transaction((transaction) => applyObserverResponse(transaction, {
      call: callId, at: at(20), observations: { actions: [waiting], agents: [] },
      output: response([
        { ...grounds, op: 'actions.assign', stage: existing(stages.build), actions: [action.id] },
        { ...grounds, op: 'stage.state', stage: existing(stages.build), execution: { state: 'done' } },
      ], input.model.version),
    })).status).toBe('accepted')
    expect(stage()).toMatchObject({ value: {
      execution: { value: { state: 'waiting', reason: 'human' } },
      execution_claim: { value: { state: 'done' } }, decision: { value: 'requested' },
    } })
    const links = store.model.entities(runA).filter((entity) => entity.kind === 'link')
    recordObjectOwners(store, [{ ...action, run: runB }])
    const observations = { actions: snapshot === 'empty' ? [] : [waiting], agents: [] }
    store.transaction((transaction) => refreshStageExecution(transaction, {
      run: runA, at: at(30), observations,
    }))
    expect(stage()).toMatchObject({ value: {
      execution: { value: { state: 'done' }, evidence: [solver.id] },
      execution_claim: null, decision: { value: 'unknown' },
    } })
    expect(store.model.entities(runA).filter((entity) => entity.kind === 'link')).toEqual(links)
    expect(store.transaction((transaction) => refreshStageExecution(transaction, {
      run: runA, at: at(40), observations,
    }))).toBeNull()
    const entities = store.model.entities(runA)
    store.transaction((transaction) => { transaction.model.replay() })
    expect(store.model.entities(runA)).toEqual(entities)
  },
)

test.for(['running', 'waiting'] as const)(
  'reordering current actions and agents preserves a %s stage and its journal',
  async (state, { onTestFinished }) => {
    const { store, home, facts, solver, begin, stage } = await setupObserver(onTestFinished)
    const { agent } = observationsFor(facts)
    const engine = startEngine(store, { all: true })
    const beforeFacts = new Set(factsOf(store).map((fact) => fact.id))
    for (const index of [1, 2]) {
      await engine.ingest(hookBatch({
        file: `ordered-agent-${String(index)}.evt`,
        payload: claudeHook('SubagentStart.json', { session: 'session-a', cwd: home.path }, {
          agent_id: `ordered-agent-${String(index)}`,
        }),
      }, {
        file: `ordered-action-${String(index)}.evt`,
        payload: claudeHook('PreToolUse.Bash.json', { session: 'session-a', cwd: home.path }, {
          tool_use_id: `ordered-action-${String(index)}`,
        }),
      }))
    }
    const starts = factsOf(store).filter((fact) => !beforeFacts.has(fact.id))
    const execution: Execution = state === 'running' ? { state } : { state, reason: 'background' }
    const actions = starts.filter((fact) => fact.kind === 'action_start').map((fact) => ({
      ...observationsFor([fact]).action, agent: null, execution,
    }))
    const agents = starts.flatMap((fact) => fact.kind === 'agent_start' && fact.entity_key.kind === 'agent' ? [{
      ...agent, id: objectId(fact.entity_key), key: fact.entity_key, role: 'subagent' as const,
      started_at: fact.at, ended_at: null, execution, execution_evidence: [fact.id, fact.id],
    }] : [])
    expect(actions).toHaveLength(2)
    expect(agents).toHaveLength(2)
    recordObjectOwners(store, [...actions, ...agents])
    begin([solver])
    const grounds = { evidence: [solver.id], rationale: 'Assign parallel work' }
    expect(store.transaction((transaction) => applyObserverResponse(transaction, {
      call: callId, at: at(20), observations: { actions, agents },
      output: response([
        { ...grounds, op: 'actions.assign', stage: existing(stages.build), actions: actions.map((action) => action.id) },
        { ...grounds, op: 'agents.participate', stage: existing(stages.build), agents: agents.map((agent) => agent.id) },
      ], 2),
    })).status).toBe('accepted')
    expect(stage()).toMatchObject({ value: { execution: { value: execution } } })
    const before = stage()
    const head = store.model.head(runA)
    for (const observations of [
      { actions: actions.toReversed(), agents },
      { actions, agents: agents.toReversed() },
      { actions: actions.toReversed(), agents: agents.toReversed() },
    ]) {
      expect(store.transaction((transaction) => refreshStageExecution(transaction, {
        run: runA, at: at(30), observations,
      }))).toBeNull()
      expect(stage()).toEqual(before)
      expect(store.model.head(runA)).toBe(head)
      expect(store.model.changes(runA, head)).toEqual([])
    }
  },
)

test.for(['running', 'waiting'] as const)(
  'irrelevant session facts do not grow stage history or evidence for a %s agent',
  async (state, { onTestFinished }) => {
    const { store, home, facts, solver, begin, stage } = await setupObserver(onTestFinished)
    const { agent, start } = observationsFor(facts)
    recordObjectOwners(store, [agent])
    const engine = startEngine(store, { all: true })
    await engine.ingest(hookBatch({
      file: 'agent-permission.evt',
      payload: claudeHook('PermissionRequest.Bash.json', { session: 'session-a', cwd: home.path }),
    }))
    const permission = factsOf(store).find((fact) => fact.kind === 'permission_request')
    if (permission === undefined) { throw new Error('missing permission request') }
    const execution = state === 'running'
      ? { state: 'running' } as const
      : { state: 'waiting', reason: 'human' } as const
    const evidence = state === 'running' ? start : permission
    const observations = {
      actions: [], agents: [{ ...agent, execution, execution_evidence: [evidence.id] }],
    }
    const input = begin([solver])
    expect(store.transaction((transaction) => applyObserverResponse(transaction, {
      call: callId, at: at(20), observations,
      output: response([{
        op: 'agents.participate', stage: existing(stages.build), agents: [agent.id],
        evidence: [solver.id], rationale: 'The agent is executing this stage',
      }], input.model.version),
    })).status).toBe('accepted')
    expect(stage()).toMatchObject({ value: { execution: { value: execution } } })
    const before = stage()
    const head = store.model.head(runA)
    const refreshes = []
    for (let index = 0; index < 100; index += 1) {
      await engine.ingest(hookBatch({
        file: `instructions-${String(index)}.evt`, arrival: index,
        payload: claudeHook('InstructionsLoaded.session_start.json', { session: 'session-a', cwd: home.path }, {
          file_path: `${home.path}/instructions-${String(index)}.md`,
        }),
      }))
      refreshes.push(store.transaction((transaction) => refreshStageExecution(transaction, {
        run: runA, at: at(30 + index), observations,
      })))
    }
    expect(factsOf(store).filter((fact) => fact.kind === 'instructions_loaded')).toHaveLength(100)
    expect(store.model.head(runA)).toBe(head)
    expect(refreshes).toEqual(Array.from({ length: 100 }, () => null))
    expect(store.model.changes(runA, head)).toEqual([])
    expect(stage()).toEqual(before)
    expect(stage()).toMatchObject({ value: { execution: { evidence: [evidence.id] } } })
    const next = state === 'running'
      ? { execution: { state: 'waiting', reason: 'human' } as const, evidence: permission }
      : { execution: { state: 'running' } as const, evidence: start }
    expect(store.transaction((transaction) => refreshStageExecution(transaction, {
      run: runA, at: at(140),
      observations: { actions: [], agents: [{ ...agent, execution: next.execution, execution_evidence: [next.evidence.id] }] },
    }))?.version.version).toBe(head + 1)
    expect(stage()).toMatchObject({ value: {
      execution: { value: next.execution, evidence: [next.evidence.id] },
    } })
    const entities = store.model.entities(runA)
    store.transaction((transaction) => { transaction.model.replay() })
    expect(store.model.entities(runA)).toEqual(entities)
    store.close()
    expect(home.open().model.entities(runA)).toEqual(entities)
  },
)
