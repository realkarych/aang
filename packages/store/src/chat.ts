import type { DatabaseSync } from 'node:sqlite'
import {
  ChangeSeq,
  type ChatCitation,
  ChatMessage,
  type ChatMessageId,
  type EpochNs,
  type ModelVersion,
  type RunId,
  Runtime,
  type StageId,
  type ViewRuleId,
} from '@aang/contract'
import { decodeJson, encodeFlag, encodeJson } from './codec.js'
import { prepareStatement, type WriteContext } from './context.js'

export interface ChatScope {
  readonly backend: Runtime
  readonly cross_vendor: boolean
}

export interface ChatQuestion {
  readonly run: RunId
  readonly stage: StageId | null
  readonly question: string
  readonly version: ModelVersion
  readonly scope: ChatScope
  readonly asked_at: EpochNs
}

export interface ScopedChatMessage {
  readonly message: ChatMessage
  readonly scope: ChatScope
}

export interface ChatAnswer {
  readonly answer: string | null
  readonly citations: readonly ChatCitation[]
  readonly unconfirmed_citations: boolean
  readonly insufficient_data: boolean
  readonly view_rule: ViewRuleId | null
  readonly view_rule_error: string | null
  readonly answered_at: EpochNs
}

export interface ChatFailure {
  readonly error: string
  readonly answered_at: EpochNs
}

export interface ChatChange {
  readonly change_seq: ChangeSeq
  readonly message: ChatMessage
}

export interface ChatReader {
  readonly message: (run: RunId, id: ChatMessageId) => ChatMessage | null
  readonly messages: (run: RunId) => ChatMessage[]
  readonly scoped: (run: RunId) => ScopedChatMessage[]
  readonly changed: (run: RunId, after: ChangeSeq) => ChatChange[]
  readonly pending: () => ChatMessage[]
}

export interface ChatWriter extends ChatReader {
  readonly ask: (question: ChatQuestion) => ChatMessage
  readonly answer: (run: RunId, id: ChatMessageId, answer: ChatAnswer) => ChatMessage
  readonly fail: (run: RunId, id: ChatMessageId, failure: ChatFailure) => ChatMessage
}

export interface ChatRepository {
  readonly reader: ChatReader
  readonly writer: (context: WriteContext) => ChatWriter
}

type MessageRow = {
  readonly id: bigint
  readonly run_id: string
  readonly stage_id: string | null
  readonly model_version: bigint
  readonly question: string
  readonly backend: string
  readonly cross_vendor: bigint
  readonly status: string
  readonly answer: string | null
  readonly citations: string
  readonly unconfirmed_citations: bigint
  readonly insufficient_data: bigint
  readonly view_rule_id: bigint | null
  readonly view_rule_error: string | null
  readonly error: string | null
  readonly asked_at: bigint
  readonly answered_at: bigint | null
}

type ChangedRow = MessageRow & { readonly change_seq: bigint }

const columns =
  'id, run_id, stage_id, model_version, question, backend, cross_vendor, status, answer, citations, unconfirmed_citations, insufficient_data, view_rule_id, view_rule_error, error, asked_at, answered_at'

const storedNumber = /^[1-9][0-9]{0,18}$/

const largestStoredNumber = 9_223_372_036_854_775_807n

const storedKey = (id: string): bigint | null => {
  if (!storedNumber.test(id)) {
    return null
  }
  const key = BigInt(id)
  return key <= largestStoredNumber ? key : null
}

const toMessage = (row: MessageRow): ChatMessage =>
  ChatMessage.parse({
    id: String(row.id),
    run: row.run_id,
    stage: row.stage_id,
    question: row.question,
    status: row.status,
    version: Number(row.model_version),
    answer: row.answer,
    citations: decodeJson(row.citations),
    unconfirmed_citations: row.unconfirmed_citations === 1n,
    insufficient_data: row.insufficient_data === 1n,
    view_rule: row.view_rule_id === null ? null : String(row.view_rule_id),
    view_rule_error: row.view_rule_error,
    error: row.error,
    asked_at: row.asked_at,
    answered_at: row.answered_at,
  })

const toScoped = (row: MessageRow): ScopedChatMessage => ({
  message: toMessage(row),
  scope: { backend: Runtime.parse(row.backend), cross_vendor: row.cross_vendor === 1n },
})

