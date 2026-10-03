import type {
  Action,
  ActionId,
  AgentId,
  Fact,
  FactId,
  MaterialUnavailableReason,
  ModelEntityRef,
  ObserverInput,
  RawRecord,
  RunId,
  Runtime,
  SessionId,
  StageId,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { FactReader, ModelReader, ObservationReader, RawRecordReader } from '@aang/store'

export interface ScopeReader {
  readonly facts: FactReader
  readonly rawRecords: RawRecordReader
  readonly observations: ObservationReader
  readonly model: ModelReader
}

export interface InputScopeOptions {
  readonly run: RunId
  readonly backend: Runtime
  readonly crossVendor: boolean
}

export type ScopeExclusion = Extract<MaterialUnavailableReason, 'out_of_scope' | 'cross_vendor'>

export interface InputScope extends InputScopeOptions {
  readonly fact: (fact: Fact) => ScopeExclusion | null
  readonly record: (record: RawRecord) => ScopeExclusion | null
  readonly action: (action: Action) => ScopeExclusion | null
  readonly session: (session: SessionId) => ScopeExclusion | null
  readonly agent: (agent: AgentId) => ScopeExclusion | null
}

export interface ScopeViolation {
  readonly object: string
  readonly reason: ScopeExclusion
}

export const sessionInRun = (
  model: Pick<ModelReader, 'objectRun' | 'entity'>,
  run: RunId,
  session: SessionId,
): boolean => {
  const owner = model.objectRun('session', session)
  return owner === undefined
    ? model.entity(run, { kind: 'session_membership', id: session }) !== null
    : owner === run
}

export const factSession = (fact: Fact): SessionId => {
  const { runtime, session } = fact.entity_key
  return objectId({ kind: 'session', runtime, session })
}

export const inputScope = (reader: ScopeReader, options: InputScopeOptions): InputScope => {
  const { run, backend, crossVendor } = options
  const admit = (session: SessionId, vendor: Runtime): ScopeExclusion | null => {
    if (!sessionInRun(reader.model, run, session)) {
      return 'out_of_scope'
    }
    return vendor === backend || crossVendor ? null : 'cross_vendor'
  }
  const fact = (value: Fact): ScopeExclusion | null => admit(factSession(value), value.entity_key.runtime)
  return {
    run,
    backend,
    crossVendor,
    fact,
    action: (action) => admit(action.session, action.key.runtime),
    session: (id) => {
      const session = reader.observations.getSession(id)
      return session === null ? 'out_of_scope' : admit(id, session.key.runtime)
    },
    agent: (id) => {
      const agent = reader.observations.getAgent(id)
      return agent === null ? 'out_of_scope' : admit(agent.session, agent.key.runtime)
    },
    record: (record) => {
      const exclusions = reader.facts.ofRecord(record.seq).map(fact)
      if (exclusions.length === 0 || exclusions.includes('out_of_scope')) {
        return 'out_of_scope'
      }
      return exclusions.includes('cross_vendor') ? 'cross_vendor' : null
    },
  }
}

export const inputViolations = (reader: ScopeReader, scope: InputScope, input: ObserverInput): ScopeViolation[] => {
  const violations: ScopeViolation[] = []
  const check = (object: string, reason: ScopeExclusion | null): void => {
    if (reason !== null) {
      violations.push({ object, reason })
    }
  }
  const fact = (id: FactId): void => {
    const stored = reader.facts.get(id)
    check(`fact ${id}`, stored === null ? 'out_of_scope' : scope.fact(stored))
  }
  const session = (id: SessionId): void => {
    check(`session ${id}`, scope.session(id))
  }
  const agent = (id: AgentId | null): void => {
    if (id !== null) {
      check(`agent ${id}`, scope.agent(id))
    }
  }
  const action = (id: ActionId | null): void => {
    if (id !== null) {
      const stored = reader.observations.getAction(id)
      check(`action ${id}`, stored === null ? 'out_of_scope' : scope.action(stored))
    }
  }
  const entity = (ref: ModelEntityRef): void => {
    check(`${ref.kind} ${ref.id}`, reader.model.entity(scope.run, ref) === null ? 'out_of_scope' : null)
  }
  const stage = (id: StageId | null): void => {
    if (id !== null) {
      entity({ kind: 'stage', id })
    }
  }
  const { run, context, model, batch } = input
  for (const brief of run.sessions) {
    session(brief.id)
  }
  for (const brief of run.agents) {
    agent(brief.id)
    session(brief.session)
    agent(brief.parent)
  }
  if (context !== null) {
    const record = reader.rawRecords.get(context.seq)
    check(`context record ${String(context.seq)}`, record === null ? 'out_of_scope' : scope.record(record))
  }
  for (const value of model.stages) {
    stage(value.id)
    stage(value.parent)
  }
  for (const value of model.criteria) {
    entity({ kind: 'criterion', id: value.id })
    stage(value.stage)
  }
  for (const value of model.attention) {
    entity({ kind: 'attention_item', id: value.id })
    stage(value.stage)
  }
  for (const value of batch.facts) {
    fact(value.id)
    session(value.session)
    agent(value.agent)
    action(value.action)
  }
  for (const value of batch.collapsed) {
    for (const id of value.facts) {
      fact(id)
    }
    agent(value.agent)
  }
  for (const value of batch.backlog?.agents ?? []) {
    agent(value.agent)
  }
  for (const value of batch.artifact_versions) {
    check(
      `artifact version ${value.id}`,
      reader.model.objectRun('artifact_version', value.id) === scope.run ? null : 'out_of_scope',
    )
    action(value.produced_by)
  }
  return violations
}
