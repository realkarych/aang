import {
  type Action,
  type ActionId,
  type Agent,
  type AttentionItem,
  type AgentId,
  type ArtifactVersion,
  type BacklogSummary,
  type EpochNs,
  type Fact,
  type GapKey,
  type InputArtifactVersion,
  type InputFact,
  JsonValue,
  type ModelEntity,
  type ModelSnapshot,
  type ObserverCallId,
  type ObserverInput,
  type ObserverRejection,
  type Run,
  type RunContext,
  type RunDescription,
  type RunId,
  type Runtime,
  type Session,
  type SessionId,
  type SnapshotAttentionItem,
  type SnapshotStage,
  type Stage,
  type StageId,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { PendingFact, StoredObserverCall, Transaction } from '@aang/store'
import { interpretable } from '../ingest/queue.js'
import { beginObserverCall } from '../model/observer.js'
import { batchFacts } from '../model/observer-context.js'
import { deferFacts } from '../model/observer-queue.js'
import { compareText } from '../observations/evidence.js'
import { collapseRoutine } from './collapse.js'
import {
  clipAttempt,
  clipRun,
  clipSnapshot,
  firstCallTokens,
  longestStateText,
  type Packing,
  packInput,
} from './fit.js'
import { type Clipped, clipContext, clipJson, isoTime } from './materials.js'
import { factSession, type InputScope, inputScope, type ScopeExclusion, type ScopeReader } from './scope.js'

export interface BatchLimits {
  readonly facts: number
  readonly bytes: number
  readonly textLength: number
  readonly inputTokens: number
}

export interface ObserverBatchStart {
  readonly run: RunId
  readonly backend: Runtime
  readonly crossVendor: boolean
  readonly id: ObserverCallId
  readonly at: EpochNs
  readonly limits: BatchLimits
  readonly context?: RunContext | null
  readonly catchUpMs?: number
}

interface Queued {
  readonly pending: PendingFact
  readonly fact: Fact
}

interface Described {
  readonly fact: Fact
  readonly action: Action | null
  readonly agent: AgentId | null
  readonly payload: JsonValue
}

interface Prepared extends Described {
  readonly queued: Queued
}

interface Excluded {
  readonly fact: Fact
}

interface Summarized {
  readonly fact: Fact
  readonly agent: AgentId | null
  readonly tool: string
}

interface Selection {
  readonly batch: Queued[]
  readonly deferral: string | null
}

const nanosecondsPerMillisecond = 1_000_000n

export const jsonOf = (value: unknown): JsonValue =>
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

export const describeRun = (transaction: Pick<ScopeReader, 'observations'>, scope: InputScope, run: Run): RunDescription => {
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

export const snapshotStage = (stage: Stage, parent: StageId | null): SnapshotStage => ({
  id: stage.id,
  title: stage.title,
  expected_result: stage.expected_result,
  summary: stage.summary,
  parent,
  origin: stage.origin,
  execution: stage.execution.value,
  decision: stage.decision.value,
})

export const snapshotAttentionItem = (item: AttentionItem, stage: StageId | null): SnapshotAttentionItem => ({
  id: item.id,
  kind: item.kind,
  author: item.author,
  text: item.text,
  stage,
  runtime_wait: item.runtime_wait,
  resolution: item.resolution,
  likely_resolved: item.likely_resolved !== null,
})

export const snapshotOf = (transaction: Pick<ScopeReader, 'model'>, scope: InputScope): ModelSnapshot => {
  const entities = transaction.model.entities(scope.run).filter((entity) => admitted(scope, entity))
  const stages = new Set(entities.flatMap((entity) => (entity.kind === 'stage' ? [entity.value.id] : [])))
  const stageOf = (id: StageId | null): StageId | null => (id !== null && stages.has(id) ? id : null)
  return {
    version: transaction.model.head(scope.run),
    stages: entities.flatMap((entity) =>
      entity.kind === 'stage' ? [snapshotStage(entity.value, stageOf(entity.value.parent))] : [],
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
      entity.kind === 'attention_item' ? [snapshotAttentionItem(entity.value, stageOf(entity.value.stage))] : [],
    ),
  }
}

const actionOf = (transaction: Pick<ScopeReader, 'observations'>, scope: InputScope, fact: Fact): Action | null => {
  const key = fact.entity_key
  const action = key.kind === 'action' ? transaction.observations.getAction(objectId(key)) : null
  return action !== null && scope.action(action) === null ? action : null
}

const agentOf = (scope: InputScope, fact: Fact, action: Action | null): AgentId | null => {
  const key = fact.entity_key
  const agent = key.kind === 'agent' ? objectId(key) : (action?.agent ?? null)
  return agent !== null && scope.agent(agent) === null ? agent : null
}

const describe = (reader: Pick<ScopeReader, 'observations'>, scope: InputScope, fact: Fact): Described => {
  const action = actionOf(reader, scope, fact)
  return {
    fact,
    action,
    agent: agentOf(scope, fact, action),
    payload: jsonOf(fact.payload),
  }
}

const retainedKinds: ReadonlySet<ArtifactVersion['retention']['kind']> = new Set(['action_payload', 'file_read', 'commit'])

const producedVersions = (versions: readonly ArtifactVersion[], chosen: readonly Prepared[]): InputArtifactVersion[] => {
  const actions = new Set<ActionId>(chosen.flatMap(({ action }) => (action === null ? [] : [action.id])))
  return versions
    .filter(({ produced_by: producer }) => producer !== null && actions.has(producer))
    .map(({ id, ref, produced_by: producer, retention }) => ({
      id,
      ref,
      produced_by: producer,
      retained: retainedKinds.has(retention.kind),
    }))
    .sort((left, right) => compareText(left.id, right.id))
}

const prepare = (reader: Pick<ScopeReader, 'observations'>, scope: InputScope, queued: Queued): Prepared => ({
  ...describe(reader, scope, queued.fact),
  queued,
})

const omittedPayload = (payload: JsonValue): Clipped<JsonValue> => ({
  value: null,
  truncated: [{ path: 'payload', length: JSON.stringify(payload).length }],
})

const inputFact = ({ fact, action, agent, payload }: Described, textLength: number, omitted: boolean): InputFact => {
  const clipped = omitted ? omittedPayload(payload) : clipJson(payload, 'payload', textLength)
  return {
    id: fact.id,
    seq: fact.seq,
    kind: fact.kind,
    speaker: fact.speaker,
    at: isoTime(fact.at),
    urgent: fact.urgent,
    session: factSession(fact),
    agent,
    action: action?.id ?? null,
    payload: clipped.value,
    truncated: clipped.truncated,
  }
}

export const factInput = (
  reader: Pick<ScopeReader, 'observations'>,
  scope: InputScope,
  fact: Fact,
  textLength: number,
): InputFact => inputFact(describe(reader, scope, fact), textLength, false)

const openGap = (
  transaction: Transaction,
  scope: InputScope,
  session: SessionId,
  gap: Extract<GapKey['gap'], 'cross_vendor_excluded' | 'not_interpreted'>,
  details: string,
  at: EpochNs,
): void => {
  const key: GapKey = { kind: 'gap', gap, subject: `${scope.run}:${session}` }
  const stored = transaction.gaps.get(objectId(key))
  if (stored === null || stored.closed_at !== null) {
    transaction.gaps.save({ key, run: scope.run, session, stream: null, details, detected_at: at, closed_at: null })
  }
}

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
    const crossVendor = reason === 'cross_vendor'
    openGap(
      transaction,
      scope,
      session,
      crossVendor ? 'cross_vendor_excluded' : 'not_interpreted',
      crossVendor
        ? `facts of this session are not sent to the ${scope.backend} observer without observer.crossVendor`
        : 'facts of this session are outside the run of the observer queue',
      at,
    )
  }
  return kept
}

