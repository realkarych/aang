import type {
  AgentKey,
  AgentStartPayload,
  EpochNs,
  Execution,
  QuestionKey,
  RunId,
  Session,
  SessionId,
  SessionKey,
} from '@aang/contract'
import { canonicalJson, objectId, runId } from '@aang/contract/ids'
import type { ObservationDraft, Transaction } from '@aang/store'
import {
  type AgentIdentity,
  agentIdentity,
  type AgentMoves,
  compactionStop,
  movedAgents,
  retireRefined,
} from './agents.js'
import {
  byContent,
  byTime,
  compareText,
  entityEvidence,
  type Evidence,
  grouped,
  isFile,
  type KindEvidence,
  ofKind,
  sessionEvidence,
} from './evidence.js'
import { projectActions } from './actions.js'
import { exitAfter, type ProcessExit, processExits } from './exits.js'
import { type QuestionAttention, reconcileRuleAttention } from './attention.js'
import { questionOutcome, type SessionFacts, sessionFacts } from './questions.js'
import { redeliveries, registrationOf } from './redelivery.js'
import { freshnessOf } from './freshness.js'
import { sourceGaps, type SourceRecord } from './sources.js'
import { turnState } from './state.js'
import { linkSession, type Spawn, sessionRun } from './runs.js'
import { isFork, isInherited, lineageOf } from './lineage.js'
import { refreshCommonOrigin, refreshForkedFrom, refreshRelatedOrigins } from './origins.js'
import { costStateOf, projectUsage, threadTotalOf } from './usage.js'

interface SessionContext {
  readonly run: RunId
  readonly identity: AgentIdentity
  readonly spawners: ReadonlyMap<string, KindEvidence<'action_start'>>
  readonly fork: boolean
  readonly exits: readonly ProcessExit[]
}

const spawnersOf = (items: readonly Evidence[]): Map<string, KindEvidence<'action_start'>> => {
  const spawners = new Map<string, KindEvidence<'action_start'>>()
  for (const item of ofKind(items, 'action_start').toSorted(byContent)) {
    const key = item.fact.entity_key
    if (key.kind === 'action' && !spawners.has(key.call)) {
      spawners.set(key.call, item)
    }
  }
  return spawners
}

const projectAgent = (
  transaction: Transaction,
  key: AgentKey,
  items: readonly Evidence[],
  { run, identity, spawners, fork, exits }: SessionContext,
  sessionExecution: Execution,
): Spawn | null => {
  const starts = ofKind(items, 'agent_start')
  const ends = ofKind(items, 'agent_end')
  const content = starts.toSorted(byContent)
  const start = content[0]?.fact
  const field = <K extends keyof AgentStartPayload>(name: K): AgentStartPayload[K] | null =>
    content.find(({ fact }) => fact.payload[name] !== null)?.fact.payload[name] ?? null
  const end = ends.toSorted(byContent)[0]?.fact
  const id = objectId(key)
  const named = field('parent')
  const spawnedBy = field('spawned_by_call')
  const spawner = spawnedBy === null ? undefined : spawners.get(spawnedBy)
  const parentKey =
    named !== null ? identity.resolve({ ...key, agent: named }) : spawner === undefined ? null : identity.of(spawner.fact)
  const parent = parentKey === null ? null : objectId(parentKey)
  const main = key.agent.kind === 'main'
  const service = key.agent.kind === 'service' ? key.agent.service : null
  const role =
    key.agent.kind === 'teammate'
      ? 'teammate'
      : (start?.payload.role ?? (main ? 'main' : service !== null ? 'service' : 'subagent'))
  const status = turnState(items)
  const startedAt = starts.toSorted(byTime)[0]?.fact.at ?? items.toSorted(byTime)[0]?.fact.at
  const exited = startedAt !== undefined && exitAfter(exits, startedAt) !== null
  const spawnedByAction =
    spawnedBy === null ? null : objectId({ kind: 'action', runtime: key.runtime, session: key.session, call: spawnedBy })
  const draft: ObservationDraft = {
    id,
    key,
    session: objectId({ kind: 'session', runtime: key.runtime, session: key.session }),
    run,
    role,
    service: field('service') ?? service,
    agent_type: field('agent_type') ?? end?.payload.agent_type ?? null,
    agent_role: field('agent_role'),
    name: field('nickname') ?? (key.agent.kind === 'teammate' ? key.agent.name : null),
    description: field('description'),
    parent,
    spawned_by: spawnedByAction,
    execution:
      main ? sessionExecution : end === undefined
        ? exited || status.state === 'unknown'
          ? { state: exited || starts.length === 0 ? 'unknown' : 'running' }
          : status.execution
        : {
            state:
              end.payload.outcome === 'completed'
                ? 'done'
                : end.payload.outcome === 'failed'
                  ? 'failed'
                  : end.payload.outcome === 'cancelled'
                    ? 'cancelled'
                    : 'unknown',
          },
    thread_total: threadTotalOf(items, fork && main),
    started_at:
      starts.toSorted(byTime)[0]?.fact.at ??
      (main ? (ofKind(items, 'session_start')[0]?.fact.at ?? null) : null),
    ended_at: ends.toSorted(byTime)[0]?.fact.at ?? null,
  }
  transaction.observations.save(draft)
  if (parent === null || parent === id) {
    return null
  }
  const relation = starts
    .filter(({ fact }) => fact.payload.parent !== null || fact.payload.spawned_by_call !== null)
    .map(({ fact }) => fact.id)
  return {
    parent,
    child: id,
    via: spawnedByAction,
    evidence: named === null && spawner !== undefined ? [...relation, spawner.fact.id] : relation,
  }
}

