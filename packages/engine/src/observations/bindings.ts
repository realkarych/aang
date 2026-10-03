import type {
  Basis,
  Binding,
  BindingId,
  CreateBindingRequest,
  EpochNs,
  RunId,
  Session,
  SessionId,
  SessionKey,
} from '@aang/contract'
import { runId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { applyChangeSet } from '../model/journal.js'
import { isFork, type Lineage } from './lineage.js'
import { activeForkParent, refreshForkedFrom, runLineage } from './origins.js'
import { sessionRun } from './runs.js'
import { transferSession } from './transfer.js'

export type BindingErrorCode = 'not_found' | 'invalid_request'

export class BindingError extends Error {
  override readonly name = 'BindingError'

  constructor(
    readonly code: BindingErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface MovedSession {
  readonly session: SessionKey
  readonly from: RunId
}

export interface BindingOutcome {
  readonly binding: Binding
  readonly moved: readonly MovedSession[]
}

type SessionBinding = Extract<Binding, { kind: 'attach' | 'detach' }>

const observed: Basis = { kind: 'observed' }

const requireSession = (transaction: Transaction, id: SessionId): Session => {
  const session = transaction.observations.getSession(id)
  if (session === null) {
    throw new BindingError('not_found', `session ${id} is not observed`)
  }
  return session
}

const requireRun = (transaction: Transaction, run: RunId): void => {
  if (transaction.model.entity(run, { kind: 'run', id: run }) === null) {
    throw new BindingError('not_found', `run ${run} does not exist`)
  }
}

const journal = (
  transaction: Transaction,
  run: RunId,
  at: EpochNs,
  op: 'binding.add' | 'binding.revoke',
  binding: Binding,
): void => {
  applyChangeSet(transaction, {
    run,
    author: 'user',
    at,
    changes: [{ op, put: { kind: 'binding', value: binding }, basis: observed, evidence: [] }],
  })
}

const activeSessionBinding = (transaction: Transaction, session: Session): SessionBinding | null =>
  transaction.model
    .entities(sessionRun(transaction, session.key))
    .flatMap((entity) =>
      entity.kind === 'binding' &&
      entity.value.kind !== 'fork_parent' &&
      entity.value.session === session.id &&
      entity.value.revoked_at === null
        ? [entity.value]
        : [],
    )[0] ?? null

const rootLineage = (transaction: Transaction, run: RunId): { readonly root: Session; readonly lineage: Lineage } => {
  const fork = runLineage(transaction, run)
  if (fork === null) {
    throw new BindingError('not_found', `run ${run} does not exist`)
  }
  return fork
}

const movedFrom = (session: Session, from: RunId | null): MovedSession[] =>
  from === null ? [] : [{ session: session.key, from }]

const placeSession = (
  transaction: Transaction,
  binding: SessionBinding,
  session: Session,
  at: EpochNs,
): BindingOutcome => {
  const previous = activeSessionBinding(transaction, session)
  if (previous !== null) {
    journal(transaction, sessionRun(transaction, session.key), at, 'binding.revoke', { ...previous, revoked_at: at })
  }
  const target = binding.kind === 'attach' ? binding.run : runId(session.key)
  journal(transaction, target, at, 'binding.add', binding)
  return { binding, moved: movedFrom(session, transferSession(transaction, { session, to: target, at })) }
}

export const addBinding = (
  transaction: Transaction,
  request: CreateBindingRequest,
  id: BindingId,
  at: EpochNs,
): BindingOutcome => {
  switch (request.kind) {
    case 'attach': {
      const session = requireSession(transaction, request.session)
      requireRun(transaction, request.run)
      const binding = { id, ...request, created_at: at, revoked_at: null }
      return placeSession(transaction, binding, session, at)
    }
    case 'detach': {
      const session = requireSession(transaction, request.session)
      return placeSession(transaction, { id, ...request, created_at: at, revoked_at: null }, session, at)
    }
    case 'fork_parent': {
      requireRun(transaction, request.run)
      requireSession(transaction, request.parent)
      const { root, lineage } = rootLineage(transaction, request.run)
      if (!isFork(lineage)) {
        throw new BindingError('invalid_request', `run ${request.run} is not a fork`)
      }
      if (root.id === request.parent) {
        throw new BindingError('invalid_request', 'a fork cannot be its own parent')
      }
      const previous = activeForkParent(transaction, request.run)
      if (previous !== null) {
        journal(transaction, request.run, at, 'binding.revoke', { ...previous, revoked_at: at })
      }
      const binding = { id, ...request, created_at: at, revoked_at: null }
      journal(transaction, request.run, at, 'binding.add', binding)
      refreshForkedFrom(transaction, request.run, lineage.forkedFrom, at)
      return { binding, moved: [] }
    }
  }
}

export const revokeBinding = (transaction: Transaction, id: BindingId, at: EpochNs): BindingOutcome => {
  const run = transaction.model.entityRuns({ kind: 'binding', id })[0]
  const entity = run === undefined ? null : transaction.model.entity(run, { kind: 'binding', id })
  if (run === undefined || entity?.kind !== 'binding') {
    throw new BindingError('not_found', `binding ${id} does not exist`)
  }
  if (entity.value.revoked_at !== null) {
    return { binding: entity.value, moved: [] }
  }
  const binding = { ...entity.value, revoked_at: at }
  journal(transaction, run, at, 'binding.revoke', binding)
  if (binding.kind === 'fork_parent') {
    refreshForkedFrom(transaction, run, rootLineage(transaction, run).lineage.forkedFrom, at)
    return { binding, moved: [] }
  }
  const session = requireSession(transaction, binding.session)
  const placed = sessionRun(transaction, session.key) === run
  const from = placed ? transferSession(transaction, { session, to: runId(session.key), at }) : null
  return { binding, moved: movedFrom(session, from) }
}
