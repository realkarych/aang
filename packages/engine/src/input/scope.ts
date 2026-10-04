import {
  type Action,
  type ActionId,
  type AgentId,
  type Fact,
  type FactId,
  type MaterialUnavailableReason,
  type ModelChange,
  type ModelEntityRef,
  ModelVersion,
  type ObserverCallId,
  type ObserverInput,
  type RawRecord,
  type RawSeq,
  type RunId,
  type Runtime,
  type SessionId,
  type StageId,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type {
  ArtifactReader,
  FactReader,
  ModelReader,
  ObservationReader,
  ObserverCallReader,
  RawRecordReader,
} from '@aang/store'

export interface ScopeReader {
  readonly facts: FactReader
  readonly rawRecords: RawRecordReader
  readonly observations: ObservationReader
  readonly model: ModelReader
  readonly observerCalls: ObserverCallReader
  readonly artifacts: ArtifactReader
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
  readonly grounds: (evidence: readonly FactId[], owner: ModelEntityRef) => ScopeExclusion | null
  readonly entity: (ref: ModelEntityRef) => ScopeExclusion | null
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
  const vendor = (runtime: Runtime): ScopeExclusion | null =>
    runtime === backend || crossVendor ? null : 'cross_vendor'
  const admit = (session: SessionId, runtime: Runtime): ScopeExclusion | null =>
    sessionInRun(reader.model, run, session) ? vendor(runtime) : 'out_of_scope'
  const own = (value: Fact): ScopeExclusion | null => admit(factSession(value), value.entity_key.runtime)
  const recordOf = (seq: RawSeq): ScopeExclusion | null => {
    const exclusions = reader.facts.ofRecord(seq).map(own)
    if (exclusions.length === 0 || exclusions.includes('out_of_scope')) {
      return 'out_of_scope'
    }
    return exclusions.includes('cross_vendor') ? 'cross_vendor' : null
  }
  const fact = (value: Fact): ScopeExclusion | null => (value.kind === 'context' ? recordOf(value.seq) : own(value))
  const sent = new Map<ObserverCallId, ReadonlyMap<FactId, RawSeq>>()
  const sentFacts = (call: ObserverCallId): ReadonlyMap<FactId, RawSeq> => {
    const known = sent.get(call)
    if (known !== undefined) {
      return known
    }
    const facts = new Map((reader.observerCalls.get(call)?.input.batch.facts ?? []).map(({ id, seq }) => [id, seq]))
    sent.set(call, facts)
    return facts
  }
  const origin = (id: FactId, calls: readonly ObserverCallId[]): Runtime | null => {
    const stored = reader.facts.get(id)
    if (stored !== null) {
      return stored.entity_key.runtime
    }
    const seq = calls.map((call) => sentFacts(call).get(id)).find((value) => value !== undefined)
    return seq === undefined ? null : (reader.rawRecords.get(seq)?.runtime ?? null)
  }
  const journalOf = (ref: ModelEntityRef): ModelChange[] => reader.model.entityChanges(run, ref, ModelVersion.parse(0))
  const attributed = (evidence: readonly FactId[], journal: readonly ModelChange[]): ScopeExclusion | null => {
    const calls = [...new Set(journal.flatMap(({ observer_call: call }) => (call === null ? [] : [call])))]
    return evidence.every((id) => origin(id, calls) === backend) ? null : 'cross_vendor'
  }
  const grounds = (evidence: readonly FactId[], owner: ModelEntityRef): ScopeExclusion | null =>
    crossVendor ? null : attributed(evidence, journalOf(owner))
  const entity = (ref: ModelEntityRef): ScopeExclusion | null => {
    if (reader.model.entity(run, ref) === null) {
      return 'out_of_scope'
    }
    if (crossVendor) {
      return null
    }
    const journal = journalOf(ref)
    return attributed(journal.flatMap(({ evidence }) => evidence), journal)
  }
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
    grounds,
    entity,
    record: (record) => recordOf(record.seq),
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
    check(`${ref.kind} ${ref.id}`, scope.entity(ref))
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
