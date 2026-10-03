import type { DatabaseSync } from 'node:sqlite'
import {
  type Basis,
  type ChangeSeq,
  type Evidence,
  ModelChange,
  ModelEntity,
  type ModelEntityRef,
  type ModelOperation,
  ModelVersion,
  ModelVersionRecord,
  Run,
  RunId,
} from '@aang/contract'
import { decodeJson, encodeJson } from './codec.js'
import { insertInto, prepareStatement, type WriteContext } from './context.js'

export interface JournalVersion extends ModelVersionRecord {
  readonly base_version: ModelVersion
}

export interface JournalEntry {
  readonly op: ModelOperation
  readonly target: ModelEntityRef
  readonly before: ModelEntity | null
  readonly after: ModelEntity | null
  readonly basis: Basis
  readonly evidence: Evidence
}

export interface ModelReader {
  readonly entityRuns: (target: ModelEntityRef) => RunId[]
  readonly objectRun: (
    kind: 'action' | 'agent' | 'artifact_version' | 'session',
    id: string,
  ) => RunId | null | undefined
  readonly head: (run: RunId) => ModelVersion
  readonly versionAt: (run: RunId, position: ChangeSeq) => ModelVersion
  readonly version: (run: RunId, version: ModelVersion) => ModelVersionRecord | null
  readonly versions: (run: RunId, after: ChangeSeq) => ModelVersionRecord[]
  readonly runs: () => Run[]
  readonly entity: (run: RunId, target: ModelEntityRef) => ModelEntity | null
  readonly entities: (run: RunId) => ModelEntity[]
  readonly forksOf: (parent: RunId) => RunId[]
  readonly changes: (run: RunId, after: ModelVersion) => ModelChange[]
  readonly entityChanges: (run: RunId, target: ModelEntityRef, after: ModelVersion) => ModelChange[]
}

export interface ModelWriter extends ModelReader {
  readonly commit: (version: JournalVersion, entries: readonly JournalEntry[]) => ModelChange[]
  readonly replay: () => void
}

export interface ModelRepository {
  readonly reader: ModelReader
  readonly writer: (context: WriteContext) => ModelWriter
}

type VersionRow = {
  readonly run_id: string
  readonly version: bigint
  readonly base_version: bigint
  readonly author: string
  readonly observer_call_id: string | null
  readonly created_at: bigint
  readonly change_seq: bigint
}

type EntityRow = {
  readonly kind: string
  readonly data: string
}

type ChangeRow = {
  readonly run_id: string
  readonly version: bigint
  readonly change_index: bigint
  readonly operation: string
  readonly entity_kind: string
  readonly entity_id: string
  readonly before_state: string | null
  readonly after_state: string | null
  readonly author: string
  readonly basis: string
  readonly interpreter: string | null
  readonly evidence: string
  readonly observer_call_id: string | null
  readonly change_seq: bigint
}

type ReplayRow = Pick<ChangeRow, 'run_id' | 'version' | 'entity_kind' | 'entity_id' | 'after_state' | 'change_seq'>

const versionColumns = ['run_id', 'version', 'base_version', 'author', 'observer_call_id', 'created_at', 'change_seq']

const changeColumns = [
  'run_id',
  'version',
  'change_index',
  'operation',
  'entity_kind',
  'entity_id',
  'before_state',
  'after_state',
  'author',
  'basis',
  'interpreter',
  'evidence',
  'observer_call_id',
]

const journal = 'model_changes c JOIN model_versions v ON v.run_id = c.run_id AND v.version = c.version'

const selectChangeColumns = [...changeColumns.map((column) => `c.${column}`), 'v.change_seq'].join(', ')

const interpreterOf = (basis: Basis): string | null => {
  if (basis.kind !== 'interpreted') {
    return null
  }
  const { interpreter } = basis
  return interpreter.kind === 'rule' ? `rule:${interpreter.rule}` : `llm:${interpreter.call}`
}

const basisOf = (kind: string, interpreter: string | null): unknown => {
  if (interpreter === null) {
    return { kind }
  }
  const separator = interpreter.indexOf(':')
  const name = interpreter.slice(separator + 1)
  return {
    kind,
    interpreter:
      interpreter.slice(0, separator) === 'rule' ? { kind: 'rule', rule: name } : { kind: 'llm', call: name },
  }
}

