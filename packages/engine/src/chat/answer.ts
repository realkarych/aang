import type {
  ChatCitation,
  ChatInput,
  ChatMessage,
  ChatMessageId,
  ChatOutput,
  EpochNs,
  JournalEntry,
  ModelEntityRef,
  RunId,
  ViewRuleId,
  ViewRuleSpec,
} from '@aang/contract'
import { canonicalJson } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import { addViewRule, ViewRuleError } from '../view/rules.js'

export interface VerifiedCitations {
  readonly citations: ChatCitation[]
  readonly unconfirmed: boolean
}

export interface ChatAnswerResult {
  readonly run: RunId
  readonly message: ChatMessageId
  readonly input: ChatInput
  readonly output: ChatOutput
  readonly at: EpochNs
}

export interface ChatFailureResult {
  readonly run: RunId
  readonly message: ChatMessageId
  readonly error: string
  readonly at: EpochNs
}

type CitedKind = ChatCitation['kind']

const citationKinds: Readonly<Partial<Record<ModelEntityRef['kind'], CitedKind>>> = {
  stage: 'stage',
  attention_item: 'question',
}

const knownIds = (input: ChatInput): ReadonlyMap<CitedKind, ReadonlySet<string>> => {
  const known = new Map<CitedKind, Set<string>>(
    (['stage', 'fact', 'action', 'artifact_version', 'question'] as const).map((kind) => [kind, new Set<string>()]),
  )
  const add = (kind: CitedKind, id: string | null): void => {
    if (id !== null) {
      known.get(kind)?.add(id)
    }
  }
  const target = ({ kind, id }: ModelEntityRef): void => {
    const cited = citationKinds[kind]
    if (cited !== undefined) {
      add(cited, id)
    }
  }
  const journal = (entries: readonly JournalEntry[]): void => {
    for (const entry of entries) {
      target(entry.target)
      entry.evidence.forEach((id) => {
        add('fact', id)
      })
    }
  }
  const { model, focus, materials } = input
  model.stages.forEach(({ id }) => {
    add('stage', id)
  })
  model.attention.forEach(({ id }) => {
    add('question', id)
  })
  if (focus.kind === 'stage') {
    add('stage', focus.stage)
    focus.facts.forEach(({ id, action }) => {
      add('fact', id)
      add('action', action)
    })
    focus.actions.forEach(({ action }) => {
      add('action', action)
    })
    focus.artifact_versions.forEach(({ id, produced_by: producer }) => {
      add('artifact_version', id)
      add('action', producer)
    })
  } else {
    focus.attention.forEach(({ id }) => {
      add('question', id)
    })
    journal(focus.recent_changes)
  }
  for (const material of materials) {
    switch (material.kind) {
      case 'stage':
        add('stage', material.stage.id)
        break
      case 'fact':
        add('fact', material.fact.id)
        add('action', material.fact.action)
        break
      case 'action':
        add('action', material.action)
        break
      case 'journal':
        target(material.entity)
        journal(material.entries)
        break
      case 'artifact_version':
        add('artifact_version', material.version)
        break
      case 'raw_record':
      case 'unavailable':
        break
    }
  }
  return known
}

export const verifyCitations = (input: ChatInput, citations: readonly ChatCitation[]): VerifiedCitations => {
  const known = knownIds(input)
  const unique = new Map(citations.map((citation) => [canonicalJson(citation), citation]))
  const confirmed = [...unique.values()].filter(({ kind, id }) => known.get(kind)?.has(id) === true)
  return { citations: confirmed, unconfirmed: confirmed.length < unique.size }
}

interface ChatViewRule {
  readonly view_rule: ViewRuleId | null
  readonly view_rule_error: string | null
}

const chatViewRule = (transaction: Transaction, run: RunId, rule: ViewRuleSpec | null, at: EpochNs): ChatViewRule => {
  if (rule === null) {
    return { view_rule: null, view_rule_error: null }
  }
  try {
    const applied = addViewRule(transaction, { run, rule, source: 'chat', at })
    return { view_rule: applied?.rule.id ?? null, view_rule_error: null }
  } catch (error) {
    if (error instanceof ViewRuleError) {
      return { view_rule: null, view_rule_error: `${error.code}: ${error.message}` }
    }
    throw error
  }
}

const pending = (transaction: Transaction, run: RunId, message: ChatMessageId): boolean =>
  transaction.chat.message(run, message)?.status === 'pending'

export const answerChat = (transaction: Transaction, result: ChatAnswerResult): ChatMessage | null => {
  if (!pending(transaction, result.run, result.message)) {
    return null
  }
  const { output } = result
  const { citations, unconfirmed } = verifyCitations(result.input, output.citations)
  return transaction.chat.answer(result.run, result.message, {
    answer: output.answer,
    citations,
    unconfirmed_citations: unconfirmed,
    insufficient_data: output.insufficient_data || output.answer === null,
    ...chatViewRule(transaction, result.run, output.view_rule, result.at),
    answered_at: result.at,
  })
}

export const failChat = (transaction: Transaction, result: ChatFailureResult): ChatMessage | null =>
  pending(transaction, result.run, result.message)
    ? transaction.chat.fail(result.run, result.message, { error: result.error, answered_at: result.at })
    : null

export const failInterruptedChats = (transaction: Transaction, at: EpochNs): ChatMessage[] =>
  transaction.chat
    .pending()
    .map((message) =>
      transaction.chat.fail(message.run, message.id, {
        error: 'the daemon stopped before the chat answered',
        answered_at: at > message.asked_at ? at : message.asked_at,
      }),
    )
