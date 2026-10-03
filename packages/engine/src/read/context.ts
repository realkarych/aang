import {
  type AttentionItem,
  type Binding,
  type Card,
  ChangeSeq,
  type Criterion,
  type FactKind,
  type Link,
  type ModelEntity,
  ModelVersion,
  type ObserverState,
  type Run,
  type RunId,
  type Stage,
  type StageId,
} from '@aang/contract'
import type { Store } from '@aang/store'
import { compareText } from '../observations/evidence.js'

export interface ObserverRunStatus {
  readonly state: ObserverState
  readonly isolation_unverified: boolean
}

export interface ReadContext {
  readonly store: Store
  readonly observer: (run: Run) => ObserverRunStatus
}

export interface ModelParts {
  readonly stages: Stage[]
  readonly criteria: Criterion[]
  readonly cards: Card[]
  readonly links: Link[]
  readonly attention: AttentionItem[]
  readonly bindings: Binding[]
}

export class InvalidPositionError extends Error {
  override readonly name = 'InvalidPositionError'
}

export const origin: ChangeSeq = ChangeSeq.parse(0)

export const planKinds: readonly FactKind[] = ['plan_update']

const firstVersion: ModelVersion = ModelVersion.parse(1)

export const byId = <T extends { readonly id: string }>(left: T, right: T): number => compareText(left.id, right.id)

export const runOf = (store: Store, id: RunId): Run | null => {
  const entity = store.model.entity(id, { kind: 'run', id })
  return entity?.kind === 'run' ? entity.value : null
}

export const precedesPrune = (store: Store, run: Run, position: ChangeSeq): boolean =>
  run.start_pruned && position < (store.model.version(run.id, firstVersion)?.change_seq ?? origin)

export const partsOf = (entities: readonly ModelEntity[]): ModelParts => {
  const parts: ModelParts = { stages: [], criteria: [], cards: [], links: [], attention: [], bindings: [] }
  for (const entity of entities) {
    switch (entity.kind) {
      case 'stage':
        parts.stages.push(entity.value)
        break
      case 'criterion':
        parts.criteria.push(entity.value)
        break
      case 'card':
        parts.cards.push(entity.value)
        break
      case 'link':
        parts.links.push(entity.value)
        break
      case 'attention_item':
        parts.attention.push(entity.value)
        break
      case 'binding':
        parts.bindings.push(entity.value)
        break
      case 'run':
      case 'session_membership':
        break
    }
  }
  for (const list of Object.values(parts) as { readonly id: string }[][]) {
    list.sort(byId)
  }
  return parts
}

export const stagesOfLink = (link: Link): StageId[] => {
  switch (link.kind) {
    case 'dependency':
      return [link.stage, link.depends_on]
    case 'participation':
    case 'assignment':
    case 'artifact':
      return [link.stage]
    case 'spawn':
    case 'forked_from':
    case 'common_origin':
      return []
  }
}

export const latest = <T extends bigint>(values: readonly T[]): T | null =>
  values.reduce<T | null>((top, value) => (top === null || value > top ? value : top), null)

export const earliest = <T extends bigint>(values: readonly T[]): T | null =>
  values.reduce<T | null>((low, value) => (low === null || value < low ? value : low), null)
