import type {
  Basis,
  EpochNs,
  Link,
  ModelEntityRef,
  RunId,
  Session,
  SessionId,
  Stage,
  StageId,
} from '@aang/contract'
import type { Transaction } from '@aang/store'
import { applyChangeSet, type ModelChangeDraft, type ModelEntityDraft } from '../model/journal.js'
import { endObserverCalls } from '../model/observer.js'
import { compareText } from './evidence.js'
import { refreshForksOf } from './origins.js'
import { sessionRun } from './runs.js'

export interface Transfer {
  readonly session: Session
  readonly to: RunId
  readonly at: EpochNs
}

const observed: Basis = { kind: 'observed' }

const moveIn = (put: ModelEntityDraft): ModelChangeDraft => ({ op: 'session.move', put, basis: observed, evidence: [] })

const moveOut = (remove: ModelEntityRef): ModelChangeDraft => ({
  op: 'session.move',
  remove,
  basis: observed,
  evidence: [],
})

const linksOf = (transaction: Transaction, run: RunId): Link[] =>
  transaction.model
    .entities(run)
    .flatMap((entity) => (entity.kind === 'link' ? [entity.value] : []))
    .sort((left, right) => compareText(left.id, right.id))

const stagesOf = (transaction: Transaction, run: RunId): Map<StageId, Stage> =>
  new Map(
    transaction.model
      .entities(run)
      .flatMap((entity) => (entity.kind === 'stage' ? [[entity.value.id, entity.value] as const] : [])),
  )

const stageMarks = (
  transaction: Transaction,
  run: RunId,
  runOf: (session: SessionId) => RunId | null,
  touched: (link: Link) => boolean,
): ModelChangeDraft[] => {
  const links = linksOf(transaction, run)
  const marked = new Set(links.flatMap((link) => (touched(link) && 'stage' in link ? [link.stage] : [])))
  const outside = (link: Link): boolean => {
    const session =
      link.kind === 'assignment'
        ? transaction.observations.getAction(link.action)?.session
        : link.kind === 'participation'
          ? transaction.observations.getAgent(link.agent)?.session
          : undefined
    return session !== undefined && runOf(session) !== run
  }
  return [...stagesOf(transaction, run).values()].flatMap((stage) => {
    if (!marked.has(stage.id)) {
      return []
    }
    const sessionMoved = links.some((link) => 'stage' in link && link.stage === stage.id && outside(link))
    if (sessionMoved === stage.session_moved) {
      return []
    }
    return [moveIn({ kind: 'stage', value: { ...stage, session_moved: sessionMoved } })]
  })
}

export const transferSession = (transaction: Transaction, { session, to, at }: Transfer): RunId | null => {
  const from = sessionRun(transaction, session.key)
  if (from === to) {
    return null
  }
  const agents = new Set<string>(transaction.observations.agents(session.id).map(({ id }) => id))
  const actions = new Set<string>(transaction.observations.actions(session.id).map(({ id }) => id))
  const runOf = (member: SessionId): RunId | null => {
    if (member === session.id) {
      return to
    }
    const other = transaction.observations.getSession(member)
    return other === null ? null : sessionRun(transaction, other.key)
  }
  const touched = (link: Link): boolean =>
    (link.kind === 'assignment' && actions.has(link.action)) ||
    (link.kind === 'participation' && agents.has(link.agent))
  const spawns = linksOf(transaction, from).filter((link) => link.kind === 'spawn' && agents.has(link.child))
  const membership: ModelEntityRef = { kind: 'session_membership', id: session.id }
  const member = transaction.model.entity(from, membership) !== null
  const leaving = [
    ...(member ? [moveOut(membership)] : []),
    ...spawns.map((link) => moveOut({ kind: 'link', id: link.id })),
    ...stageMarks(transaction, from, runOf, touched),
  ]
  if (leaving.length > 0) {
    applyChangeSet(transaction, { run: from, author: 'rule', at, changes: leaving })
  }
  applyChangeSet(transaction, {
    run: to,
    author: 'rule',
    at,
    changes: [
      moveIn({ kind: 'session_membership', value: { session: session.id, run: to } }),
      ...spawns.map((link) => moveIn({ kind: 'link', value: { ...link, run: to } })),
      ...stageMarks(transaction, to, runOf, touched),
    ],
  })
  refreshForksOf(transaction, from, at)
  const facts = transaction.facts.ofSession(session.key).map(({ id }) => id)
  endObserverCalls(transaction, from, facts, at, `session ${session.id} moved to run ${to} during the call`)
  transaction.interpretations.withdraw(from, facts)
  transaction.interpretations.queue(to, facts)
  return from
}
