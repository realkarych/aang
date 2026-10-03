import { isDeepStrictEqual } from 'node:util'
import {
  type AttentionItem,
  AttentionItemId,
  type Basis,
  type EpochNs,
  type Question,
  type SessionKey,
} from '@aang/contract'
import { canonicalJson, contentHash, objectId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { type AttentionItemDraft, applyChangeSet, type ModelChangeDraft } from '../model/journal.js'
import { compareText } from './evidence.js'
import type { Grounds, QuestionOutcome } from './questions.js'

export interface QuestionAttention {
  readonly question: Omit<Question, 'change_seq'>
  readonly outcome: QuestionOutcome
}

const observed: Basis = { kind: 'observed' }

const itemIdLength = 32

const ruleAttentionId = (question: Question['id']): AttentionItemId =>
  AttentionItemId.parse(contentHash(canonicalJson(['rule-attention', question])).slice(0, itemIdLength))

const ruleFields = (item: AttentionItemDraft) => ({
  kind: item.kind,
  author: item.author,
  text: item.text,
  stage: item.stage,
  question: item.question,
  action: item.action,
  basis: item.basis,
  evidence: item.evidence,
  runtime_wait: item.runtime_wait,
  resolution: item.resolution,
  opened_at: item.opened_at,
  closed_at: item.closed_at,
})

type ChangeGrounds = Pick<Grounds, 'basis' | 'evidence'>

const change = (op: ModelChangeDraft['op'], item: AttentionItemDraft, grounds: ChangeGrounds): ModelChangeDraft => ({
  op,
  basis: grounds.basis,
  evidence: [...grounds.evidence],
  put: { kind: 'attention_item', value: item },
})

const transition = (
  before: AttentionItemDraft,
  after: AttentionItemDraft,
  opening: ChangeGrounds,
  { closure, wait_end: waitEnd }: QuestionOutcome,
): ModelChangeDraft | null => {
  if (isDeepStrictEqual(ruleFields(before), ruleFields(after))) {
    return null
  }
  if (
    after.resolution !== 'open' &&
    closure !== null &&
    (before.resolution !== after.resolution || before.closed_at !== after.closed_at)
  ) {
    return change('attention.close', after, closure)
  }
  if (before.resolution === after.resolution && before.runtime_wait !== after.runtime_wait) {
    return change('attention.wait', after, waitEnd ?? opening)
  }
  return change('attention.open', after, opening)
}

const itemChanges = (
  transaction: Transaction,
  run: AttentionItem['run'],
  { question, outcome }: QuestionAttention,
): ModelChangeDraft[] => {
  const id = ruleAttentionId(question.id)
  const current = transaction.model.entity(run, { kind: 'attention_item', id })
  const existing = current?.kind === 'attention_item' ? current.value : null
  const opening = { basis: observed, evidence: [outcome.opening.id] }
  const opened: AttentionItemDraft = {
    id,
    run,
    kind: question.kind === 'permission' ? 'permission' : 'question',
    author: 'rule',
    text: outcome.text,
    stage: existing?.stage ?? null,
    question: question.id,
    action: outcome.link === null || outcome.link.ambiguous ? null : outcome.link.action,
    basis: observed,
    evidence: [outcome.opening.id],
    runtime_wait: outcome.blocking ? 'active' : 'none',
    resolution: 'open',
    likely_resolved: existing?.likely_resolved ?? null,
    priority: existing?.priority ?? null,
    opened_at: question.asked_at,
    closed_at: null,
  }
  const settled: AttentionItemDraft = {
    ...opened,
    runtime_wait: outcome.wait,
    resolution: outcome.resolution,
    closed_at: outcome.closure?.at ?? null,
  }
  if (existing !== null) {
    const next = transition(existing, settled, opening, outcome)
    return next === null ? [] : [next]
  }
  const next = transition(opened, settled, opening, outcome)
  return [change('attention.open', opened, opening), ...(next === null ? [] : [next])]
}

export const reconcileRuleAttention = (
  transaction: Transaction,
  session: SessionKey,
  at: EpochNs,
  questions: readonly QuestionAttention[],
): void => {
  const run = transaction.model
    .entityRuns({ kind: 'session_membership', id: objectId(session) })
    .toSorted(compareText)[0]
  if (run === undefined) {
    return
  }
  const changes = questions.flatMap((question) => itemChanges(transaction, run, question))
  if (changes.length > 0) {
    applyChangeSet(transaction, { run, author: 'rule', at, changes })
  }
}
