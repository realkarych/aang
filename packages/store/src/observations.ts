import type { DatabaseSync } from 'node:sqlite'
import {
  Action,
  type ActionId,
  Agent,
  type AgentId,
  ChangeSeq,
  ObservationRemoval,
  Question,
  type QuestionId,
  RunId,
  Session,
  type SessionId,
  UsageRecord,
  type UsageRecordId,
} from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import { decodeJson, encodeJson } from './codec.js'
import { insertInto, prepareStatement, upsertInto, type WriteContext } from './context.js'

export type Observation = Session | Agent | Action | Question | UsageRecord
export type ObservationKind = Observation['key']['kind']
export type ObservationDraft =
  | Omit<Session, 'change_seq'>
  | Omit<Agent, 'change_seq'>
  | Omit<Action, 'change_seq'>
  | Omit<Question, 'change_seq'>
  | Omit<UsageRecord, 'change_seq'>

export type StoredObservationRemoval = ObservationRemoval & {
  readonly run: RunId | null
  readonly change_seq: ChangeSeq
}

export type RemovedObservation = Pick<ObservationRemoval, 'kind' | 'id'>

export interface ObservationReader {
  readonly getSession: (id: SessionId) => Session | null
  readonly getAgent: (id: AgentId) => Agent | null
  readonly getAction: (id: ActionId) => Action | null
  readonly getQuestion: (id: QuestionId) => Question | null
  readonly getUsage: (id: UsageRecordId) => UsageRecord | null
  readonly getRemoval: (removed: RemovedObservation) => StoredObservationRemoval | null
  readonly sessions: () => Session[]
  readonly agents: (session: SessionId) => Agent[]
  readonly actions: (session: SessionId) => Action[]
  readonly questions: (session: SessionId) => Question[]
  readonly usageRecords: (session: SessionId) => UsageRecord[]
  readonly ofRun: (run: RunId, after: ChangeSeq, kinds?: readonly ObservationKind[]) => Observation[]
  readonly removalsOfRun: (run: RunId, after: ChangeSeq) => StoredObservationRemoval[]
}

export interface ObservationWriter extends ObservationReader {
  readonly save: (draft: ObservationDraft) => Observation
  readonly remove: (removal: ObservationRemoval) => StoredObservationRemoval | null
  readonly delete: (observation: Observation) => void
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
    case 'usage':
      return UsageRecord.parse(value)
    default:
      throw new Error(`unsupported observation kind: ${row.kind}`)
  }
}

export const observationKinds = "'session', 'agent', 'action', 'question', 'usage'"

const everyObservationKind: readonly ObservationKind[] = ['session', 'agent', 'action', 'question', 'usage']

export type RemovalRow = {
  readonly id: string
  readonly kind: string
  readonly run_id: string | null
  readonly replaced_by: string
  readonly change_seq: bigint
}

export const removalColumns = 'id, kind, run_id, replaced_by, change_seq'

