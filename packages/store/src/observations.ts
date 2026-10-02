import type { DatabaseSync } from 'node:sqlite'
import {
  Action,
  type ActionId,
  Agent,
  type AgentId,
  Question,
  type QuestionId,
  Session,
  type SessionId,
} from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import { decodeJson, encodeJson } from './codec.js'
import { prepareStatement, upsertInto, type WriteContext } from './context.js'

export type Observation = Session | Agent | Action | Question
export type ObservationDraft =
  | Omit<Session, 'change_seq'>
  | Omit<Agent, 'change_seq'>
  | Omit<Action, 'change_seq'>
  | Omit<Question, 'change_seq'>

export interface ObservationReader {
  readonly getSession: (id: SessionId) => Session | null
  readonly getAgent: (id: AgentId) => Agent | null
  readonly getAction: (id: ActionId) => Action | null
  readonly getQuestion: (id: QuestionId) => Question | null
  readonly sessions: () => Session[]
  readonly agents: (session: SessionId) => Agent[]
  readonly actions: (session: SessionId) => Action[]
  readonly questions: (session: SessionId) => Question[]
}

export interface ObservationWriter extends ObservationReader {
  readonly save: (draft: ObservationDraft) => Observation
}

export interface ObservationRepository {
  readonly reader: ObservationReader
  readonly writer: (context: WriteContext) => ObservationWriter
}

export type ObservationRow = { readonly kind: string; readonly data: string; readonly change_seq: bigint }

export const toObservation = (row: ObservationRow): Observation => {
  const value = decodeJson(row.data)
  switch (row.kind) {
    case 'session':
      return Session.parse(value)
    case 'agent':
      return Agent.parse(value)
    case 'action':
      return Action.parse(value)
    case 'question':
      return Question.parse(value)
    default:
      throw new Error(`unsupported observation kind: ${row.kind}`)
  }
}

export const observationKinds = "'session', 'agent', 'action', 'question'"

export const createObservations = (database: DatabaseSync): ObservationRepository => {
  const selectById = prepareStatement(
    database,
    'SELECT kind, data, change_seq FROM objects WHERE id = ? AND kind = ?',
  )
  const selectSessions = prepareStatement(
    database,
    "SELECT data FROM objects WHERE kind = 'session' ORDER BY entity_key",
  )
  const selectMembers = prepareStatement(
    database,
    "SELECT data FROM objects WHERE kind = ? AND json_extract(data, '$.session') = ? ORDER BY entity_key",
  )
  const upsert = prepareStatement(
    database,
    upsertInto('objects', 'id', ['id', 'kind', 'entity_key', 'run_id', 'data', 'change_seq']),
  )
  const get = (id: string, kind: string): unknown => {
    const row = selectById.get(id, kind) as ObservationRow | undefined
    return row === undefined ? null : decodeJson(row.data)
  }
  const members = (kind: string, session: SessionId): unknown[] =>
    (selectMembers.all(kind, session) as { readonly data: string }[]).map(({ data }) => decodeJson(data))
  const reader: ObservationReader = {
    getSession: (id) => Session.nullable().parse(get(id, 'session')),
    getAgent: (id) => Agent.nullable().parse(get(id, 'agent')),
    getAction: (id) => Action.nullable().parse(get(id, 'action')),
    getQuestion: (id) => Question.nullable().parse(get(id, 'question')),
    sessions: () =>
      (selectSessions.all() as { readonly data: string }[]).map(({ data }) =>
        Session.parse(decodeJson(data)),
      ),
    agents: (session) => members('agent', session).map((value) => Agent.parse(value)),
    actions: (session) => members('action', session).map((value) => Action.parse(value)),
    questions: (session) => members('question', session).map((value) => Question.parse(value)),
  }
  return {
    reader,
    writer: (context) => ({
      ...reader,
      save: (draft) => {
        context.assertActive()
        if (draft.id !== objectId(draft.key)) {
          throw new Error('observation id does not match its key')
        }
        const normalized = toObservation({
          kind: draft.key.kind,
          data: encodeJson({ ...draft, change_seq: 1 }),
          change_seq: 1n,
        })
        const row = selectById.get(draft.id, draft.key.kind) as ObservationRow | undefined
        const previous = row === undefined ? null : toObservation(row)
        if (
          previous !== null &&
          encodeJson({ ...previous, change_seq: 0 }) === encodeJson({ ...normalized, change_seq: 0 })
        ) {
          return previous
        }
        const changeSeq = context.nextChangeSeq()
        const object = { ...normalized, change_seq: changeSeq }
        const data = encodeJson(object)
        upsert.run({
          id: object.id,
          kind: object.key.kind,
          entity_key: canonicalJson(object.key),
          run_id: object.run,
          data,
          change_seq: changeSeq,
        })
        return object
      },
    }),
  }
}