const projectQuestion = (
  transaction: Transaction,
  key: QuestionKey,
  items: readonly Evidence[],
  session: SessionFacts,
  group: QuestionKey | null,
  { run, identity }: SessionContext,
): QuestionAttention | null => {
  const request = ofKind(items, 'permission_request')[0]?.fact
  const asked = ofKind(items, 'question_asked').toSorted(byContent)[0]?.fact
  const first = [...ofKind(items, 'permission_request'), ...ofKind(items, 'question_asked')].sort(byTime)[0]
    ?.fact
  const outcome = questionOutcome(key, items, session, (action) => transaction.observations.getAction(action) !== null)
  if (first === undefined || outcome === null) {
    return null
  }
  const id = objectId(key)
  const question = {
    id,
    key,
    session: objectId({ kind: 'session', runtime: key.runtime, session: key.session }),
    agent: objectId(identity.of(first)),
    run,
    kind: request === undefined ? (asked?.payload.source ?? 'permission') : 'permission',
    blocking: request !== undefined || asked?.payload.blocking === true,
    text: asked?.payload.questions.map(({ text }) => text).join('\n') ?? null,
    asked_at: first.at,
    answered_at: outcome.answered_at,
    action: outcome.link,
    decision: outcome.decision,
    redelivery_group: group === null ? null : objectId(group),
  } satisfies ObservationDraft
  transaction.observations.save(question)
  return { question, outcome }
}

export interface SessionProjection {
  readonly session: Omit<Session, 'change_seq'>
  readonly objects: readonly string[]
}

export interface SessionRebuild {
  readonly unknownRecords: number
  readonly moves: AgentMoves
}