export const toRemoval = (row: RemovalRow): StoredObservationRemoval => ({
  ...ObservationRemoval.parse({ kind: row.kind, id: row.id, replaced_by: row.replaced_by }),
  run: row.run_id === null ? null : RunId.parse(row.run_id),
  change_seq: ChangeSeq.parse(Number(row.change_seq)),
})

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
  const deleteObject = prepareStatement(database, 'DELETE FROM objects WHERE id = ? AND kind = ?')
  const selectRemoval = prepareStatement(
    database,
    `SELECT ${removalColumns} FROM object_removals WHERE id = ? AND kind = ?`,
  )
  const selectReplaced = prepareStatement(
    database,
    `SELECT ${removalColumns} FROM object_removals WHERE kind = ? AND replaced_by = ? ORDER BY id`,
  )
  const insertRemoval = prepareStatement(
    database,
    insertInto('object_removals', ['id', 'kind', 'entity_key', 'run_id', 'replaced_by', 'change_seq']),
  )
  const redirectRemoval = prepareStatement(
    database,
    'UPDATE object_removals SET replaced_by = ?, change_seq = ? WHERE id = ?',
  )
  const deleteRemoval = prepareStatement(database, 'DELETE FROM object_removals WHERE id = ?')
  const selectOfRun = prepareStatement(
    database,
    `SELECT kind, data, change_seq FROM objects
     WHERE run_id = ? AND kind IN (SELECT value FROM json_each(?)) AND change_seq > ?
     ORDER BY change_seq, id`,
  )
  const selectRemovalsOfRun = prepareStatement(
    database,
    `SELECT ${removalColumns} FROM object_removals WHERE run_id = ? AND change_seq > ? ORDER BY change_seq, id`,
  )
  const get = (id: string, kind: string): unknown => {
    const row = selectById.get(id, kind) as ObservationRow | undefined
    return row === undefined ? null : decodeJson(row.data)
  }
  const removalOf = ({ kind, id }: RemovedObservation): StoredObservationRemoval | null => {
    const row = selectRemoval.get(id, kind) as RemovalRow | undefined
    return row === undefined ? null : toRemoval(row)
  }
  const members = (kind: string, session: SessionId): unknown[] =>
    (selectMembers.all(kind, session) as { readonly data: string }[]).map(({ data }) => decodeJson(data))
  const reader: ObservationReader = {
    getSession: (id) => Session.nullable().parse(get(id, 'session')),
    getAgent: (id) => Agent.nullable().parse(get(id, 'agent')),
    getAction: (id) => Action.nullable().parse(get(id, 'action')),
    getQuestion: (id) => Question.nullable().parse(get(id, 'question')),
    getUsage: (id) => UsageRecord.nullable().parse(get(id, 'usage')),
    getRemoval: removalOf,
    sessions: () =>
      (selectSessions.all() as { readonly data: string }[]).map(({ data }) =>
        Session.parse(decodeJson(data)),
      ),
    agents: (session) => members('agent', session).map((value) => Agent.parse(value)),
    actions: (session) => members('action', session).map((value) => Action.parse(value)),
    questions: (session) => members('question', session).map((value) => Question.parse(value)),
    usageRecords: (session) => members('usage', session).map((value) => UsageRecord.parse(value)),
    ofRun: (run, after, kinds = everyObservationKind) =>
      (selectOfRun.all(run, JSON.stringify(kinds), after) as ObservationRow[]).map(toObservation),
    removalsOfRun: (run, after) => (selectRemovalsOfRun.all(run, after) as RemovalRow[]).map(toRemoval),
  }
  return {
    reader,
    writer: (context) => {
      const redirect = (
        removal: StoredObservationRemoval,
        replacedBy: StoredObservationRemoval['replaced_by'],
      ): StoredObservationRemoval => {
        const changeSeq = context.nextChangeSeq()
        redirectRemoval.run(replacedBy, changeSeq, removal.id)
        return { ...removal, replaced_by: replacedBy, change_seq: changeSeq }
      }
      const assertStored = ({ kind, replaced_by: replacedBy }: ObservationRemoval): void => {
        if (selectById.get(replacedBy, kind) === undefined) {
          throw new Error(`replacement ${kind} ${replacedBy} is not stored`)
        }
      }
      return {
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
          deleteRemoval.run(object.id)
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
        remove: (input) => {
          context.assertActive()
          const removal = ObservationRemoval.parse(input)
          const { kind, id, replaced_by: replacedBy } = removal
          const row = selectById.get(id, kind) as ObservationRow | undefined
          if (row === undefined) {
            const previous = removalOf(removal)
            if (previous === null || previous.replaced_by === replacedBy) {
              return previous
            }
            assertStored(removal)
            return redirect(previous, replacedBy)
          }
          assertStored(removal)
          const object = toObservation(row)
          const changeSeq = context.nextChangeSeq()
          deleteObject.run(id, kind)
          insertRemoval.run({
            id,
            kind,
            entity_key: canonicalJson(object.key),
            run_id: object.run,
            replaced_by: replacedBy,
            change_seq: changeSeq,
          })
          for (const replaced of selectReplaced.all(kind, id) as RemovalRow[]) {
            redirect(toRemoval(replaced), replacedBy)
          }
          return { ...removal, run: object.run, change_seq: changeSeq }
        },
        delete: (observation) => {
          context.assertActive()
          if (selectReplaced.get(observation.key.kind, observation.id) !== undefined) {
            throw new Error(`${observation.key.kind} ${observation.id} replaces removed observations`)
          }
          if (Number(deleteObject.run(observation.id, observation.key.kind).changes) > 0) {
            context.nextChangeSeq()
          }
        },
      }
    },
  }
}
