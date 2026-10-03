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
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { ObservationDraft, Transaction } from '@aang/store'
import { type AgentIdentity, agentIdentity, compactionStop, retireRefined } from './agents.js'
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
import { redeliveries, registrationOf } from './redelivery.js'
import { freshnessOf } from './freshness.js'
import { sourceGaps, type SourceRecord } from './sources.js'
import { turnState } from './state.js'
import { linkSession, type Spawn, sessionRun } from './runs.js'

interface SessionContext {
  readonly run: RunId
  readonly identity: AgentIdentity
  readonly spawners: ReadonlyMap<string, KindEvidence<'action_start'>>
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
  { run, identity, spawners }: SessionContext,
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
  const previous = transaction.observations.getAgent(id)
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
        ? status.state === 'unknown' ? { state: starts.length === 0 ? 'unknown' : 'running' } : status.execution
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
    thread_total: previous?.thread_total ?? null,
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
  group: QuestionKey | null,
  { run, identity }: SessionContext,
): void => {
  const request = ofKind(items, 'permission_request')[0]?.fact
  const asked = ofKind(items, 'question_asked').toSorted(byContent)[0]?.fact
  const opening = request ?? asked
  if (opening === undefined) {
    return
  }
  const first = [...ofKind(items, 'permission_request'), ...ofKind(items, 'question_asked')].sort(byTime)[0]
    ?.fact
  if (first === undefined) {
    return
  }
  const id = objectId(key)
  const previous = transaction.observations.getQuestion(id)
  transaction.observations.save({
    id,
    key,
    session: objectId({ kind: 'session', runtime: key.runtime, session: key.session }),
    agent: objectId(identity.of(first)),
    run,
    kind: request === undefined ? (asked?.payload.source ?? 'permission') : 'permission',
    blocking: request !== undefined || asked?.payload.blocking === true,
    text: asked?.payload.questions.map(({ text }) => text).join('\n') ?? null,
    asked_at: first.at,
    answered_at: previous?.answered_at ?? null,
    action: previous?.action ?? null,
    decision:
      previous === null || previous.decision.value === 'requested'
        ? { value: 'requested', basis: { kind: 'observed' }, evidence: [opening.id] }
        : previous.decision,
    redelivery_group: group === null ? null : objectId(group),
  })
}

export const projectSession = (
  transaction: Transaction,
  key: SessionKey,
  records: readonly SourceRecord[],
  lost: ReadonlySet<SessionId>,
  now: EpochNs,
  quietAfterMs: number,
): Omit<Session, 'change_seq'> | null => {
  const items = sessionEvidence(transaction, key)
  const id = objectId(key)
  const previous = transaction.observations.getSession(id)
  if (items.length === 0 && records.length === 0 && previous === null) {
    return null
  }
  const identity = agentIdentity(key, items)
  const context: SessionContext = { run: sessionRun(transaction, key), identity, spawners: spawnersOf(items) }
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
    ...records.map(({ raw }) => raw.source_ts ?? raw.observed_at),
    ...(previous === null ? [] : [previous.started_at, previous.last_event_at]),
  ].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  const startedAt = times[0]
  const lastEventAt = times.at(-1)
  if (startedAt === undefined || lastEventAt === undefined) { return null }
  const status = turnState(root, items)
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
    unknown_records: (previous?.unknown_records ?? 0) + records.filter(({ raw }) => raw.parse_state !== 'parsed').length,
    cost_state: previous?.cost_state ?? null,
    started_at: startedAt,
    last_event_at: lastEventAt,
  }
  sourceGaps(transaction, draft, lastEventAt)
  const session = { ...draft, freshness: freshnessOf(draft, lost.has(id), now, quietAfterMs) }
  transaction.observations.save(session)
  const spawns: Spawn[] = []
  for (const agentItems of grouped(items, ({ fact }) => canonicalJson(identity.of(fact))).values()) {
    const agent = identity.of(agentItems[0].fact)
    const spawn = compactionStop(agent, agentItems)
      ? null
      : projectAgent(transaction, agent, agentItems, context, status.execution)
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
  projectActions(transaction, key, items, context)
  for (const [name, entityItems] of entityEvidence(items)) {
    const entity = entityItems[0].fact.entity_key
    if (entity.kind === 'question') {
      projectQuestion(transaction, entity, entityItems, questionGroups.get(name) ?? null, context)
    }
  }
  const replacements = retireRefined(transaction, identity)
  const first = items[0]
  const last = items.at(-1)
  if (first !== undefined && last !== undefined) {
    linkSession(transaction, { key, run: context.run, root: first.fact, at: last.fact.at, spawns, replacements })
  }
  return session
}
