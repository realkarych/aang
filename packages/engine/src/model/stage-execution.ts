import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  type Action,
  type Agent,
  type Assessed,
  type Basis,
  type EpochNs,
  type Execution,
  type FactId,
  LinkId,
  type RunId,
} from '@aang/contract'
import type { Transaction } from '@aang/store'
import { applyChangeSet, type AppliedChangeSet, type ModelChangeDraft } from './journal.js'

export interface StageAgentObservation extends Agent {
  readonly execution_evidence: readonly FactId[]
}

export interface StageObservations {
  readonly actions: readonly Action[]
  readonly agents: readonly StageAgentObservation[]
}

export interface StageExecutionUpdate {
  readonly run: RunId
  readonly at: EpochNs
  readonly observations: StageObservations
}

const basis: Basis = { kind: 'interpreted', interpreter: { kind: 'rule', rule: 'stage-execution' } }

const canonicalEvidence = (evidence: readonly FactId[]): FactId[] => [...new Set(evidence)].sort()

export const refreshStageExecution = (
  transaction: Transaction,
  update: StageExecutionUpdate,
): AppliedChangeSet | null => {
  const { run, at, observations } = update
  const entities = transaction.model.entities(run)
  const links = entities.filter((entity) => entity.kind === 'link').map(({ value }) => value)
  const changes: ModelChangeDraft[] = []
  for (const entity of entities) {
    if (entity.kind !== 'stage' || entity.value.lifecycle.state !== 'active') {
      continue
    }
    const stage = entity.value
    const assignments = links.filter((link) => link.kind === 'assignment').filter((link) => link.stage === stage.id)
    const actions = observations.actions.filter((action) =>
      action.run === run && transaction.model.objectRun('action', action.id) === run &&
      assignments.some((link) => link.action === action.id),
    )
    const participants = new Set(links.filter((link) => link.kind === 'participation').filter((link) => link.stage === stage.id)
      .map((link) => link.agent))
    for (const action of actions) {
      if (action.agent === null || participants.has(action.agent)) {
        continue
      }
      const agent = observations.agents.find((agent) => agent.id === action.agent && agent.run === run &&
        transaction.model.objectRun('agent', agent.id) === run)
      if (agent === undefined) {
        continue
      }
      participants.add(agent.id)
      const evidence = canonicalEvidence(assignments.filter((link) => link.action === action.id).flatMap((link) => link.evidence))
      changes.push({
        op: 'link.add', basis, evidence,
        put: { kind: 'link', value: {
          id: LinkId.parse(randomUUID()), kind: 'participation', run, stage: stage.id,
          agent: agent.id, basis, evidence,
        } },
      })
    }
    const agents = observations.agents.filter((agent) =>
      agent.run === run && transaction.model.objectRun('agent', agent.id) === run && participants.has(agent.id),
    )
    const runningActions = actions.filter((action) => action.execution.state === 'running')
    const runningAgents = agents.filter((agent) => agent.execution.state === 'running')
    const activityEvidence = canonicalEvidence([
      ...runningActions.flatMap((action) => action.input_fact === null ? [] : [action.input_fact]),
      ...runningAgents.flatMap((agent) => agent.execution_evidence),
    ])
    const attention = entities.filter((entity) => entity.kind === 'attention_item').map(({ value }) => value)
      .filter((item) => item.stage === stage.id || (
        item.stage === null && item.action !== null && transaction.model.objectRun('action', item.action) === run &&
        assignments.some((link) => link.action === item.action)
      ))
    const requests = attention.filter((item) =>
      item.resolution === 'open' && ['question', 'permission', 'review_request'].includes(item.kind),
    )
    const waits = requests.filter((item) => item.author === 'rule' && item.runtime_wait === 'active')
    const waitingActions = actions.filter((action) => action.execution.state === 'waiting')
    const waitingAgents = agents.filter((agent) => agent.execution.state === 'waiting')
    const waiting = [...waitingActions, ...waitingAgents].map(({ execution }) => execution)
      .filter((execution) => execution.state === 'waiting')
    const reason = (['human', 'background', 'idle', 'unknown'] as const)
      .find((reason) => waiting.some((execution) => execution.reason === reason))
    const waitEvidence = canonicalEvidence([
      ...waits.flatMap((item) => item.evidence),
      ...waitingActions.flatMap((action) => action.input_fact === null ? [] : [action.input_fact]),
      ...waitingAgents.flatMap((agent) => agent.execution_evidence),
    ])
    const ruled: Assessed<Execution> | null = runningActions.length > 0 || runningAgents.length > 0
      ? { value: { state: 'running' }, basis, evidence: activityEvidence }
      : waits.length > 0 || reason !== undefined
        ? { value: { state: 'waiting', reason: waits.length > 0 ? 'human' : reason ?? 'unknown' }, basis, evidence: waitEvidence }
        : null
    const priorRule = stage.execution.basis.kind === 'interpreted' &&
      stage.execution.basis.interpreter.kind === 'rule' &&
      stage.execution.basis.interpreter.rule === 'stage-execution'
    const claim = stage.execution_claim ?? (priorRule ? null : stage.execution)
    const execution = ruled ?? claim ?? { value: { state: 'unknown' } as const, basis, evidence: [] }
    const execution_claim = ruled === null ? null : claim
    const derivedRequest = stage.decision.value === 'requested' && stage.decision.basis.kind === 'interpreted' &&
      stage.decision.basis.interpreter.kind === 'rule' && stage.decision.basis.interpreter.rule === 'stage-execution'
    const decision = requests.length === 0
      ? derivedRequest
        ? { value: 'unknown' as const, basis, evidence: canonicalEvidence(attention.flatMap((item) => item.evidence)) }
        : stage.decision
      : { value: 'requested' as const, basis, evidence: canonicalEvidence(requests.flatMap((item) => item.evidence)) }
    const executionChanged = !isDeepStrictEqual(stage.execution, execution) ||
      !isDeepStrictEqual(stage.execution_claim, execution_claim)
    const decisionChanged = !isDeepStrictEqual(stage.decision, decision)
    if (executionChanged || decisionChanged) {
      const evidence = canonicalEvidence([
        ...(executionChanged ? execution.evidence : []),
        ...(decisionChanged ? decision.evidence : []),
      ])
      changes.push({
        op: 'stage.execution', basis, evidence,
        put: { kind: 'stage', value: { ...stage, execution, execution_claim, decision } },
      })
    }
  }
  return changes.length === 0 ? null : applyChangeSet(transaction, { run, at, author: 'rule', changes })
}
