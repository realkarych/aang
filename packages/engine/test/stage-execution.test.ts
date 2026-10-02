import { ObserverCallId, type ObserverOp, TempId } from '@aang/contract'
import { applyChangeSet, applyObserverResponse, refreshStageExecution } from '@aang/engine'
import { expect, test } from 'vitest'
import { at, drafts, observed, put, runA, runB, stages } from './model.js'
import { callId, existing, response, setupObserver, version } from './observer-fixtures.js'
import { hookBatch } from './batches.js'
import { factsOf, startEngine } from './harness.js'
import { claudeHook } from './samples.js'
import { observationsFor, recordObjectOwners } from './stage-observations.js'

test('assigning a running action overrides completion and retains the solver claim in a rule journal entry', async ({
  onTestFinished,
}) => {
  const { store, home, facts, solver, begin, stage } = await setupObserver(onTestFinished)
  const { action, agent, start } = observationsFor(facts)
  recordObjectOwners(home, [action, agent])
  begin([solver, start])
  const grounds = { evidence: [solver.id], rationale: 'Completion reported while the action is running' }
  const result = store.transaction((transaction) =>
    applyObserverResponse(transaction, {
      call: callId,
      output: response([
        { ...grounds, op: 'stage.state', stage: existing(stages.build), execution: { state: 'done' } },
        { ...grounds, op: 'actions.assign', stage: existing(stages.build), actions: [action.id] },
      ], 2),
      at: at(20),
      observations: { actions: [action], agents: [agent] },
    }),
  )
  expect(result.status).toBe('accepted')
  expect(stage()).toMatchObject({ value: {
    execution: {
      value: { state: 'running' },
      basis: { kind: 'interpreted', interpreter: { kind: 'rule', rule: 'stage-execution' } },
      evidence: expect.arrayContaining([start.id]) as unknown,
    },
    execution_claim: { value: { state: 'done' }, basis: { kind: 'claimed' }, evidence: [solver.id] },
  } })
  const changes = store.model.changes(runA, version(2))
  expect(changes).toContainEqual(expect.objectContaining({ author: 'rule', op: 'stage.execution', observer_call: null }))
  expect(store.model.entities(runA)).toContainEqual({
    kind: 'link',
    value: expect.objectContaining({ kind: 'participation', stage: stages.build, agent: agent.id }) as unknown,
  })
  const snapshot = store.model.entities(runA)
  store.transaction((transaction) => { transaction.model.replay() })
  expect(store.model.entities(runA)).toEqual(snapshot)
  store.close()
  expect(home.open().model.entities(runA)).toEqual(snapshot)
})

test('repeated bindings retain one relationship per stage with stable ids and refreshed evidence', async ({
  onTestFinished,
}) => {
  const { store, home, facts, solver, human, begin } = await setupObserver(onTestFinished)
  const { action, agent } = observationsFor(facts)
  recordObjectOwners(home, [action, agent])
  const operations = (evidence: typeof solver.id[]): ObserverOp[] => [
    { op: 'actions.assign', stage: existing(stages.build), actions: [action.id, action.id], evidence, rationale: 'Assign' },
    { op: 'actions.assign', stage: existing(stages.test), actions: [action.id], evidence, rationale: 'Shared action' },
    { op: 'agents.participate', stage: existing(stages.build), agents: [agent.id, agent.id], evidence, rationale: 'Participate' },
  ]
  begin([solver])
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, output: response(operations([solver.id]), 2), at: at(20),
  })).status).toBe('accepted')
  const links = () => store.model.entities(runA).filter((entity) => entity.kind === 'link')
  expect(links()).toHaveLength(3)
  const ids = links().map(({ value }) => value.id)
  const call = ObserverCallId.parse('repeat-bindings')
  const input = begin([human], call)
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call, output: response(operations([human.id]), input.model.version), at: at(30),
  })).status).toBe('accepted')
  expect(links()).toHaveLength(3)
  expect(links().map(({ value }) => value.id)).toEqual(ids)
  expect(links().every(({ value }) => value.evidence.length === 1 && value.evidence[0] === human.id)).toBe(true)
})

