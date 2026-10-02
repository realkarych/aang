import type { AgentKey, AgentStartPayload, QuestionKey, SessionKey } from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { ObservationDraft, Transaction } from '@aang/store'
import {
  agentKey,
  byContent,
  byTime,
  compareText,
  entityEvidence,
  type Evidence,
  grouped,
  isFile,
  ofKind,
  sessionEvidence,
} from './evidence.js'
import { projectActions } from './actions.js'
import { redeliveries, registrationOf } from './redelivery.js'

const projectAgent = (transaction: Transaction, key: AgentKey, items: readonly Evidence[]): void => {
  const starts = ofKind(items, 'agent_start')
  const ends = ofKind(items, 'agent_end')
  const content = starts.toSorted(byContent)
  const start = content[0]?.fact
  const field = <K extends keyof AgentStartPayload>(name: K): AgentStartPayload[K] | null =>
    content.find(({ fact }) => fact.payload[name] !== null)?.fact.payload[name] ?? null
  const end = ends.toSorted(byContent)[0]?.fact
  const id = objectId(key)
  const previous = transaction.observations.getAgent(id)
  const parent = field('parent')
  const spawnedBy = field('spawned_by_call')
  const main = key.agent.kind === 'main'
  const service = key.agent.kind === 'service' ? key.agent.service : null
  const role =
    start?.payload.role ??
    (main ? 'main' : service !== null ? 'service' : key.agent.kind === 'teammate' ? 'teammate' : 'subagent')
  const draft: ObservationDraft = {
    id,
    key,
    session: objectId({ kind: 'session', runtime: key.runtime, session: key.session }),
    run: previous?.run ?? null,
    role,
    service: field('service') ?? service,
    agent_type: field('agent_type') ?? end?.payload.agent_type ?? null,
    agent_role: field('agent_role'),
    name: field('nickname') ?? (key.agent.kind === 'teammate' ? key.agent.name : null),
    description: field('description'),
    parent: parent === null ? null : objectId({ ...key, agent: parent }),
    spawned_by:
      spawnedBy === null
        ? null
        : objectId({ kind: 'action', runtime: key.runtime, session: key.session, call: spawnedBy }),
    execution:
      end === undefined
        ? { state: starts.length === 0 ? 'unknown' : 'running' }
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
}

const projectQuestion = (
  transaction: Transaction,
  key: QuestionKey,
  items: readonly Evidence[],
  group: QuestionKey | null,
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
    agent: objectId(agentKey(first)),
    run: previous?.run ?? null,
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

export const projectSession = (transaction: Transaction, key: SessionKey): void => {
  const items = sessionEvidence(transaction, key)
  const first = items[0]
  if (first === undefined) {
    return
  }
  const root = items.filter(({ fact }) => agentKey(fact).agent.kind === 'main')
  const starts = ofKind(root, 'session_start')
  const content = root.toSorted(byContent)
  const id = objectId(key)
  const previous = transaction.observations.getSession(id)
  const hooks = items.some(({ raw }) => raw.channel === 'hook')
  const files = items.some(isFile)
  const registrations = new Set(items.map(registrationOf).filter((value) => value !== null))
  const surface =
    starts
      .toSorted(
        (left, right) =>
          Number(right.fact.payload.surface?.basis === 'observed') -
            Number(left.fact.payload.surface?.basis === 'observed') || byContent(left, right),
      )
      .find(({ fact }) => fact.payload.surface !== null)?.fact.payload.surface ?? null
  const draft: ObservationDraft = {
    id,
    key,
    run: previous?.run ?? null,
    surface,
    version: content.find(({ fact }) => fact.runtime_env.version !== null)?.fact.runtime_env.version ?? null,
    cwd:
      starts.find(({ fact }) => fact.payload.cwd !== null)?.fact.payload.cwd ??
      root.find(({ fact }) => fact.runtime_env.cwd !== null)?.fact.runtime_env.cwd ??
      null,
    git_branch:
      content.find(({ fact }) => fact.runtime_env.git_branch !== null)?.fact.runtime_env.git_branch ?? null,
    git_common_dir: previous?.git_common_dir ?? null,
    launches: starts.map(({ fact }) => ({ launch: fact.payload.launch, at: fact.at, fact: fact.id })),
    state: previous?.state ?? 'unknown',
    execution: previous?.execution ?? { state: 'unknown' },
    freshness: previous?.freshness ?? 'ok',
    support_mode: hooks && files ? 'full' : hooks ? 'hooks_only' : 'files_only',
    double_registration: registrations.size > 1,
    unknown_records: previous?.unknown_records ?? 0,
    cost_state: previous?.cost_state ?? null,
    started_at: first.fact.at,
    last_event_at: (items.at(-1) ?? first).fact.at,
  }
  transaction.observations.save(draft)
  for (const agentItems of grouped(items, ({ fact }) => canonicalJson(agentKey(fact))).values()) {
    projectAgent(transaction, agentKey(agentItems[0].fact), agentItems)
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
  projectActions(transaction, key, items)
  for (const [name, entityItems] of entityEvidence(items)) {
    const entity = entityItems[0].fact.entity_key
    if (entity.kind === 'question') {
      projectQuestion(transaction, entity, entityItems, questionGroups.get(name) ?? null)
    }
  }
}
