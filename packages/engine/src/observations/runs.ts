import { isDeepStrictEqual } from 'node:util'
import {
  type ActionId,
  type AgentId,
  type Basis,
  type EpochNs,
  type Fact,
  type FactId,
  type Link,
  LinkId,
  type ModelEntity,
  type RunId,
  type Session,
  type SessionKey,
} from '@aang/contract'
import { canonicalJson, contentHash, objectId, runId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { applyChangeSet, type ModelChangeDraft, type RunDraft } from '../model/journal.js'
import { stageLinkKey } from '../model/stage-links.js'
import type { Replacement } from './agents.js'
import { compareText } from './evidence.js'

export interface Spawn {
  readonly parent: AgentId
  readonly child: AgentId
  readonly via: ActionId | null
  readonly evidence: readonly FactId[]
}

export interface SessionLinks {
  readonly key: SessionKey
  readonly run: RunId
  readonly root: Fact
  readonly at: EpochNs
  readonly spawns: readonly Spawn[]
  readonly replacements: readonly Replacement[]
}

const observed: Basis = { kind: 'observed' }

const linkIdLength = 32

export const derivedLinkId = (...parts: readonly string[]): LinkId =>
  LinkId.parse(contentHash(canonicalJson([...parts])).slice(0, linkIdLength))

export const sessionRun = (transaction: Transaction, key: SessionKey): RunId =>
  transaction.model.entityRuns({ kind: 'session_membership', id: objectId(key) }).toSorted(compareText)[0] ??
  runId(key)

export const rootSessionOf = (transaction: Transaction, run: RunId, session: Session | null): Session | null => {
  const entity = transaction.model.entity(run, { kind: 'run', id: run })
  if (entity?.kind === 'run') {
    return transaction.observations.getSession(entity.value.root_session)
  }
  return session !== null && runId(session.key) === run ? session : null
}

const spawnLink = (run: RunId, { parent, child, via, evidence }: Spawn): Extract<Link, { kind: 'spawn' }> => ({
  id: derivedLinkId('spawn', child),
  run,
  kind: 'spawn',
  parent,
  child,
  via,
  basis: observed,
  evidence: [...new Set(evidence)].sort(compareText),
})

const runUpdate = (current: ModelEntity | null, { key, run, root }: SessionLinks, startPruned: boolean): RunDraft | null => {
  const session = objectId(key)
  if (current === null) {
    return {
      id: run,
      runtime: key.runtime,
      root_session: session,
      goal: null,
      brief: null,
      start_pruned: startPruned,
      created_at: root.at,
    }
  }
  if (current.kind !== 'run' || current.value.root_session !== session || root.at >= current.value.created_at) {
    return null
  }
  const { id, runtime, goal, brief, start_pruned: pruned } = current.value
  return { id, runtime, root_session: session, goal, brief, start_pruned: pruned, created_at: root.at }
}

const rootChanges = (transaction: Transaction, links: SessionLinks): ModelChangeDraft[] => {
  const { key, run, root } = links
  const session = objectId(key)
  const grounds = { op: 'run.create', basis: observed, evidence: [root.id] } satisfies Omit<ModelChangeDraft, 'put'>
  const startPruned = run === runId(key) && transaction.pruned.ofSession(key).length > 0
  const draft = runUpdate(transaction.model.entity(run, { kind: 'run', id: run }), links, startPruned)
  const member = transaction.model.entity(run, { kind: 'session_membership', id: session }) !== null
  return [
    ...(draft === null ? [] : [{ ...grounds, put: { kind: 'run', value: draft } } as const]),
    ...(member ? [] : [{ ...grounds, put: { kind: 'session_membership', value: { session, run } } } as const]),
  ]
}

const retargeted = (
  links: Map<LinkId, Link>,
  replacements: readonly Replacement[],
): ModelChangeDraft[] => {
  const changes: ModelChangeDraft[] = []
  for (const { retired, replaced_by: replacedBy, evidence } of replacements) {
    const grounds = { basis: observed, evidence: [...evidence] }
    for (const link of [...links.values()].toSorted((left, right) => compareText(left.id, right.id))) {
      if (link.kind === 'spawn' && link.child === retired) {
        links.delete(link.id)
        changes.push({ ...grounds, op: 'link.remove', remove: { kind: 'link', id: link.id } })
      } else if (link.kind === 'participation' && link.agent === retired) {
        const moved = { ...link, agent: replacedBy }
        const same = [...links.values()].some(
          (other) => other.kind === 'participation' && other.id !== link.id && stageLinkKey(other) === stageLinkKey(moved),
        )
        if (same) {
          links.delete(link.id)
          changes.push({ ...grounds, op: 'link.remove', remove: { kind: 'link', id: link.id } })
        } else {
          links.set(link.id, moved)
          changes.push({ ...grounds, op: 'link.retarget', put: { kind: 'link', value: moved } })
        }
      }
    }
  }
  return changes
}

export const linkSession = (transaction: Transaction, links: SessionLinks): void => {
  const { run, at, spawns, replacements } = links
  const stored = new Map(
    transaction.model.entities(run).flatMap((entity) => (entity.kind === 'link' ? [[entity.value.id, entity.value] as const] : [])),
  )
  const replaced = new Map(replacements.map((replacement) => [replacement.retired, replacement]))
  const changes = [...rootChanges(transaction, links), ...retargeted(stored, replacements)]
  for (const spawn of spawns) {
    const link = spawnLink(run, spawn)
    const current = stored.get(link.id)
    if (current === undefined || !isDeepStrictEqual(current, link)) {
      const moved = current?.kind === 'spawn' ? replaced.get(current.parent) : undefined
      changes.push(
        moved?.replaced_by === link.parent
          ? { op: 'link.retarget', put: { kind: 'link', value: link }, basis: observed, evidence: [...moved.evidence] }
          : { op: 'link.add', put: { kind: 'link', value: link }, basis: observed, evidence: link.evidence },
      )
    }
  }
  if (changes.length > 0) {
    applyChangeSet(transaction, { run, author: 'rule', at, changes })
  }
}
