import { isDeepStrictEqual } from 'node:util'
import {
  type Assessed,
  type AttentionItem,
  type Basis,
  type EpochNs,
  type FactId,
  type HumanDecision,
  type ModelEntity,
  ModelVersion,
  type RunId,
  type Stage,
  type StageId,
} from '@aang/contract'
import type { Transaction } from '@aang/store'
import { applyChangeSet, type AppliedChangeSet, type ModelChangeDraft } from './journal.js'

const basis: Basis = { kind: 'interpreted', interpreter: { kind: 'rule', rule: 'stage-decision' } }

const requestKinds: ReadonlySet<AttentionItem['kind']> = new Set(['question', 'permission', 'review_request'])

const humanDecisions: ReadonlySet<HumanDecision> = new Set(['approved', 'rejected', 'answered'])

export const canonicalEvidence = (evidence: readonly FactId[]): FactId[] => [...new Set(evidence)].sort()

export const stageAttention = (
  transaction: Transaction,
  run: RunId,
  stage: StageId,
  entities: readonly ModelEntity[],
): AttentionItem[] => {
  const assigned = new Set(
    entities.flatMap((entity) =>
      entity.kind === 'link' && entity.value.kind === 'assignment' && entity.value.stage === stage
        ? [entity.value.action]
        : [],
    ),
  )
  return entities
    .flatMap((entity) => (entity.kind === 'attention_item' ? [entity.value] : []))
    .filter(
      (item) =>
        item.stage === stage ||
        (item.stage === null &&
          item.action !== null &&
          assigned.has(item.action) &&
          transaction.model.objectRun('action', item.action) === run),
    )
}

const closingEvidence = (transaction: Transaction, run: RunId, item: AttentionItem): FactId[] =>
  transaction.model
    .entityChanges(run, { kind: 'attention_item', id: item.id }, ModelVersion.parse(0))
    .filter(
      ({ before, after }) =>
        after?.kind === 'attention_item' &&
        after.value.resolution !== 'open' &&
        (before?.kind !== 'attention_item' ||
          before.value.resolution !== after.value.resolution ||
          before.value.closed_at !== after.value.closed_at),
    )
    .at(-1)?.evidence ?? item.evidence

const closedAt = (item: AttentionItem): EpochNs => item.closed_at ?? item.opened_at

const itemDecision = (transaction: Transaction, run: RunId, item: AttentionItem): Assessed<HumanDecision> => {
  const question = item.question === null ? null : transaction.observations.getQuestion(item.question)
  if (question !== null && humanDecisions.has(question.decision.value)) {
    return { value: question.decision.value, basis, evidence: canonicalEvidence(question.decision.evidence) }
  }
  return {
    value: item.resolution === 'answered' && item.kind !== 'permission' ? 'answered' : 'unknown',
    basis,
    evidence: canonicalEvidence(closingEvidence(transaction, run, item)),
  }
}

const later = (item: AttentionItem, than: AttentionItem): boolean =>
  closedAt(item) > closedAt(than) || (closedAt(item) === closedAt(than) && item.id > than.id)

export const stageDecision = (
  transaction: Transaction,
  run: RunId,
  stage: Pick<Stage, 'decision'>,
  attention: readonly AttentionItem[],
): Assessed<HumanDecision> => {
  const requests = attention.filter((item) => requestKinds.has(item.kind))
  const open = requests.filter((item) => item.resolution === 'open')
  if (open.length > 0) {
    return { value: 'requested', basis, evidence: canonicalEvidence(open.flatMap((item) => item.evidence)) }
  }
  const latest = requests.reduce<AttentionItem | undefined>(
    (last, item) => (last === undefined || later(item, last) ? item : last),
    undefined,
  )
  if (latest !== undefined) {
    return itemDecision(transaction, run, latest)
  }
  return isDeepStrictEqual(stage.decision.basis, basis) ? { ...stage.decision, value: 'unknown' } : stage.decision
}

export interface StageDecisionUpdate {
  readonly run: RunId
  readonly at: EpochNs
}

export const refreshStageDecisions = (
  transaction: Transaction,
  { run, at }: StageDecisionUpdate,
): AppliedChangeSet | null => {
  const entities = transaction.model.entities(run)
  const changes: ModelChangeDraft[] = entities.flatMap((entity): ModelChangeDraft[] => {
    if (entity.kind !== 'stage' || entity.value.lifecycle.state !== 'active') {
      return []
    }
    const stage = entity.value
    const decision = stageDecision(transaction, run, stage, stageAttention(transaction, run, stage.id, entities))
    return isDeepStrictEqual(stage.decision, decision)
      ? []
      : [{ op: 'stage.execution', basis, evidence: decision.evidence, put: { kind: 'stage', value: { ...stage, decision } } }]
  })
  return changes.length === 0 ? null : applyChangeSet(transaction, { run, at, author: 'rule', changes })
}
