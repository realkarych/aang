import {
  type Action,
  type Agent,
  type AgentId,
  type BacklogSummary,
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
  type StageId,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { PendingFact, StoredObserverCall, Transaction } from '@aang/store'
import { beginObserverCall } from '../model/observer.js'
import { deferFacts } from '../model/observer-queue.js'
import { compareText } from '../observations/evidence.js'
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
  readonly catchUpMs?: number
}

interface Queued {
  readonly pending: PendingFact
  readonly fact: Fact
}

interface Excluded {
  readonly fact: Fact
}

const nanosecondsPerMillisecond = 1_000_000n

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
  const owner = { kind: 'run', id: run.id } as const
  return {
    id: run.id,
    runtime: run.runtime,
    goal: run.goal !== null && scope.grounds([run.goal.fact], owner) === null ? run.goal.text : null,
    brief: run.brief !== null && scope.grounds(run.brief.evidence, owner) === null ? run.brief.text : null,
    sessions: sessions.map(sessionBrief),
    agents: sessions
      .flatMap((session) => transaction.observations.agents(session.id))
      .filter((agent) => scope.agent(agent.id) === null)
      .map((agent) => agentBrief(scope, agent)),
  }
}

const admitted = (scope: InputScope, entity: ModelEntity): boolean => {
  switch (entity.kind) {
    case 'stage':
      return entity.value.lifecycle.state === 'active' && scope.entity({ kind: 'stage', id: entity.value.id }) === null
    case 'criterion':
      return scope.entity({ kind: 'criterion', id: entity.value.id }) === null
    case 'attention_item':
      return entity.value.resolution === 'open' && scope.entity({ kind: 'attention_item', id: entity.value.id }) === null
    default:
      return false
  }
}