export const createChat = (database: DatabaseSync): ChatRepository => {
  const selectMessage = prepareStatement(database, `SELECT ${columns} FROM chat_messages WHERE run_id = ? AND id = ?`)
  const selectMessages = prepareStatement(database, `SELECT ${columns} FROM chat_messages WHERE run_id = ? ORDER BY id`)
  const selectChanged = prepareStatement(
    database,
    `SELECT ${columns}, change_seq FROM chat_messages WHERE run_id = ? AND change_seq > ? ORDER BY change_seq`,
  )
  const selectPending = prepareStatement(
    database,
    `SELECT ${columns} FROM chat_messages WHERE status = 'pending' ORDER BY id`,
  )
  const insertQuestion = prepareStatement(
    database,
    `INSERT INTO chat_messages (run_id, stage_id, model_version, question, backend, cross_vendor, status, asked_at, change_seq)
     VALUES (:run_id, :stage_id, :model_version, :question, :backend, :cross_vendor, 'pending', :asked_at, :change_seq)
     RETURNING ${columns}`,
  )
  const updateAnswer = prepareStatement(
    database,
    `UPDATE chat_messages SET status = 'answered', answer = :answer, citations = :citations,
       unconfirmed_citations = :unconfirmed_citations, insufficient_data = :insufficient_data,
       view_rule_id = :view_rule_id, view_rule_error = :view_rule_error, answered_at = :answered_at,
       change_seq = :change_seq
     WHERE run_id = :run_id AND id = :id
     RETURNING ${columns}`,
  )
  const updateFailure = prepareStatement(
    database,
    `UPDATE chat_messages SET status = 'failed', error = :error, answered_at = :answered_at, change_seq = :change_seq
     WHERE run_id = :run_id AND id = :id
     RETURNING ${columns}`,
  )

  const message = (run: RunId, id: ChatMessageId): ChatMessage | null => {
    const key = storedKey(id)
    const row = key === null ? undefined : (selectMessage.get(run, key) as MessageRow | undefined)
    return row === undefined ? null : toMessage(row)
  }

  const reader: ChatReader = {
    message,
    messages: (run) => (selectMessages.all(run) as MessageRow[]).map(toMessage),
    scoped: (run) => (selectMessages.all(run) as MessageRow[]).map(toScoped),
    changed: (run, after) =>
      (selectChanged.all(run, after) as ChangedRow[]).map((row) => ({
        change_seq: ChangeSeq.parse(Number(row.change_seq)),
        message: toMessage(row),
      })),
    pending: () => (selectPending.all() as MessageRow[]).map(toMessage),
  }

  const pendingKey = (run: RunId, id: ChatMessageId): bigint => {
    const key = storedKey(id)
    if (key === null || message(run, id)?.status !== 'pending') {
      throw new Error(`chat message ${id} of run ${run} is missing or no longer pending`)
    }
    return key
  }

  const ruleKey = (id: ViewRuleId | null): bigint | null => {
    const key = id === null ? null : storedKey(id)
    if (id !== null && key === null) {
      throw new Error(`view rule ${id} is not a stored view rule id`)
    }
    return key
  }

  const writer = (context: WriteContext): ChatWriter => ({
    ...reader,
    ask: (question) => {
      context.assertActive()
      return toMessage(
        insertQuestion.get({
          run_id: question.run,
          stage_id: question.stage,
          model_version: question.version,
          question: question.question,
          backend: question.scope.backend,
          cross_vendor: encodeFlag(question.scope.cross_vendor),
          asked_at: question.asked_at,
          change_seq: context.nextChangeSeq(),
        }) as MessageRow,
      )
    },
    answer: (run, id, answer) => {
      context.assertActive()
      const key = pendingKey(run, id)
      return toMessage(
        updateAnswer.get({
          run_id: run,
          id: key,
          answer: answer.answer,
          citations: encodeJson(answer.citations),
          unconfirmed_citations: encodeFlag(answer.unconfirmed_citations),
          insufficient_data: encodeFlag(answer.insufficient_data),
          view_rule_id: ruleKey(answer.view_rule),
          view_rule_error: answer.view_rule_error,
          answered_at: answer.answered_at,
          change_seq: context.nextChangeSeq(),
        }) as MessageRow,
      )
    },
    fail: (run, id, failure) => {
      context.assertActive()
      const key = pendingKey(run, id)
      return toMessage(
        updateFailure.get({
          run_id: run,
          id: key,
          error: failure.error,
          answered_at: failure.answered_at,
          change_seq: context.nextChangeSeq(),
        }) as MessageRow,
      )
    },
  })

  return { reader, writer }
}
