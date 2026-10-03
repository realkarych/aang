import { randomUUID } from 'node:crypto'
import {
  type BacklogSummary,
  type ChatFocus,
  ChatInput,
  ChatOutput,
  type CollapsedFacts,
  type EpochNs,
  type Fact,
  JsonValue,
  type ModelEntity,
  type ModelSnapshot,
  ModelVersion,
  ObserverCallId,
  type ObserverInput,
  ObserverOutput,
  type RunDescription,
  type RunId,
  type Runtime,
  type SessionId,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import { applyObserverResponse, beginObserverCall, type ObserverResponseResult } from '@aang/engine'
import type { Store } from '@aang/store'
import { type ObserverScenarioReply, runScenarioScript } from '@aang/testkit'
import { factsOf } from './harness.js'

const iso = (at: EpochNs): string => new Date(Number(at / 1_000_000n)).toISOString()

const jsonOf = (value: unknown): JsonValue =>
  JsonValue.parse(
    JSON.parse(JSON.stringify(value, (_key, member: unknown) => (typeof member === 'bigint' ? member.toString() : member))),
  )

const runSessions = (store: Store, run: RunId) => store.observations.sessions().filter((session) => session.run === run)

const runEntity = (store: Store, run: RunId) => {
  const entity = store.model.entity(run, { kind: 'run', id: run })
  if (entity?.kind !== 'run') {
    throw new Error(`run ${run} has no model entity`)
  }
  return entity.value
}

export const runDescription = (store: Store, run: RunId): RunDescription => {
  const value = runEntity(store, run)
  const sessions = runSessions(store, run)
  return {
    id: run,
    runtime: value.runtime,
    goal: value.goal?.text ?? null,
    brief: value.brief?.text ?? null,
    sessions: sessions.map((session) => ({
      id: session.id,
      runtime: session.key.runtime,
      surface: session.surface?.surface ?? null,
      cwd: session.cwd,
      git_branch: session.git_branch,
      started_at: iso(session.started_at),
    })),
    agents: sessions.flatMap((session) =>
      store.observations.agents(session.id).map((agent) => ({
        id: agent.id,
        session: agent.session,
        role: agent.role,
        service: agent.service,
        agent_type: agent.agent_type,
        name: agent.name,
        description: agent.description,
        parent: agent.parent,
      })),
    ),
  }
}

export const valuesOf = <K extends ModelEntity['kind']>(store: Store, run: RunId, kind: K) =>
  store.model
    .entities(run)
    .flatMap((entity) => (entity.kind === kind ? [entity.value as Extract<ModelEntity, { kind: K }>['value']] : []))

export const modelSnapshot = (store: Store, run: RunId): ModelSnapshot => ({
  version: store.model.head(run),
  stages: valuesOf(store, run, 'stage')
    .filter(({ lifecycle }) => lifecycle.state === 'active')
    .map((stage) => ({
      id: stage.id,
      title: stage.title,
      expected_result: stage.expected_result,
      summary: stage.summary,
      parent: stage.parent,
      origin: stage.origin,
      execution: stage.execution.value,
      decision: stage.decision.value,
    })),
  criteria: valuesOf(store, run, 'criterion').map((criterion) => ({
    id: criterion.id,
    stage: criterion.stage,
    text: criterion.text,
    source: criterion.source,
    status: criterion.status.value,
  })),
  attention: valuesOf(store, run, 'attention_item')
    .filter(({ resolution }) => resolution === 'open')
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      author: item.author,
      text: item.text,
      stage: item.stage,
      runtime_wait: item.runtime_wait,
      resolution: item.resolution,
      likely_resolved: item.likely_resolved !== null,
    })),
})

const factSession = (fact: Fact): SessionId =>
  objectId({ kind: 'session', runtime: fact.entity_key.runtime, session: fact.entity_key.session })

const factAgent = (store: Store, fact: Fact) => {
  const key = fact.entity_key
  if (key.kind === 'agent') {
    return objectId(key)
  }
  return key.kind === 'action' ? (store.observations.getAction(objectId(key))?.agent ?? null) : null
}

export const pendingFacts = (store: Store, run: RunId): Fact[] => {
  const queued = new Set(store.interpretations.pending(run).map(({ fact }) => fact))
  return factsOf(store).filter((fact) => queued.has(fact.id))
}

export interface Batch {
  readonly facts: readonly Fact[]
  readonly collapsed?: readonly CollapsedFacts[]
  readonly backlog?: BacklogSummary | null
}

export const observerInput = (store: Store, run: RunId, batch: Batch): ObserverInput => ({
  run: runDescription(store, run),
  context: null,
  model: modelSnapshot(store, run),
  batch: {
    facts: batch.facts.map((fact) => ({
      id: fact.id,
      seq: fact.seq,
      kind: fact.kind,
      speaker: fact.speaker,
      at: iso(fact.at),
      urgent: fact.urgent,
      session: factSession(fact),
      agent: factAgent(store, fact),
      action: fact.entity_key.kind === 'action' ? objectId(fact.entity_key) : null,
      payload: jsonOf(fact.payload),
      truncated: [],
    })),
    collapsed: [...(batch.collapsed ?? [])],
    backlog: batch.backlog ?? null,
    artifact_versions: [],
  },
  materials: [],
  previous_attempt: null,
})

export interface ObservedCall {
  readonly input: ObserverInput
  readonly output: ObserverOutput
  readonly result: ObserverResponseResult
}

const scriptOf = (reply: ObserverScenarioReply | undefined) => {
  if (reply?.kind !== 'script') {
    throw new Error('the scenario phase must answer with a script')
  }
  return reply.script
}

export const observeBatch = (
  store: Store,
  run: RunId,
  backend: Runtime,
  reply: ObserverScenarioReply | undefined,
  at: EpochNs,
  batch: Batch = { facts: pendingFacts(store, run) },
): ObservedCall => {
  const input = observerInput(store, run, batch)
  const id = ObserverCallId.parse(randomUUID())
  store.transaction((transaction) => {
    beginObserverCall(transaction, { id, backend, crossVendor: false, input, at })
  })
  const output = runScenarioScript(scriptOf(reply), jsonOf(input))
  const result = store.transaction((transaction) => applyObserverResponse(transaction, { call: id, output, at }))
  return { input, output: ObserverOutput.parse(output), result }
}

export const chatInput = (store: Store, run: RunId, question: string, focus: ChatFocus): ChatInput =>
  ChatInput.parse({
    question,
    history: [],
    run: runDescription(store, run),
    model: modelSnapshot(store, run),
    focus,
    materials: [],
  })

export const runFocus = (store: Store, run: RunId): ChatFocus => ({
  kind: 'run',
  attention: modelSnapshot(store, run).attention,
  recent_changes: store.model.changes(run, ModelVersion.parse(0)).map((change) => ({
    version: change.version,
    op: change.op,
    author: change.author,
    target: change.target,
    before: jsonOf(change.before),
    after: jsonOf(change.after),
    evidence: change.evidence,
  })),
})

export const answerChat = (reply: ObserverScenarioReply | undefined, input: ChatInput): ChatOutput =>
  ChatOutput.parse(runScenarioScript(scriptOf(reply), jsonOf(input)))
