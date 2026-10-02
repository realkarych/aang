import {
  type AttentionItem,
  type Basis,
  type Binding,
  type Card,
  type Criterion,
  type EpochNs,
  type Evidence,
  type Link,
  type ModelChange,
  type ModelEntity,
  type ModelEntityRef,
  type ModelOperation,
  ModelVersion,
  type ObserverCallId,
  type Run,
  type RunId,
  type SessionMembership,
  type Stage,
} from '@aang/contract'
import type { JournalEntry, JournalVersion, Transaction } from '@aang/store'

export type RunDraft = Omit<Run, 'version'>
export type StageDraft = Omit<Stage, 'created_version' | 'updated_version'>
export type AttentionItemDraft = Omit<AttentionItem, 'change_seq'>

export type ModelEntityDraft =
  | { readonly kind: 'run'; readonly value: RunDraft }
  | { readonly kind: 'stage'; readonly value: StageDraft }
  | { readonly kind: 'criterion'; readonly value: Criterion }
  | { readonly kind: 'card'; readonly value: Card }
  | { readonly kind: 'attention_item'; readonly value: AttentionItemDraft }
  | { readonly kind: 'link'; readonly value: Link }
  | { readonly kind: 'binding'; readonly value: Binding }
  | { readonly kind: 'session_membership'; readonly value: SessionMembership }

interface ChangeGrounds {
  readonly op: ModelOperation
  readonly basis: Basis
  readonly evidence: Evidence
}

export type ModelChangeDraft =
  (ChangeGrounds & { readonly put: ModelEntityDraft }) | (ChangeGrounds & { readonly remove: ModelEntityRef })

export type ChangeSetAuthor =
  | { readonly author: 'rule' | 'user' }
  | { readonly author: 'observer'; readonly observer_call: ObserverCallId; readonly base_version: ModelVersion }

export type ChangeSet = ChangeSetAuthor & {
  readonly run: RunId
  readonly at: EpochNs
  readonly changes: readonly ModelChangeDraft[]
}

export interface AppliedChangeSet {
  readonly version: JournalVersion
  readonly changes: readonly ModelChange[]
}

export class InvalidChangeSetError extends Error {
  override readonly name = 'InvalidChangeSetError'
}

const referenceOf = (entity: ModelEntityDraft): ModelEntityRef => {
  switch (entity.kind) {
    case 'run':
      return { kind: 'run', id: entity.value.id }
    case 'stage':
      return { kind: 'stage', id: entity.value.id }
    case 'criterion':
      return { kind: 'criterion', id: entity.value.id }
    case 'card':
      return { kind: 'card', id: entity.value.id }
    case 'attention_item':
      return { kind: 'attention_item', id: entity.value.id }
    case 'link':
      return { kind: 'link', id: entity.value.id }
    case 'binding':
      return { kind: 'binding', id: entity.value.id }
    case 'session_membership':
      return { kind: 'session_membership', id: entity.value.session }
  }
}

const owningRun = (entity: ModelEntityDraft): RunId | null => {
  switch (entity.kind) {
    case 'run':
      return entity.value.id
    case 'binding':
      return entity.value.kind === 'detach' ? null : entity.value.run
    default:
      return entity.value.run
  }
}

const stamp = (entity: ModelEntityDraft, before: ModelEntity | null, version: JournalVersion): ModelEntity => {
  switch (entity.kind) {
    case 'run':
      return { kind: 'run', value: { ...entity.value, version: version.version } }
    case 'stage':
      return {
        kind: 'stage',
        value: {
          ...entity.value,
          created_version: before?.kind === 'stage' ? before.value.created_version : version.version,
          updated_version: version.version,
        },
      }
    case 'attention_item':
      return { kind: 'attention_item', value: { ...entity.value, change_seq: version.change_seq } }
    default:
      return entity
  }
}

const describe = (target: ModelEntityRef): string => `${target.kind} ${target.id}`

export const applyChangeSet = (transaction: Transaction, changeSet: ChangeSet): AppliedChangeSet => {
  const { run } = changeSet
  if (changeSet.changes.length === 0) {
    throw new InvalidChangeSetError(`change set for run ${run} has no changes`)
  }
  const head = transaction.model.head(run)
  const observer = changeSet.author === 'observer' ? changeSet : null
  const version: JournalVersion = {
    run,
    version: ModelVersion.parse(head + 1),
    base_version: observer?.base_version ?? head,
    author: changeSet.author,
    observer_call: observer?.observer_call ?? null,
    created_at: changeSet.at,
    change_seq: transaction.nextChangeSeq(),
  }
  const pending = new Map<string, ModelEntity | null>()
  const entries = changeSet.changes.map((change): JournalEntry => {
    const target = 'put' in change ? referenceOf(change.put) : change.remove
    const key = `${target.kind}\0${target.id}`
    const known = pending.get(key)
    const before = known === undefined ? transaction.model.entity(run, target) : known
    let after: ModelEntity | null = null
    if ('put' in change) {
      const owner = owningRun(change.put)
      if (owner !== null && owner !== run) {
        throw new InvalidChangeSetError(`${describe(target)} belongs to run ${owner}, not to run ${run}`)
      }
      after = stamp(change.put, before, version)
    } else if (before === null) {
      throw new InvalidChangeSetError(`${describe(target)} does not exist in run ${run}`)
    }
    pending.set(key, after)
    return { op: change.op, target, before, after, basis: change.basis, evidence: change.evidence }
  })
  return { version, changes: transaction.model.commit(version, entries) }
}
