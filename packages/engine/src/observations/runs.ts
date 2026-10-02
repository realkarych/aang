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
  type SessionKey,
} from '@aang/contract'
import { canonicalJson, contentHash, objectId, runId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { applyChangeSet, type ModelChangeDraft, type RunDraft } from '../model/journal.js'
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
}

const observed: Basis = { kind: 'observed' }

const linkIdLength = 32

export const sessionRun = (transaction: Transaction, key: SessionKey): RunId =>
  transaction.model.entityRuns({ kind: 'session_membership', id: objectId(key) }).toSorted(compareText)[0] ??
  runId(key)

const spawnLink = (run: RunId, { parent, child, via, evidence }: Spawn): Link => ({
  id: LinkId.parse(contentHash(canonicalJson(['spawn', child])).slice(0, linkIdLength)),
  run,
  kind: 'spawn',
  parent,
  child,
  via,
  basis: observed,
  evidence: [...new Set(evidence)].sort(compareText),
})

const runUpdate = (current: ModelEntity | null, { key, run, root }: SessionLinks): RunDraft | null => {
  const session = objectId(key)
  if (current === null) {
    return {
      id: run,
      runtime: key.runtime,
      root_session: session,
      goal: null,
      brief: null,
      start_pruned: false,
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
  const draft = runUpdate(transaction.model.entity(run, { kind: 'run', id: run }), links)
  const member = transaction.model.entity(run, { kind: 'session_membership', id: session }) !== null
  return [
    ...(draft === null ? [] : [{ ...grounds, put: { kind: 'run', value: draft } } as const]),
    ...(member ? [] : [{ ...grounds, put: { kind: 'session_membership', value: { session, run } } } as const]),
  ]
}

export const linkSession = (transaction: Transaction, links: SessionLinks): void => {
  const { run, at, spawns } = links
  const changes = rootChanges(transaction, links)
  for (const spawn of spawns) {
    const link = spawnLink(run, spawn)
    const current = transaction.model.entity(run, { kind: 'link', id: link.id })
    if (current?.kind !== 'link' || !isDeepStrictEqual(current.value, link)) {
      changes.push({ op: 'link.add', put: { kind: 'link', value: link }, basis: observed, evidence: link.evidence })
    }
  }
  if (changes.length > 0) {
    applyChangeSet(transaction, { run, author: 'rule', at, changes })
  }
}