test('runtime completion restores the latest LLM claim without another observer call or duplicate versions', async ({
  onTestFinished,
}) => {
  const { store, home, facts, solver, begin, stage } = await setupObserver(onTestFinished)
  const { action, agent } = observationsFor(facts)
  recordObjectOwners(home, [action, agent])
  begin([solver])
  const grounds = { evidence: [solver.id], rationale: 'Assign work' }
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, at: at(20), observations: { actions: [action], agents: [agent] },
    output: response([
      { ...grounds, op: 'actions.assign', stage: existing(stages.build), actions: [action.id] },
      { ...grounds, op: 'stage.state', stage: existing(stages.build), execution: { state: 'done' } },
    ], 2),
  })).status).toBe('accepted')
  const done = { ...action, ended_at: at(25), execution: { state: 'done' } as const }
  const before = store.model.head(runA)
  const result = store.transaction((transaction) => refreshStageExecution(transaction, {
    run: runA, at: at(30), observations: { actions: [done], agents: [agent] },
  }))
  expect(result?.version.version).toBe(before + 1)
  expect(stage()).toMatchObject({ value: {
    execution: { value: { state: 'done' }, basis: { kind: 'claimed' }, evidence: [solver.id] },
    execution_claim: null,
  } })
  expect(store.transaction((transaction) => refreshStageExecution(transaction, {
    run: runA, at: at(40), observations: { actions: [done], agents: [agent] },
  }))).toBeNull()
  expect(store.model.head(runA)).toBe(before + 1)
})

test('a participating agent keeps work running and records a later LLM state until activity ends', async ({ onTestFinished }) => {
  const { store, home, facts, solver, begin, stage } = await setupObserver(onTestFinished)
  const { agent } = observationsFor(facts)
  recordObjectOwners(home, [agent])
  const running = { ...agent, execution: { state: 'running' } as const }
  const observations = { actions: [], agents: [running] }
  begin([solver])
  const grounds = { evidence: [solver.id], rationale: 'Agent is working on this stage' }
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, at: at(20), observations,
    output: response([{ ...grounds, op: 'agents.participate', stage: existing(stages.build), agents: [agent.id] }], 2),
  })).status).toBe('accepted')
  expect(stage()).toMatchObject({ value: { execution: { value: { state: 'running' } } } })
  const call = ObserverCallId.parse('agent-failed')
  const input = begin([solver], call)
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call, at: at(30), observations,
    output: response([{ ...grounds, op: 'stage.state', stage: existing(stages.build), execution: { state: 'failed' } }], input.model.version),
  })).status).toBe('accepted')
  expect(stage()).toMatchObject({ value: {
    execution: { value: { state: 'running' } }, execution_claim: { value: { state: 'failed' } },
  } })
  store.transaction((transaction) => refreshStageExecution(transaction, {
    run: runA, at: at(40), observations: { actions: [], agents: [agent] },
  }))
  expect(stage()).toMatchObject({ value: { execution: { value: { state: 'failed' } }, execution_claim: null } })
})

