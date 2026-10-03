import {
  type Agent,
  type AttentionCounts,
  type AttentionItem,
  AttentionKind,
  type Execution,
  type Freshness,
  type ObserverRunState,
  type Run,
  type RunSummary,
  type Session,
  SupportMode,
} from '@aang/contract'
import type { InterpretationQueue, ObserverCallProgress } from '@aang/store'
import { latest, type ModelParts, origin, type ReadContext } from './context.js'

export interface RunState {
  readonly run: Run
  readonly parts: ModelParts
  readonly sessions: readonly Session[]
  readonly agents: readonly Agent[]
}

const executionOrder = [
  'running',
  'waiting:human',
  'waiting:background',
  'waiting:unknown',
  'waiting:idle',
  'failed',
  'cancelled',
  'unknown',
  'planned',
  'done',
]

const executionRank = (execution: Execution): number =>
  executionOrder.indexOf(execution.state === 'waiting' ? `waiting:${execution.reason}` : execution.state)

const freshnessOrder: readonly Freshness[] = ['lost', 'hooks_inactive', 'quiet', 'ok']

const runExecution = (sessions: readonly Session[]): Execution =>
  sessions
    .map(({ execution }) => execution)
    .reduce<Execution>((shown, execution) => (executionRank(execution) < executionRank(shown) ? execution : shown), {
      state: 'unknown',
    })

const runFreshness = (sessions: readonly Session[]): Freshness =>
  freshnessOrder.find((freshness) => sessions.some((session) => session.freshness === freshness)) ?? 'ok'

const attentionCounts = (items: readonly AttentionItem[]): AttentionCounts => {
  const open = items.filter(({ resolution }) => resolution === 'open')
  return {
    open: open.length,
    waiting_for_human: open.filter(({ runtime_wait: wait }) => wait === 'active').length,
    by_kind: Object.fromEntries(
      AttentionKind.options.map((kind) => [kind, open.filter((item) => item.kind === kind).length]),
    ) as AttentionCounts['by_kind'],
  }
}

const observerState = (
  { observer }: ReadContext,
  run: Run,
  queue: InterpretationQueue,
  progress: ObserverCallProgress,
): ObserverRunState => {
  const status = observer(run)
  return {
    state: status.state,
    pending_facts: queue.pending,
    deferred_facts: queue.deferred,
    not_interpreted_facts: queue.not_interpreted,
    oldest_pending_at: queue.oldest_pending_at,
    last_success_at: progress.last_accepted_at,
    isolation_unverified: status.isolation_unverified,
  }
}

export const summaryOf = (context: ReadContext, state: RunState): RunSummary => {
  const { store } = context
  const { run, parts, sessions, agents } = state
  const head = store.model.head(run.id)
  const progress = store.observerCalls.progress(run.id)
  const changed = [
    store.model.version(run.id, head)?.change_seq ?? origin,
    progress.change_seq ?? origin,
    ...[...sessions, ...agents].map(({ change_seq: seq }) => seq),
  ]
  const forked = parts.links.find((link) => link.kind === 'forked_from')
  return {
    id: run.id,
    runtime: run.runtime,
    root_session: run.root_session,
    goal: run.goal?.text ?? null,
    brief: run.brief?.text ?? null,
    version: head,
    execution: runExecution(sessions),
    freshness: runFreshness(sessions),
    support_modes: SupportMode.options.filter((mode) => sessions.some(({ support_mode: own }) => own === mode)),
    sessions: sessions.length,
    agents: agents.length,
    attention: attentionCounts(parts.attention),
    observer: observerState(context, run, store.interpretations.queueOf(run.id), progress),
    forked_from: forked?.kind === 'forked_from' ? forked.parent : null,
    start_pruned: run.start_pruned,
    created_at: run.created_at,
    last_event_at: latest(sessions.map(({ last_event_at: at }) => at)) ?? run.created_at,
    change_seq: changed.reduce((top, seq) => (seq > top ? seq : top), origin),
  }
}
