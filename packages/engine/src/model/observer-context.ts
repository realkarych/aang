import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  type AttentionRef,
  type Basis,
  type CriterionRef,
  type Fact,
  type FactId,
  type ModelEntityRef,
  ModelVersion,
  type ObserverInput,
  type ObserverOp,
  type ObserverRejection,
  type ObserverRejectionCause,
  type RunId,
  type StageRef,
  type TempId,
} from '@aang/contract'
import type { StoredObserverCall, Transaction } from '@aang/store'
import { factSession, sessionInRun } from '../input/scope.js'
import type { ModelChangeDraft, ModelEntityDraft } from './journal.js'

export const batchFacts = (input: ObserverInput): FactId[] => [
  ...new Set([
    ...input.batch.facts.map(({ id }) => id),
    ...input.batch.collapsed.flatMap(({ facts }) => facts),
  ]),
]

export const factBelongsToRun = (transaction: Transaction, run: RunId, fact: Fact): boolean =>
  sessionInRun(transaction.model, run, factSession(fact))

export class OperationRejection extends Error {
  constructor(
    override readonly cause: ObserverRejectionCause,
    message: string,
  ) {
    super(message)
  }
}

type EntityKind = ModelEntityDraft['kind']
type EntityOf<K extends EntityKind> = Extract<ModelEntityDraft, { kind: K }>['value']
type ReferenceKind = 'stage' | 'criterion' | 'attention_item'
type Reference = StageRef | CriterionRef | AttentionRef

export interface ValidationLimits {
  readonly operations: number
  readonly textLength: number
}

const keyOf = (kind: EntityKind, id: string): string => `${kind}\0${id}`

export class ObserverContext {
  readonly entities = new Map<string, ModelEntityDraft>()
  readonly temporary: Map<TempId, { kind: ReferenceKind; id: string }> = new Map()
  readonly changes: ModelChangeDraft[] = []
  readonly rejections: ObserverRejection[] = []
  readonly sent: Set<FactId>
  readonly successors = new Map<string, Set<string>>()

  constructor(
    readonly transaction: Transaction,
    readonly call: StoredObserverCall,
  ) {
    this.sent = new Set(batchFacts(call.input))
    for (const entity of transaction.model.entities(call.run)) {
      const id = entity.kind === 'session_membership' ? entity.value.session : entity.value.id
      this.entities.set(keyOf(entity.kind, id), entity)
    }
    for (const change of transaction.model.changes(call.run, ModelVersion.parse(0))) {
      if (change.after?.kind === 'stage') {
        this.rememberSuccessors(change.after.value.id, change.after.value.lifecycle)
      }
    }
    for (const entity of this.entities.values()) {
      if (entity.kind === 'stage') {
        this.rememberSuccessors(entity.value.id, entity.value.lifecycle)
      }
    }
  }

  reject(index: number | null, error: OperationRejection): void {
    this.rejections.push({ op_index: index, cause: error.cause, message: error.message })
  }

  check(condition: boolean, cause: ObserverRejectionCause, message: string): asserts condition {
    if (!condition) {
      throw new OperationRejection(cause, message)
    }
  }

  declare(op: ObserverOp): void {
    if (!('temp_id' in op)) {
      return
    }
    this.check(
      op.temp_id.length > 0 && !this.temporary.has(op.temp_id),
      'reference',
      `duplicate or empty temporary id ${op.temp_id}`,
    )
    const kind =
      op.op === 'stage.create' ? 'stage' : op.op === 'criterion.add' ? 'criterion' : 'attention_item'
    this.temporary.set(op.temp_id, { kind, id: randomUUID() })
  }