test.for(['active', 'none', 'ended'] as const)(
  'keeps human decision independent from execution for an open question with runtime wait %s',
  async (runtime_wait, { onTestFinished }) => {
    const { store, home, solver, begin, stage } = await setupObserver(onTestFinished)
    await startEngine(store, { all: true }).ingest(hookBatch({
      file: 'stage-permission.evt',
      payload: claudeHook('PermissionRequest.Bash.json', { session: 'session-a', cwd: home.path }),
    }))
    const permission = factsOf(store).find((fact) => fact.kind === 'permission_request')
    if (permission === undefined) { throw new Error('the permission hook must produce a request') }
    store.transaction((transaction) => applyChangeSet(transaction, {
      run: runA, author: 'rule', at: at(10), changes: [put('attention.open', {
        kind: 'attention_item', value: {
          ...drafts.permission, stage: stages.build, runtime_wait, evidence: [permission.id],
        },
      }, observed, [permission.id])],
    }))
    const input = begin([solver])
    expect(store.transaction((transaction) => applyObserverResponse(transaction, {
      call: callId, at: at(20), observations: { actions: [], agents: [] },
      output: response([{
        op: 'stage.state', stage: existing(stages.build), execution: { state: 'done' },
        evidence: [solver.id], rationale: 'Completion with a human question still open',
      }], input.model.version),
    })).status).toBe('accepted')
    expect(stage()).toMatchObject({ value: {
      execution: { value: runtime_wait === 'active' ? { state: 'waiting', reason: 'human' } : { state: 'done' } },
      decision: { value: 'requested', evidence: [permission.id] },
      execution_claim: runtime_wait === 'active' ? expect.objectContaining({ value: { state: 'done' } }) as unknown : null,
    } })
  },
)

test('a new nonblocking question leaves the completed stage done with a requested human decision', async ({ onTestFinished }) => {
  const { store, solver, begin, stage } = await setupObserver(onTestFinished)
  begin([solver])
  const grounds = { evidence: [solver.id], rationale: 'Review after completion' }
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, at: at(20), observations: { actions: [], agents: [] },
    output: response([
      { ...grounds, op: 'stage.state', stage: existing(stages.build), execution: { state: 'done' } },
      { ...grounds, op: 'question.add', temp_id: TempId.parse('review-question'), stage: existing(stages.build), text: 'Accept the result?' },
    ], 2),
  })).status).toBe('accepted')
  expect(stage()).toMatchObject({ value: {
    execution: { value: { state: 'done' }, basis: { kind: 'claimed' } },
    execution_claim: null, decision: { value: 'requested' },
  } })
})

test('execution follows only current run ownership and leaves replaced history unchanged', async ({ onTestFinished }) => {
  const { store, home, facts, solver, begin, stage } = await setupObserver(onTestFinished)
  const { action, agent } = observationsFor(facts)
  recordObjectOwners(home, [action, agent])
  begin([solver])
  const grounds = { evidence: [solver.id], rationale: 'Link the action' }
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, at: at(20),
    output: response([
      { ...grounds, op: 'actions.assign', stage: existing(stages.build), actions: [action.id] },
      { ...grounds, op: 'stage.state', stage: existing(stages.build), execution: { state: 'done' } },
    ], 2),
  })).status).toBe('accepted')
  const database = home.database()
  database.prepare('UPDATE objects SET run_id = ? WHERE id = ?').run(runB, action.id)
  database.close()
  const before = stage()
  expect(store.transaction((transaction) => refreshStageExecution(transaction, {
    run: runA, at: at(30), observations: { actions: [action], agents: [agent] },
  }))).toBeNull()
  expect(stage()).toEqual(before)
  const call = ObserverCallId.parse('replace-inactive')
  const input = begin([solver], call)
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call, at: at(40),
    output: response([{ ...grounds, op: 'stage.replace', stage: existing(stages.build), by: [existing(stages.test)] }], input.model.version),
  })).status).toBe('accepted')
  const replaced = stage()
  expect(store.transaction((transaction) => refreshStageExecution(transaction, {
    run: runA, at: at(50), observations: { actions: [action], agents: [{ ...agent, execution: { state: 'running' } }] },
  }))).toBeNull()
  expect(stage()).toEqual(replaced)
})

