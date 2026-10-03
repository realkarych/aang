import {
  type Action,
  type Agent,
  type EpochNs,
  type Fact,
  type GapKey,
  type InputFact,
  JsonValue,
  type ModelEntity,
  type ModelSnapshot,
  type ObserverCallId,
  type ObserverInput,
  type ObserverRejection,
  type Run,
  type RunDescription,
  type RunId,
  type Runtime,
  type Session,
  type SessionId,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { PendingFact, StoredObserverCall, Transaction } from '@aang/store'
import { beginObserverCall } from '../model/observer.js'
import { clipJson, isoTime } from './materials.js'
import { factSession, type InputScope, inputScope, type ScopeExclusion } from './scope.js'

export interface BatchLimits {
  readonly facts: number
  readonly bytes: number
  readonly textLength: number
}

export interface ObserverBatchStart {
  readonly run: RunId
  readonly backend: Runtime
  readonly crossVendor: boolean
  readonly id: ObserverCallId
  readonly at: EpochNs
  readonly limits: BatchLimits
}

interface Queued {
  readonly pending: PendingFact
  readonly fact: Fact
}

const jsonOf = (value: unknown): JsonValue =>
  JsonValue.parse(
    JSON.parse(JSON.stringify(value, (_key, member: unknown) => (typeof member === 'bigint' ? member.toString() : member))),
  )

const sessionBrief = (session: Session): RunDescription['sessions'][number] => ({
  id: session.id,
  runtime: session.key.runtime,
  surface: session.surface?.surface ?? null,
  cwd: session.cwd,
  git_branch: session.git_branch,
  started_at: isoTime(session.started_at),
})

const agentBrief = (scope: InputScope, agent: Agent): RunDescription['agents'][number] => ({
  id: agent.id,
  session: agent.session,
  role: agent.role,
  service: agent.service,
  agent_type: agent.agent_type,
  name: agent.name,
  description: agent.description,
  parent: agent.parent !== null && scope.agent(agent.parent) === null ? agent.parent : null,
})

const describeRun = (transaction: Transaction, scope: InputScope, run: Run): RunDescription => {
  const sessions = transaction.observations.sessions().filter((session) => scope.session(session.id) === null)
  return {
    id: run.id,
    runtime: run.runtime,
    goal: run.goal?.text ?? null,
    brief: run.brief?.text ?? null,
    sessions: sessions.map(sessionBrief),
    agents: sessions
      .flatMap((session) => transaction.observations.agents(session.id))
      .filter((agent) => scope.agent(agent.id) === null)
      .map((agent) => agentBrief(scope, agent)),
  }
}

const snapshotOf = (transaction: Transaction, run: RunId): ModelSnapshot => {
  const entities: ModelEntity[] = transaction.model.entities(run)
  return {
    version: transaction.model.head(run),
    stages: entities.flatMap((entity) =>
      entity.kind === 'stage' && entity.value.lifecycle.state === 'active'
        ? [
            {
              id: entity.value.id,
              title: entity.value.title,
              expected_result: entity.value.expected_result,
              summary: entity.value.summary,
              parent: entity.value.parent,
              origin: entity.value.origin,
              execution: entity.value.execution.value,
              decision: entity.value.decision.value,
            },
          ]
        : [],
    ),
    criteria: entities.flatMap((entity) =>
      entity.kind === 'criterion'
        ? [
            {
              id: entity.value.id,
              stage: entity.value.stage,
              text: entity.value.text,
              source: entity.value.source,
              status: entity.value.status.value,
            },
          ]
        : [],
    ),
    attention: entities.flatMap((entity) =>
      entity.kind === 'attention_item' && entity.value.resolution === 'open'
        ? [
            {
              id: entity.value.id,
              kind: entity.value.kind,
              author: entity.value.author,
              text: entity.value.text,
              stage: entity.value.stage,
              runtime_wait: entity.value.runtime_wait,
              resolution: entity.value.resolution,
              likely_resolved: entity.value.likely_resolved !== null,
            },
          ]
        : [],
    ),
  }
}

const actionOf = (transaction: Transaction, scope: InputScope, fact: Fact): Action | null => {
  const key = fact.entity_key
  const action = key.kind === 'action' ? transaction.observations.getAction(objectId(key)) : null
  return action !== null && scope.action(action) === null ? action : null
}

const inputFact = (transaction: Transaction, scope: InputScope, fact: Fact, textLength: number): InputFact => {
  const action = actionOf(transaction, scope, fact)
  const key = fact.entity_key
  const agent = key.kind === 'agent' ? objectId(key) : (action?.agent ?? null)
  const payload = clipJson(jsonOf(fact.payload), 'payload', textLength)
  return {
    id: fact.id,
    seq: fact.seq,
    kind: fact.kind,
    speaker: fact.speaker,
    at: isoTime(fact.at),
    urgent: fact.urgent,
    session: factSession(fact),
    agent: agent !== null && scope.agent(agent) === null ? agent : null,
    action: action?.id ?? null,
    payload: payload.value,
    truncated: payload.truncated,
  }
}

const exclusionGap = (scope: InputScope, session: SessionId, reason: ScopeExclusion): GapKey => ({
  kind: 'gap',
  gap: reason === 'cross_vendor' ? 'cross_vendor_excluded' : 'not_interpreted',
  subject: `${scope.run}:${session}`,
})

const exclude = (transaction: Transaction, scope: InputScope, queued: readonly Queued[], at: EpochNs): Queued[] => {
  const excluded = new Map<SessionId, ScopeExclusion>()
  const dropped: Fact['id'][] = []
  const kept = queued.filter(({ fact }) => {
    const reason = scope.fact(fact)
    if (reason !== null) {
      excluded.set(factSession(fact), reason)
      dropped.push(fact.id)
    }
    return reason === null
  })
  transaction.interpretations.close(scope.run, dropped, 'not_interpreted')
  for (const [session, reason] of excluded) {
    const key = exclusionGap(scope, session, reason)
    const gap = transaction.gaps.get(objectId(key))
    if (gap === null || gap.closed_at !== null) {
      transaction.gaps.save({
        key,
        run: scope.run,
        session,
        stream: null,
        details:
          reason === 'cross_vendor'
            ? `facts of this session are not sent to the ${scope.backend} observer without observer.crossVendor`
            : 'facts of this session are outside the run of the observer queue',
        detected_at: at,
        closed_at: null,
      })
    }
  }
  return kept
}

const select = (queued: readonly Queued[], limits: BatchLimits): Queued[] => {
  const batch: Queued[] = []
  let bytes = 0
  for (const item of queued) {
    if (batch.length === limits.facts || (batch.length > 0 && bytes + item.pending.bytes > limits.bytes)) {
      break
    }
    batch.push(item)
    bytes += item.pending.bytes
  }
  return batch
}

const describeRejection = ({ op_index: index, cause, message }: ObserverRejection): string =>
  `${cause}${index === null ? '' : ` (operation ${String(index)})`}: ${message}`

const previousAttempt = (transaction: Transaction, batch: readonly Queued[]): ObserverInput['previous_attempt'] => {
  const calls = new Set(batch.flatMap(({ pending }) => (pending.observer_call === null ? [] : [pending.observer_call])))
  const latest = [...calls]
    .flatMap((id) => {
      const call = transaction.observerCalls.get(id)
      return call?.verdict === 'rejected' ? [call] : []
    })
    .reduce<StoredObserverCall | null>(
      (newest, call) => (newest === null || call.started_at > newest.started_at ? call : newest),
      null,
    )
  return latest === null ? null : { reasons: latest.reasons.map(describeRejection) }
}

const positive = (limits: BatchLimits): boolean =>
  [limits.facts, limits.bytes, limits.textLength].every((value) => Number.isSafeInteger(value) && value > 0)

export const startObserverBatch = (transaction: Transaction, start: ObserverBatchStart): ObserverInput | null => {
  const { run, backend, crossVendor, id, at, limits } = start
  if (!positive(limits)) {
    throw new RangeError('batch limits must be positive integers')
  }
  const entity = transaction.model.entity(run, { kind: 'run', id: run })
  if (entity?.kind !== 'run') {
    return null
  }
  const scope = inputScope(transaction, { run, backend, crossVendor })
  const queued = transaction.interpretations.pending(run).flatMap((pending): Queued[] => {
    const fact = transaction.facts.get(pending.fact)
    return fact === null ? [] : [{ pending, fact }]
  })
  const batch = select(exclude(transaction, scope, queued, at), limits)
  if (batch.length === 0) {
    return null
  }
  const input: ObserverInput = {
    run: describeRun(transaction, scope, entity.value),
    context: null,
    model: snapshotOf(transaction, run),
    batch: {
      facts: batch.map(({ fact }) => inputFact(transaction, scope, fact, limits.textLength)),
      collapsed: [],
      backlog: null,
      artifact_versions: [],
    },
    materials: [],
    previous_attempt: previousAttempt(transaction, batch),
  }
  beginObserverCall(transaction, { id, backend, crossVendor, input, at })
  return input
}