  id(kind: ReferenceKind, ref: Reference, fields: readonly string[] = []): string {
    if (ref.kind === 'new') {
      const declared = this.temporary.get(ref.temp_id)
      this.check(declared?.kind === kind, 'reference', `unknown ${kind} temporary id ${ref.temp_id}`)
      return declared.id
    }
    const target = { kind, id: ref.id } as ModelEntityRef
    const found = this.entities.has(keyOf(kind, ref.id))
    this.check(
      found,
      this.transaction.model.entityRuns(target).length > 0 ? 'scope' : 'reference',
      `${kind} ${ref.id} is not in run ${this.call.run}`,
    )
    for (const change of this.transaction.model.entityChanges(
      this.call.run,
      target,
      this.call.base_version,
    )) {
      this.check(
        !['stage.replace', 'stage.merge', 'stage.split', 'session.move'].includes(change.op),
        'conflict',
        `${kind} ${ref.id} was replaced, merged, split or moved`,
      )
      if (change.author === 'user') {
        for (const field of fields) {
          const before = change.before?.value as Record<string, unknown> | undefined
          const after = change.after?.value as Record<string, unknown> | undefined
          this.check(
            isDeepStrictEqual(before?.[field], after?.[field]),
            'conflict',
            `user changed ${kind} ${ref.id}.${field}`,
          )
        }
      }
    }
    return ref.id
  }

  get<K extends EntityKind>(kind: K, id: string): EntityOf<K> {
    const entity = this.entities.get(keyOf(kind, id))
    this.check(entity?.kind === kind, 'reference', `${kind} ${id} is unavailable`)
    return entity.value as EntityOf<K>
  }

  object(kind: 'action' | 'agent' | 'artifact_version', id: string): void {
    const owner = this.transaction.model.objectRun(kind, id)
    this.check(owner !== undefined, 'reference', `unknown ${kind} ${id}`)
    this.check(owner === this.call.run, 'scope', `${kind} ${id} is outside run ${this.call.run}`)
  }

  facts(op: ObserverOp): Fact[] {
    return op.evidence.map((id) => {
      this.check(this.sent.has(id), 'scope', `fact ${id} was not sent in this call`)
      const fact = this.transaction.facts.get(id)
      this.check(fact !== null, 'reference', `unknown fact ${id}`)
      this.check(
        factBelongsToRun(this.transaction, this.call.run, fact),
        'scope',
        `fact ${id} is outside run ${this.call.run}`,
      )
      return fact
    })
  }

  basis(op: ObserverOp, facts: readonly Fact[]): Basis {
    return op.op !== 'attention.likely_resolved' &&
      facts.length > 0 &&
      facts.every(({ speaker }) => speaker === 'solver')
      ? { kind: 'claimed' }
      : { kind: 'interpreted', interpreter: { kind: 'llm', call: this.call.id } }
  }

  put(op: ObserverOp, entity: ModelEntityDraft, basis: Basis): void {
    const id = entity.kind === 'session_membership' ? entity.value.session : entity.value.id
    this.entities.set(keyOf(entity.kind, id), entity)
    this.changes.push({ op: op.op, put: entity, basis, evidence: op.evidence })
  }

  rememberSuccessors(id: string, lifecycle: EntityOf<'stage'>['lifecycle']): void {
    const targets =
      lifecycle.state === 'active'
        ? []
        : lifecycle.state === 'replaced'
          ? lifecycle.by
          : lifecycle.state === 'merged'
            ? [lifecycle.into]
            : lifecycle.into
    const known = this.successors.get(id) ?? new Set<string>()
    for (const target of targets) {
      known.add(target)
    }
    this.successors.set(id, known)
  }

  checkGraphs(): void {
    const parents = new Map<string, Set<string>>()
    for (const entity of this.entities.values()) {
      if (entity.kind === 'stage') {
        parents.set(entity.value.id, new Set(entity.value.parent === null ? [] : [entity.value.parent]))
      }
    }
    for (const [name, graph] of [
      ['nesting', parents],
      ['successors', this.successors],
    ] as const) {
      const active = new Set<string>()
      const visited = new Set<string>()
      const visit = (id: string): void => {
        this.check(!active.has(id), 'invariant', `cycle in stage ${name}`)
        if (visited.has(id)) {
          return
        }
        active.add(id)
        for (const target of graph.get(id) ?? []) {
          visit(target)
        }
        active.delete(id)
        visited.add(id)
      }
      for (const id of graph.keys()) {
        visit(id)
      }
    }
  }
}
