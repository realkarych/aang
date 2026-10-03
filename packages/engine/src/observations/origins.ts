import { isDeepStrictEqual } from 'node:util'
import type { Basis, Binding, EpochNs, Fact, Link, LinkId, RunId, Session, SessionId, SessionKey } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { applyChangeSet } from '../model/journal.js'
import { compareText, type Evidence, sessionEvidence } from './evidence.js'
import { type ForkOrigin, isFork, isInherited, type Lineage, lineageOf } from './lineage.js'
import { derivedLinkId, sessionRun } from './runs.js'

type ForkParentBinding = Extract<Binding, { kind: 'fork_parent' }>

const observed: Basis = { kind: 'observed' }

const commonOriginId = (session: SessionId): LinkId => derivedLinkId('common_origin', session)

const forkedFromId = (run: RunId): LinkId => derivedLinkId('forked_from', run)

const recordUuids = (items: readonly Evidence[]): string[] =>
  [...new Set(items.flatMap(({ fact }) => fact.runtime_ids.record_uuid ?? []))].sort(compareText)

const sessionOfFact = ({ entity_key: key }: Fact): SessionKey => ({
  kind: 'session',
  runtime: key.runtime,
  session: key.session,
})

const earlier = (left: Fact, right: Fact): boolean =>
  left.at < right.at || (left.at === right.at && compareText(left.id, right.id) < 0)

const storedLink = (transaction: Transaction, run: RunId, id: LinkId): Link | null => {
  const entity = transaction.model.entity(run, { kind: 'link', id })
  return entity?.kind === 'link' ? entity.value : null
}

const settleLink = (transaction: Transaction, run: RunId, id: LinkId, link: Link | null, at: EpochNs): void => {
  const current = storedLink(transaction, run, id)
  if (isDeepStrictEqual(current, link)) {
    return
  }
  applyChangeSet(transaction, {
    run,
    author: 'rule',
    at,
    changes: [
      link === null
        ? { op: 'link.remove', remove: { kind: 'link', id }, basis: observed, evidence: current?.evidence ?? [] }
        : { op: 'link.add', put: { kind: 'link', value: link }, basis: observed, evidence: link.evidence },
    ],
  })
}

const commonOrigin = (
  transaction: Transaction,
  key: SessionKey,
  lineage: Lineage,
  items: readonly Evidence[],
): Link | null => {
  if (key.runtime !== 'claude' || !isFork(lineage)) {
    return null
  }
  const own = objectId(key)
  const earliest = new Map<SessionId, Fact>()
  for (const fact of transaction.facts.withRecordUuids(key.runtime, recordUuids(items.filter(isInherited(lineage))))) {
    const session = objectId(sessionOfFact(fact))
    const known = earliest.get(session)
    if (session !== own && (known === undefined || earlier(fact, known))) {
      earliest.set(session, fact)
    }
  }
  const sessions = [...earliest.keys()].sort(compareText)
  const evidence = [...lineage.markers, ...[...earliest.values()].map(({ id }) => id)]
  return {
    id: commonOriginId(own),
    run: runId(key),
    kind: 'common_origin',
    sessions,
    parent_candidate: sessions.length === 1 ? (sessions[0] ?? null) : null,
    basis: observed,
    evidence: [...new Set(evidence)].sort(compareText),
  }
}

export const refreshCommonOrigin = (
  transaction: Transaction,
  key: SessionKey,
  lineage: Lineage,
  items: readonly Evidence[],
  at: EpochNs,
): void => {
  settleLink(transaction, runId(key), commonOriginId(objectId(key)), commonOrigin(transaction, key, lineage, items), at)
}

export const refreshRelatedOrigins = (
  transaction: Transaction,
  key: SessionKey,
  fresh: readonly Evidence[],
  at: EpochNs,
): void => {
  const related = new Map<SessionId, SessionKey>()
  for (const fact of transaction.facts.withRecordUuids(key.runtime, recordUuids(fresh))) {
    const other = sessionOfFact(fact)
    const id = objectId(other)
    if (other.session !== key.session && storedLink(transaction, runId(other), commonOriginId(id)) !== null) {
      related.set(id, other)
    }
  }
  for (const other of related.values()) {
    const items = sessionEvidence(transaction, other)
    refreshCommonOrigin(transaction, other, lineageOf(transaction, other, items), items, at)
  }
}

export const activeForkParent = (transaction: Transaction, run: RunId): ForkParentBinding | null =>
  transaction.model
    .entities(run)
    .flatMap((entity) =>
      entity.kind === 'binding' && entity.value.kind === 'fork_parent' && entity.value.revoked_at === null
        ? [entity.value]
        : [],
    )[0] ?? null

export const refreshForkedFrom = (
  transaction: Transaction,
  run: RunId,
  runtime: ForkOrigin | null,
  at: EpochNs,
): void => {
  const binding = activeForkParent(transaction, run)
  const chosen = binding === null ? null : transaction.observations.getSession(binding.parent)
  const parent = chosen?.key ?? runtime?.session ?? null
  const id = forkedFromId(run)
  settleLink(
    transaction,
    run,
    id,
    parent === null
      ? null
      : {
          id,
          run,
          kind: 'forked_from',
          parent: sessionRun(transaction, parent),
          basis: observed,
          evidence: chosen !== null || runtime === null ? [] : [runtime.fact],
        },
    at,
  )
}

export const runLineage = (
  transaction: Transaction,
  run: RunId,
): { readonly root: Session; readonly lineage: Lineage } | null => {
  const entity = transaction.model.entity(run, { kind: 'run', id: run })
  const root = entity?.kind === 'run' ? transaction.observations.getSession(entity.value.root_session) : null
  if (root === null) {
    return null
  }
  return { root, lineage: lineageOf(transaction, root.key, sessionEvidence(transaction, root.key)) }
}

export const refreshForksOf = (transaction: Transaction, parent: RunId, at: EpochNs): void => {
  for (const run of transaction.model.forksOf(parent)) {
    const fork = runLineage(transaction, run)
    if (fork !== null) {
      refreshForkedFrom(transaction, run, fork.lineage.forkedFrom, at)
    }
  }
}