test.for(['human', 'background', 'idle', 'unknown'] as const)(
  'an explicitly waiting participant reports the known %s wait instead of inferring completion',
  async (reason, { onTestFinished }) => {
    const { store, home, facts, solver, begin, stage } = await setupObserver(onTestFinished)
    const { agent } = observationsFor(facts)
    recordObjectOwners(home, [agent])
    begin([solver])
    expect(store.transaction((transaction) => applyObserverResponse(transaction, {
      call: callId, at: at(20),
      observations: { actions: [], agents: [{ ...agent, execution: { state: 'waiting', reason } }] },
      output: response([{
        op: 'agents.participate', agents: [agent.id], stage: existing(stages.build),
        evidence: [solver.id], rationale: 'The runtime reports a wait',
      }], 2),
    })).status).toBe('accepted')
    expect(stage()).toMatchObject({ value: { execution: { value: { state: 'waiting', reason } } } })
  },
)

test('an ended runtime wait restores done while keeping an unanswered question requested', async ({ onTestFinished }) => {
  const { store, solver, begin, stage } = await setupObserver(onTestFinished)
  const attention = { ...drafts.permission, stage: stages.build, evidence: [solver.id] }
  store.transaction((transaction) => applyChangeSet(transaction, {
    run: runA, author: 'rule', at: at(10),
    changes: [put('attention.wait', { kind: 'attention_item', value: attention }, observed, [solver.id])],
  }))
  const input = begin([solver])
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, at: at(20), observations: { actions: [], agents: [] },
    output: response([{
      op: 'stage.state', stage: existing(stages.build), execution: { state: 'done' },
      evidence: [solver.id], rationale: 'Done with an outstanding request',
    }], input.model.version),
  })).status).toBe('accepted')
  expect(stage()).toMatchObject({ value: { execution: { value: { state: 'waiting', reason: 'human' } } } })
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run: runA, author: 'rule', at: at(30), changes: [put('attention.wait', {
        kind: 'attention_item', value: { ...attention, runtime_wait: 'ended' },
      }, observed, [solver.id])],
    })
    refreshStageExecution(transaction, { run: runA, at: at(30), observations: { actions: [], agents: [] } })
  })
  expect(stage()).toMatchObject({ value: {
    execution: { value: { state: 'done' } }, execution_claim: null, decision: { value: 'requested' },
  } })
})

test('rejects the full response without applying runtime rules and rolls a successful response back with its transaction', async ({ onTestFinished }) => {
  const { store, home, facts, solver, begin } = await setupObserver(onTestFinished)
  const { action, agent } = observationsFor(facts)
  recordObjectOwners(home, [action, agent])
  begin([solver])
  const before = store.model.entities(runA)
  const grounds = { evidence: [solver.id], rationale: 'Assign action' }
  const assignment: ObserverOp = { ...grounds, op: 'actions.assign', stage: existing(stages.build), actions: [action.id] }
  const observations = { actions: [action], agents: [agent] }
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, at: at(20), observations,
    output: response([assignment, { ...grounds, op: 'stage.nest', stage: existing(stages.build), parent: existing('missing') }], 2),
  })).status).toBe('rejected')
  expect(store.model.entities(runA)).toEqual(before)
  expect(store.model.changes(runA, version(2))).toEqual([])
  expect(store.interpretations.ofCall(callId).map(({ status }) => status)).toEqual(['pending'])
  const call = ObserverCallId.parse('rolled-back-rules')
  begin([solver], call)
  expect(() => store.transaction((transaction) => {
    expect(applyObserverResponse(transaction, {
      call, at: at(30), observations, output: response([assignment], 2),
    }).status).toBe('accepted')
    throw new Error('abort the transaction')
  })).toThrow('abort the transaction')
  expect(store.model.entities(runA)).toEqual(before)
  expect(store.model.changes(runA, version(2))).toEqual([])
  expect(store.observerCalls.get(call)?.finished_at).toBeNull()
  expect(store.interpretations.ofCall(call).map(({ status }) => status)).toEqual(['in_call'])
})

