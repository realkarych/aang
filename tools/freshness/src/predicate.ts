import {
  type ArtifactVersionId,
  type AttentionItem,
  type Card,
  compilePattern,
  type Criterion,
  type Evidence,
  type FactId,
  type Link,
  type Run,
  type Stage,
} from '@aang/contract'
import type {
  AttentionPredicate,
  CardPredicate,
  CriterionPredicate,
  LinkPredicate,
  MapPredicate,
  StagePredicate,
} from '@aang/record'

export interface ModelState {
  readonly run: Run | null
  readonly stages: readonly Stage[]
  readonly criteria: readonly Criterion[]
  readonly attention: readonly AttentionItem[]
  readonly cards: readonly Card[]
  readonly links: readonly Link[]
}

export interface PredicateScope {
  readonly eventFacts: ReadonlySet<FactId>
  readonly artifact: (version: ArtifactVersionId) => string | null
}

const matches = (pattern: string | undefined, text: string | null | undefined): boolean =>
  pattern === undefined || (text !== null && text !== undefined && compilePattern(pattern).test(text))

const among = <T>(allowed: readonly T[] | undefined, value: T): boolean => allowed === undefined || allowed.includes(value)

const cites = (scope: PredicateScope, required: 'event' | undefined, evidence: readonly Evidence[]): boolean =>
  required === undefined || evidence.some((facts) => facts.some((fact) => scope.eventFacts.has(fact)))

const outputs = (model: ModelState, scope: PredicateScope, stage: Stage): string[] =>
  model.links.flatMap((link) => {
    const reference = link.kind === 'artifact' && link.stage === stage.id && link.direction === 'output' ? scope.artifact(link.version) : null
    return reference === null ? [] : [reference]
  })

const stageHolds = (condition: StagePredicate, model: ModelState, scope: PredicateScope): boolean =>
  model.stages.some(
    (stage) =>
      matches(condition.title, stage.title) &&
      among(condition.lifecycle, stage.lifecycle.state) &&
      among(condition.execution, stage.execution.value.state) &&
      (condition.output === undefined || outputs(model, scope, stage).some((reference) => matches(condition.output, reference))) &&
      cites(scope, condition.evidence, [
        stage.evidence,
        stage.execution.evidence,
        stage.execution_claim?.evidence ?? [],
        stage.decision.evidence,
      ]),
  )

const criterionHolds = (condition: CriterionPredicate, model: ModelState, scope: PredicateScope): boolean =>
  model.criteria.some(
    (criterion) =>
      matches(condition.text, criterion.text) &&
      among(condition.status, criterion.status.value) &&
      cites(scope, condition.evidence, [criterion.status.evidence]),
  )

const attentionHolds = (condition: AttentionPredicate, model: ModelState, scope: PredicateScope): boolean =>
  model.attention.some(
    (item) =>
      among(condition.kind, item.kind) &&
      among(condition.author, item.author) &&
      among(condition.resolution, item.resolution) &&
      matches(condition.text, item.text) &&
      cites(scope, condition.evidence, [item.evidence, item.likely_resolved?.evidence ?? []]),
  )

const cardHolds = (condition: CardPredicate, model: ModelState, scope: PredicateScope): boolean =>
  model.cards.some((card) => matches(condition.text, card.text) && cites(scope, condition.evidence, [card.evidence]))

const linkHolds = (condition: LinkPredicate, model: ModelState, scope: PredicateScope): boolean =>
  model.links.some((link) => among(condition.kind, link.kind) && cites(scope, condition.evidence, [link.evidence]))

export const holds = (predicate: MapPredicate, model: ModelState, scope: PredicateScope): boolean => {
  if ('stage' in predicate) {
    return stageHolds(predicate.stage, model, scope)
  }
  if ('criterion' in predicate) {
    return criterionHolds(predicate.criterion, model, scope)
  }
  if ('attention' in predicate) {
    return attentionHolds(predicate.attention, model, scope)
  }
  if ('card' in predicate) {
    return cardHolds(predicate.card, model, scope)
  }
  if ('link' in predicate) {
    return linkHolds(predicate.link, model, scope)
  }
  if ('brief' in predicate) {
    return matches(predicate.brief, model.run?.brief?.text)
  }
  if ('all' in predicate) {
    return predicate.all.every((part) => holds(part, model, scope))
  }
  return predicate.any.some((part) => holds(part, model, scope))
}