const stateOf = (entity: ModelEntity | null): string | null => (entity === null ? null : encodeJson(entity.value))

const entityOf = (kind: string, state: string | null): unknown =>
  state === null ? null : { kind, value: decodeJson(state) }

const toVersion = (row: VersionRow): ModelVersionRecord =>
  ModelVersionRecord.parse({
    run: row.run_id,
    version: Number(row.version),
    base_version: Number(row.base_version),
    author: row.author,
    observer_call: row.observer_call_id,
    created_at: row.created_at,
    change_seq: Number(row.change_seq),
  })

const toEntity = (row: EntityRow): ModelEntity => ModelEntity.parse(entityOf(row.kind, row.data))

const toChange = (row: ChangeRow): ModelChange =>
  ModelChange.parse({
    run: row.run_id,
    version: Number(row.version),
    index: Number(row.change_index),
    op: row.operation,
    target: { kind: row.entity_kind, id: row.entity_id },
    before: entityOf(row.entity_kind, row.before_state),
    after: entityOf(row.entity_kind, row.after_state),
    author: row.author,
    basis: basisOf(row.basis, row.interpreter),
    evidence: decodeJson(row.evidence),
    observer_call: row.observer_call_id,
    change_seq: Number(row.change_seq),
  })

export const createModel = (database: DatabaseSync): ModelRepository => {
  const selectEntityRuns = prepareStatement(
    database,
    'SELECT run_id FROM model_entities WHERE kind = ? AND id = ?',
  )
  const selectObjectRun = prepareStatement(database, 'SELECT run_id FROM objects WHERE kind = ? AND id = ?')
  const selectHead = prepareStatement(
    database,
    'SELECT COALESCE(MAX(version), 0) AS head FROM model_versions WHERE run_id = ?',
  )
  const selectVersionAt = prepareStatement(
    database,
    'SELECT COALESCE(MAX(version), 0) AS version FROM model_versions WHERE run_id = ? AND change_seq <= ?',
  )
  const selectVersion = prepareStatement(
    database,
    `SELECT ${versionColumns.join(', ')} FROM model_versions WHERE run_id = ? AND version = ?`,
  )
  const selectVersions = prepareStatement(
    database,
    `SELECT ${versionColumns.join(', ')} FROM model_versions WHERE run_id = ? AND change_seq > ? ORDER BY version`,
  )
  const selectRuns = prepareStatement(database, "SELECT data FROM model_entities WHERE kind = 'run' ORDER BY id")
  const selectEntity = prepareStatement(
    database,
    'SELECT kind, data FROM model_entities WHERE run_id = ? AND kind = ? AND id = ?',
  )
  const selectEntities = prepareStatement(
    database,
    'SELECT kind, data FROM model_entities WHERE run_id = ? ORDER BY kind, id',
  )
  const selectForks = prepareStatement(
    database,
    `SELECT run_id FROM model_entities WHERE kind = 'link' AND json_extract(data, '$.kind') = 'forked_from'
     AND json_extract(data, '$.parent') = ? ORDER BY run_id`,
  )
  const selectChanges = prepareStatement(
    database,
    `SELECT ${selectChangeColumns} FROM ${journal} WHERE c.run_id = ? AND c.version > ? ORDER BY c.version, c.change_index`,
  )
  const selectEntityChanges = prepareStatement(
    database,
    `SELECT ${selectChangeColumns} FROM ${journal}
     WHERE c.run_id = ? AND c.entity_kind = ? AND c.entity_id = ? AND c.version > ?
     ORDER BY c.version, c.change_index`,
  )
  const selectJournal = prepareStatement(
    database,
    `SELECT c.run_id, c.version, c.entity_kind, c.entity_id, c.after_state, v.change_seq FROM ${journal}
     ORDER BY c.run_id, c.version, c.change_index`,
  )
  const insertVersion = prepareStatement(database, insertInto('model_versions', versionColumns))
  const insertChange = prepareStatement(database, insertInto('model_changes', changeColumns))
  const upsertEntity = prepareStatement(
    database,
    `INSERT INTO model_entities (run_id, kind, id, data, version, change_seq)
     VALUES (:run_id, :kind, :id, :data, :version, :change_seq)
     ON CONFLICT (run_id, kind, id) DO UPDATE SET
       data = excluded.data, version = excluded.version, change_seq = excluded.change_seq`,
  )
  const deleteEntity = prepareStatement(database, 'DELETE FROM model_entities WHERE run_id = ? AND kind = ? AND id = ?')
  const deleteEntities = prepareStatement(database, 'DELETE FROM model_entities')

  const project = (change: ReplayRow): void => {
    if (change.after_state === null) {
      deleteEntity.run(change.run_id, change.entity_kind, change.entity_id)
      return
    }
    upsertEntity.run({
      run_id: change.run_id,
      kind: change.entity_kind,
      id: change.entity_id,
      data: change.after_state,
      version: change.version,
      change_seq: change.change_seq,
    })
  }

  const reader: ModelReader = {
    entityRuns: (target) =>
      (selectEntityRuns.all(target.kind, target.id) as { run_id: string }[]).map((row) =>
        RunId.parse(row.run_id),
      ),
    objectRun: (kind, id) => {
      const row = selectObjectRun.get(kind, id) as { run_id: string | null } | undefined
      return row === undefined ? undefined : row.run_id === null ? null : RunId.parse(row.run_id)
    },
    head: (run) => ModelVersion.parse(Number((selectHead.get(run) as { readonly head: bigint }).head)),
    versionAt: (run, position) =>
      ModelVersion.parse(Number((selectVersionAt.get(run, position) as { readonly version: bigint }).version)),
    version: (run, version) => {
      const row = selectVersion.get(run, version) as VersionRow | undefined
      return row === undefined ? null : toVersion(row)
    },
    versions: (run, after) => (selectVersions.all(run, after) as VersionRow[]).map(toVersion),
    runs: () => (selectRuns.all() as { readonly data: string }[]).map(({ data }) => Run.parse(decodeJson(data))),
    entity: (run, target) => {
      const row = selectEntity.get(run, target.kind, target.id) as EntityRow | undefined
      return row === undefined ? null : toEntity(row)
    },
    entities: (run) => (selectEntities.all(run) as EntityRow[]).map(toEntity),
    forksOf: (parent) =>
      (selectForks.all(parent) as { run_id: string }[]).map((row) => RunId.parse(row.run_id)),
    changes: (run, after) => (selectChanges.all(run, after) as ChangeRow[]).map(toChange),
    entityChanges: (run, target, after) =>
      (selectEntityChanges.all(run, target.kind, target.id, after) as ChangeRow[]).map(toChange),
  }

  const writer = (context: WriteContext): ModelWriter => ({
    ...reader,
    commit: (version, entries) => {
      context.assertActive()
      insertVersion.run({
        run_id: version.run,
        version: version.version,
        base_version: version.base_version,
        author: version.author,
        observer_call_id: version.observer_call,
        created_at: version.created_at,
        change_seq: version.change_seq,
      })
      return entries.map((entry, index): ModelChange => {
        const afterState = stateOf(entry.after)
        insertChange.run({
          run_id: version.run,
          version: version.version,
          change_index: index,
          operation: entry.op,
          entity_kind: entry.target.kind,
          entity_id: entry.target.id,
          before_state: stateOf(entry.before),
          after_state: afterState,
          author: version.author,
          basis: entry.basis.kind,
          interpreter: interpreterOf(entry.basis),
          evidence: encodeJson(entry.evidence),
          observer_call_id: version.observer_call,
        })
        project({
          run_id: version.run,
          version: BigInt(version.version),
          entity_kind: entry.target.kind,
          entity_id: entry.target.id,
          after_state: afterState,
          change_seq: BigInt(version.change_seq),
        })
        return {
          run: version.run,
          version: version.version,
          index,
          op: entry.op,
          target: entry.target,
          before: entry.before,
          after: entry.after,
          author: version.author,
          basis: entry.basis,
          evidence: entry.evidence,
          observer_call: version.observer_call,
          change_seq: version.change_seq,
        }
      })
    },
    replay: () => {
      context.assertActive()
      deleteEntities.run()
      for (const change of selectJournal.iterate() as Iterable<ReplayRow>) {
        project(change)
      }
    },
  })

  return { reader, writer }
}