test('closing the last request clears the derived requested decision without inventing approval', async ({ onTestFinished }) => {
  const { store, solver, begin, stage } = await setupObserver(onTestFinished)
  begin([solver])
  const grounds = { evidence: [solver.id], rationale: 'Question' }
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, at: at(20), observations: { actions: [], agents: [] },
    output: response([{ ...grounds, op: 'question.add', temp_id: TempId.parse('question'), stage: existing(stages.build), text: 'Proceed?' }], 2),
  })).status).toBe('accepted')
  const question = store.model.entities(runA).find((entity) => entity.kind === 'attention_item' && entity.value.text === 'Proceed?')
  if (question?.kind !== 'attention_item') { throw new Error('missing question') }
  const call = ObserverCallId.parse('close-last-question')
  const input = begin([solver], call)
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call, at: at(30), observations: { actions: [], agents: [] },
    output: response([{
      ...grounds, op: 'attention.resolve', item: { kind: 'existing', id: question.value.id }, resolution: 'resolved',
    }], input.model.version),
  })).status).toBe('accepted')
  expect(stage()).toMatchObject({ value: { decision: { value: 'unknown' } } })
})

test('losing an active observation without an LLM state reports unknown instead of done, failed or waiting', async ({ onTestFinished }) => {
  const { store, solver, stage } = await setupObserver(onTestFinished)
  store.transaction((transaction) => applyChangeSet(transaction, {
    run: runA, author: 'rule', at: at(20), changes: [put('stage.execution', {
      kind: 'stage', value: { ...drafts.running, execution_claim: null },
    }, drafts.running.execution.basis, [solver.id])],
  }))
  store.transaction((transaction) => refreshStageExecution(transaction, {
    run: runA, at: at(30), observations: { actions: [], agents: [] },
  }))
  expect(stage()).toMatchObject({ value: { execution: { value: { state: 'unknown' } }, execution_claim: null } })
})

test('an action-level permission waits for a human before its agent is available and stops waiting after resolution', async ({ onTestFinished }) => {
  const { store, home, facts, solver, begin, stage } = await setupObserver(onTestFinished)
  const { action } = observationsFor(facts)
  recordObjectOwners(home, [action])
  await startEngine(store, { all: true }).ingest(hookBatch({
    file: 'unassigned-permission.evt',
    payload: claudeHook('PermissionRequest.Bash.json', { session: 'session-a', cwd: home.path }),
  }))
  const permission = factsOf(store).find((fact) => fact.kind === 'permission_request')
  if (permission === undefined) { throw new Error('missing permission request') }
  const item = { ...drafts.permission, action: action.id, evidence: [permission.id] }
  store.transaction((transaction) => applyChangeSet(transaction, {
    run: runA, author: 'rule', at: at(10),
    changes: [put('attention.open', { kind: 'attention_item', value: item }, observed, [permission.id])],
  }))
  const input = begin([solver])
  const waiting = { ...action, execution: { state: 'waiting', reason: 'human' } as const }
  expect(store.transaction((transaction) => applyObserverResponse(transaction, {
    call: callId, at: at(20), observations: { actions: [waiting], agents: [] },
    output: response([{
      op: 'actions.assign', actions: [action.id], stage: existing(stages.build),
      evidence: [solver.id], rationale: 'Assign the action awaiting permission',
    }], input.model.version),
  })).status).toBe('accepted')
  expect(stage()).toMatchObject({ value: {
    execution: { value: { state: 'waiting', reason: 'human' } }, decision: { value: 'requested' },
  } })
  expect(store.model.entities(runA).filter((entity) => entity.kind === 'link' && entity.value.kind === 'participation')).toEqual([])
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run: runA, author: 'rule', at: at(30), changes: [put('attention.close', {
        kind: 'attention_item', value: { ...item, resolution: 'answered', closed_at: at(30) },
      }, observed, [permission.id])],
    })
    refreshStageExecution(transaction, {
      run: runA, at: at(30), observations: { actions: [{ ...action, execution: { state: 'done' } }], agents: [] },
    })
  })
  expect(stage()).toMatchObject({ value: { execution: { value: { state: 'planned' } }, execution_claim: null } })
})