const snapshotOf = (transaction: Transaction, scope: InputScope): ModelSnapshot => {
  const entities = transaction.model.entities(scope.run).filter((entity) => admitted(scope, entity))
  const stages = new Set(entities.flatMap((entity) => (entity.kind === 'stage' ? [entity.value.id] : [])))
  const stageOf = (id: StageId | null): StageId | null => (id !== null && stages.has(id) ? id : null)
  return {
    version: transaction.model.head(scope.run),
    stages: entities.flatMap((entity) =>
      entity.kind === 'stage'
        ? [
            {
              id: entity.value.id,
              title: entity.value.title,
              expected_result: entity.value.expected_result,
              summary: entity.value.summary,
              parent: stageOf(entity.value.parent),
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
              stage: stageOf(entity.value.stage),
              text: entity.value.text,
              source: entity.value.source,
              status: entity.value.status.value,
            },
          ]
        : [],
    ),
    attention: entities.flatMap((entity) =>
      entity.kind === 'attention_item'
        ? [
            {
              id: entity.value.id,
              kind: entity.value.kind,
              author: entity.value.author,
              text: entity.value.text,
              stage: stageOf(entity.value.stage),
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

const agentOf = (scope: InputScope, fact: Fact, action: Action | null): AgentId | null => {
  const key = fact.entity_key
  const agent = key.kind === 'agent' ? objectId(key) : (action?.agent ?? null)
  return agent !== null && scope.agent(agent) === null ? agent : null
}

const inputFact = (transaction: Transaction, scope: InputScope, fact: Fact, textLength: number): InputFact => {
  const action = actionOf(transaction, scope, fact)
  const payload = clipJson(jsonOf(fact.payload), 'payload', textLength)
  return {
    id: fact.id,
    seq: fact.seq,
    kind: fact.kind,
    speaker: fact.speaker,
    at: isoTime(fact.at),
    urgent: fact.urgent,
    session: factSession(fact),
    agent: agentOf(scope, fact, action),
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

const exclude = <T extends Excluded>(transaction: Transaction, scope: InputScope, queued: readonly T[], at: EpochNs): T[] => {
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

const backlogOf = (transaction: Transaction, scope: InputScope, facts: readonly Fact[]): BacklogSummary | null => {
  const [first] = facts
  if (first === undefined) {
    return null
  }
  const agents = new Map<AgentId | null, Map<string, number>>()
  let from = first.at
  let to = first.at
  for (const fact of facts) {
    const action = actionOf(transaction, scope, fact)
    const agent = agentOf(scope, fact, action)
    const tools = agents.get(agent) ?? new Map<string, number>()
    const tool = action?.tool ?? fact.kind
    tools.set(tool, (tools.get(tool) ?? 0) + 1)
    agents.set(agent, tools)
    from = fact.at < from ? fact.at : from
    to = fact.at > to ? fact.at : to
  }
  return {
    from: isoTime(from),
    to: isoTime(to),
    facts: facts.length,
    agents: [...agents]
      .toSorted(([left], [right]) => compareText(left ?? '', right ?? ''))
      .map(([agent, tools]) => ({
        agent,
        facts: [...tools.values()].reduce((total, count) => total + count, 0),
        tools: [...tools]
          .toSorted(([left], [right]) => compareText(left, right))
          .map(([tool, count]) => ({ tool, count })),
      })),
  }
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

const attemptOf = (call: StoredObserverCall): ObserverInput['previous_attempt'] =>
  call.verdict === 'rejected' ? { reasons: call.reasons.map(describeRejection) } : call.input.previous_attempt

const previousAttempt = (transaction: Transaction, batch: readonly Queued[]): ObserverInput['previous_attempt'] => {
  const calls = new Set(batch.flatMap(({ pending }) => (pending.observer_call === null ? [] : [pending.observer_call])))
  const [latest] = [...calls]
    .flatMap((id) => transaction.observerCalls.get(id) ?? [])
    .toSorted((left, right) => Number(right.started_at - left.started_at))
    .map(attemptOf)
    .filter((attempt) => attempt !== null)
  return latest ?? null
}

const summaryAttempt = (transaction: Transaction, run: RunId): ObserverInput['previous_attempt'] => {
  const latest = transaction.observerCalls.latest(run)
  const call = latest === null ? null : transaction.observerCalls.get(latest.id)
  return call === null || call.verdict === 'accepted' || call.input.batch.backlog === null ? null : attemptOf(call)
}

const positive = (values: readonly number[]): boolean => values.every((value) => Number.isSafeInteger(value) && value > 0)

const catchUp = (
  transaction: Transaction,
  { run, at, limits, catchUpMs }: ObserverBatchStart,
  queued: readonly Queued[],
): Queued[] => {
  const oldest = queued.reduce((earliest, { pending }) => (pending.observed_at < earliest ? pending.observed_at : earliest), at)
  if (catchUpMs === undefined || at - oldest <= BigInt(catchUpMs) * nanosecondsPerMillisecond) {
    return select(queued, limits)
  }
  const batch = select(queued.toReversed(), limits).toReversed()
  const earlier = queued.slice(0, queued.length - batch.length).map(({ fact }) => fact.id)
  if (earlier.length > 0) {
    deferFacts(transaction, {
      run,
      facts: earlier,
      at,
      details: `facts that waited longer than ${String(catchUpMs)} ms for the observer are summarized`,
    })
  }
  return batch
}

const summaryOf = (transaction: Transaction, scope: InputScope, at: EpochNs): Fact[] =>
  exclude(
    transaction,
    scope,
    transaction.interpretations.unsummarized(scope.run).flatMap((id) => {
      const fact = transaction.facts.get(id)
      return fact === null ? [] : [{ fact }]
    }),
    at,
  ).map(({ fact }) => fact)

export const startObserverBatch = (transaction: Transaction, start: ObserverBatchStart): ObserverInput | null => {
  const { run, backend, crossVendor, id, at, limits, catchUpMs } = start
  if (!positive([limits.facts, limits.bytes, limits.textLength, ...(catchUpMs === undefined ? [] : [catchUpMs])])) {
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
  const batch = catchUp(transaction, start, exclude(transaction, scope, queued, at))
  const summarized = summaryOf(transaction, scope, at)
  if (batch.length === 0 && summarized.length === 0) {
    return null
  }
  const input: ObserverInput = {
    run: describeRun(transaction, scope, entity.value),
    context: null,
    model: snapshotOf(transaction, scope),
    batch: {
      facts: batch.map(({ fact }) => inputFact(transaction, scope, fact, limits.textLength)),
      collapsed: [],
      backlog: backlogOf(transaction, scope, summarized),
      artifact_versions: [],
    },
    materials: [],
    previous_attempt: batch.length > 0 ? previousAttempt(transaction, batch) : summaryAttempt(transaction, run),
  }
  beginObserverCall(transaction, { id, backend, crossVendor, input, at })
  transaction.interpretations.summarize(
    run,
    id,
    summarized.map(({ id: fact }) => fact),
  )
  return input
}