export const projectSession = (
  transaction: Transaction,
  key: SessionKey,
  records: readonly SourceRecord[],
  lost: ReadonlySet<SessionId>,
  now: EpochNs,
  quietAfterMs: number,
  rebuild: SessionRebuild | null = null,
): SessionProjection | null => {
  const evidence = sessionEvidence(transaction, key)
  const lineage = lineageOf(transaction, key, evidence)
  const inherited = isInherited(lineage)
  const items = evidence.filter((item) => !inherited(item))
  const id = objectId(key)
  const previous = transaction.observations.getSession(id)
  if (evidence.length === 0 && records.length === 0 && previous === null) {
    return null
  }
  const identity = agentIdentity(key, items)
  const exits = processExits(items)
  const context: SessionContext = {
    run: sessionRun(transaction, key),
    identity,
    spawners: spawnersOf(items),
    fork: isFork(lineage),
    exits,
  }
  const root = items.filter(({ fact }) => identity.of(fact).agent.kind === 'main')
  const starts = ofKind(root, 'session_start')
  const content = root.toSorted(byContent)
  const hooks = items.some(({ raw }) => raw.channel === 'hook') ||
    records.some(({ raw }) => raw.channel === 'hook') || (previous !== null && previous.support_mode !== 'files_only')
  const files = items.some(isFile) || records.some(({ raw }) => raw.channel === 'transcript' || raw.channel === 'rollout') ||
    (previous !== null && previous.support_mode !== 'hooks_only')
  const registrations = new Set(items.map(registrationOf).filter((value) => value !== null))
  const surface =
    starts
      .toSorted(
        (left, right) =>
          Number(right.fact.payload.surface?.basis === 'observed') -
            Number(left.fact.payload.surface?.basis === 'observed') || byContent(left, right),
      )
      .find(({ fact }) => fact.payload.surface !== null)?.fact.payload.surface ?? null
  const times = [
    ...items.map(({ fact }) => fact.at),
    ...records.flatMap(({ raw }) => (lineage.inherited.has(raw.seq) ? [] : [raw.source_ts ?? raw.observed_at])),
    ...(previous === null ? [] : [previous.started_at, previous.last_event_at]),
  ].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  const startedAt = times[0]
  const lastEventAt = times.at(-1)
  if (startedAt === undefined || lastEventAt === undefined) { return null }
  const lapsed = new Set(exits.flatMap(({ evidence, current }) => (current ? [] : [evidence.fact.id])))
  const status = turnState(root.filter(({ fact }) => !lapsed.has(fact.id)), items)
  const draft: Omit<Session, 'change_seq'> = {
    id,
    key,
    run: items.length === 0 ? (previous?.run ?? null) : context.run,
    surface,
    version: content.find(({ fact }) => fact.runtime_env.version !== null)?.fact.runtime_env.version ?? null,
    cwd:
      starts.find(({ fact }) => fact.payload.cwd !== null)?.fact.payload.cwd ??
      root.find(({ fact }) => fact.runtime_env.cwd !== null)?.fact.runtime_env.cwd ??
      records.find(({ owner }) => owner.thread === 'root' && owner.cwd !== null)?.owner.cwd ??
      previous?.cwd ??
      null,
    git_branch:
      content.find(({ fact }) => fact.runtime_env.git_branch !== null)?.fact.runtime_env.git_branch ?? null,
    git_common_dir: previous?.git_common_dir ?? null,
    launches: starts.map(({ fact }) => ({ launch: fact.payload.launch, at: fact.at, fact: fact.id })),
    ...status,
    freshness: 'ok',
    support_mode: hooks && files ? 'full' : hooks ? 'hooks_only' : 'files_only',
    double_registration: registrations.size > 1 || previous?.double_registration === true,
    unknown_records:
      rebuild?.unknownRecords ??
      (previous?.unknown_records ?? 0) + records.filter(({ raw }) => raw.parse_state !== 'parsed').length,
    cost_state: items.length === 0 ? (previous?.cost_state ?? null) : costStateOf(items),
    started_at: startedAt,
    last_event_at: lastEventAt,
  }
  sourceGaps(transaction, draft, lastEventAt)
  const session = { ...draft, freshness: freshnessOf(draft, lost.has(id), now, quietAfterMs) }
  const projected: string[] = [transaction.observations.save(session).id]
  const spawns: Spawn[] = []
  for (const agentItems of grouped(items, ({ fact }) => canonicalJson(identity.of(fact))).values()) {
    const agent = identity.of(agentItems[0].fact)
    if (compactionStop(agent, agentItems)) {
      continue
    }
    projected.push(objectId(agent))
    const spawn = projectAgent(transaction, agent, agentItems, context, status.execution)
    if (spawn !== null) {
      spawns.push(spawn)
    }
  }
  const groups = redeliveries(items)
  const questionGroups = new Map<string, QuestionKey>()
  for (const group of groups) {
    const members = new Set(group.facts)
    const keys = items
      .flatMap(({ fact }) =>
        members.has(fact.id) && fact.entity_key.kind === 'question' ? [fact.entity_key] : [],
      )
      .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)))
    if (keys[0] !== undefined) {
      for (const question of keys) {
        questionGroups.set(canonicalJson(question), keys[0])
      }
    }
  }
  projected.push(
    ...projectActions(transaction, key, evidence, { run: context.run, identity, inherited: lineage.inherited, exits }),
    ...projectUsage(transaction, evidence, { run: context.run, identity, inherited: lineage.inherited }),
  )
  const facts = sessionFacts(items, exits)
  const questions: QuestionAttention[] = []
  for (const [name, entityItems] of entityEvidence(items)) {
    const entity = entityItems[0].fact.entity_key
    if (entity.kind === 'question') {
      const question = projectQuestion(transaction, entity, entityItems, facts, questionGroups.get(name) ?? null, context)
      if (question !== null) {
        questions.push(question)
        projected.push(question.question.id)
      }
    }
  }
  const replacements = retireRefined(transaction, identity.refinements)
  const moved =
    rebuild === null
      ? []
      : retireRefined(transaction, movedAgents(transaction, key, identity, new Set(projected), rebuild.moves))
  const first = items[0]
  const last = items.at(-1)
  if (first !== undefined && last !== undefined) {
    const at = last.fact.at
    linkSession(transaction, {
      key,
      run: context.run,
      root: first.fact,
      at,
      spawns,
      replacements: [...replacements, ...moved],
    })
    if (key.runtime === 'claude') {
      const batch = new Set(records.map(({ raw }) => raw.seq))
      refreshCommonOrigin(transaction, key, lineage, evidence, at)
      refreshRelatedOrigins(transaction, key, evidence.filter(({ raw }) => batch.has(raw.seq)), at)
    }
    if (lineage.forkedFrom !== null) {
      refreshForkedFrom(transaction, runId(key), lineage.forkedFrom, at)
    }
  }
  reconcileRuleAttention(transaction, key, items.at(-1)?.fact.at ?? lastEventAt, questions)
  return { session, objects: projected }
}