const admittedContext = (transaction: Transaction, scope: InputScope, context: RunContext | null): RunContext | null => {
  const record = context === null ? null : transaction.rawRecords.get(context.seq)
  return record !== null && scope.record(record) === null ? context : null
}

const summarizedOf = (fact: Fact, action: Action | null, agent: AgentId | null): Summarized => ({
  fact,
  agent,
  tool: action?.tool ?? fact.kind,
})

const backlogOf = (entries: readonly Summarized[]): BacklogSummary | null => {
  const [first] = entries
  if (first === undefined) {
    return null
  }
  const agents = new Map<AgentId | null, Map<string, number>>()
  let from = first.fact.at
  let to = first.fact.at
  for (const { fact, agent, tool } of entries) {
    const tools = agents.get(agent) ?? new Map<string, number>()
    tools.set(tool, (tools.get(tool) ?? 0) + 1)
    agents.set(agent, tools)
    from = fact.at < from ? fact.at : from
    to = fact.at > to ? fact.at : to
  }
  return {
    from: isoTime(from),
    to: isoTime(to),
    facts: entries.length,
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

const joinAttempts = (attempts: readonly ObserverInput['previous_attempt'][]): ObserverInput['previous_attempt'] => {
  const known = attempts.filter((attempt) => attempt !== null)
  return known.length === 0 ? null : { reasons: [...new Set(known.flatMap(({ reasons }) => reasons))] }
}

const positive = (values: readonly number[]): boolean => values.every((value) => Number.isSafeInteger(value) && value > 0)

const catchUp = (
  transaction: Transaction,
  { run, at, limits, catchUpMs }: ObserverBatchStart,
  queued: readonly Queued[],
): Selection => {
  const oldest = queued.reduce((earliest, { pending }) => (pending.observed_at < earliest ? pending.observed_at : earliest), at)
  if (catchUpMs === undefined || at - oldest <= BigInt(catchUpMs) * nanosecondsPerMillisecond) {
    return { batch: select(queued, limits), deferral: null }
  }
  const batch = select(queued.toReversed(), limits).toReversed()
  const earlier = queued.slice(0, queued.length - batch.length).map(({ fact }) => fact.id)
  const deferral = `facts that waited longer than ${String(catchUpMs)} ms for the observer are summarized`
  if (earlier.length > 0) {
    deferFacts(transaction, { run, facts: earlier, at, details: deferral })
  }
  return { batch, deferral }
}

const summaryOf = (transaction: Transaction, scope: InputScope, at: EpochNs): Summarized[] =>
  exclude(
    transaction,
    scope,
    transaction.interpretations.unsummarized(scope.run).flatMap((id) => {
      const fact = transaction.facts.get(id)
      return fact === null ? [] : [{ fact }]
    }),
    at,
  ).map(({ fact }) => {
    const action = actionOf(transaction, scope, fact)
    return summarizedOf(fact, action, agentOf(scope, fact, action))
  })

export const startObserverBatch = (transaction: Transaction, start: ObserverBatchStart): ObserverInput | null => {
  const { run, backend, crossVendor, id, at, limits, catchUpMs } = start
  if (!positive([limits.facts, limits.bytes, limits.textLength, limits.inputTokens, ...(catchUpMs === undefined ? [] : [catchUpMs])])) {
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
  transaction.interpretations.withdraw(run, queued.flatMap(({ fact }) => (interpretable(fact) ? [] : [fact.id])))
  const { batch, deferral } = catchUp(transaction, start, exclude(transaction, scope, queued.filter(({ fact }) => interpretable(fact)), at))
  const summarized = summaryOf(transaction, scope, at)
  if (batch.length === 0 && summarized.length === 0) {
    return null
  }
  const retried = summaryAttempt(transaction, run)
  const description = describeRun(transaction, scope, entity.value)
  const model = snapshotOf(transaction, scope)
  const context = admittedContext(transaction, scope, start.context ?? null)
  const prepared = batch.map((queued) => prepare(transaction, scope, queued))
  const behind = deferral !== null
  const chosenOf = (count: number): Prepared[] => (behind ? prepared.slice(prepared.length - count) : prepared.slice(0, count))
  const backlogFor = (count: number): BacklogSummary | null =>
    backlogOf([
      ...summarized,
      ...(behind ? prepared.slice(0, prepared.length - count) : []).map(({ queued: { fact }, action, agent }) =>
        summarizedOf(fact, action, agent),
      ),
    ])
  const attempt = (chosen: readonly Queued[], backlog: BacklogSummary | null): ObserverInput['previous_attempt'] =>
    joinAttempts([previousAttempt(transaction, chosen), backlog === null ? null : retried])
  const versions = transaction.artifacts.versions(run)
  const render =
    (omitted: boolean) =>
    ({ count, batchText, stateText }: Packing): ObserverInput => {
      const chosen = chosenOf(count)
      const backlog = backlogFor(count)
      const { facts, collapsed } = collapseRoutine(
        chosen.map((entry) => ({ fact: entry.queued.fact, input: inputFact(entry, batchText, omitted), action: entry.action })),
      )
      return {
        run: clipRun(description, stateText),
        context: clipContext(context, batchText),
        model: clipSnapshot(model, stateText),
        batch: {
          facts: facts.map(({ input }) => input),
          collapsed,
          backlog,
          artifact_versions: producedVersions(versions, chosen),
        },
        materials: [],
        previous_attempt: clipAttempt(attempt(chosen.map(({ queued }) => queued), backlog), stateText),
      }
    }
  const longest = longestStateText({ run: description, model, previous_attempt: joinAttempts([previousAttempt(transaction, batch), retried]) })
  const pack = (count: number, omitted: boolean): ObserverInput | null =>
    packInput(
      { count, minimumCount: 1, batchText: limits.textLength, stateText: longest },
      firstCallTokens(limits.inputTokens),
      render(omitted),
    )
  const input = pack(prepared.length, false) ?? pack(1, true)
  if (input === null) {
    return null
  }
  const sent = new Set(batchFacts(input))
  const left = behind ? batch.flatMap(({ fact }) => (sent.has(fact.id) ? [] : [fact.id])) : []
  if (behind && left.length > 0) {
    deferFacts(transaction, { run, facts: left, at, details: deferral })
  }
  beginObserverCall(transaction, { id, backend, crossVendor, input, at })
  transaction.interpretations.summarize(run, id, [...summarized.map(({ fact }) => fact.id), ...left])
  return input
}
