import type { DatabaseSync } from 'node:sqlite'
import {
  type ActionId,
  ArtifactVersion,
  type ArtifactVersionId,
  type ChangeSeq,
  type ContentHash,
  type EpochNs,
  GitSnapshot,
  type GitSnapshotId,
  type RunId,
  type VersionRetention,
} from '@aang/contract'
import { canonicalJson, contentHash, objectId } from '@aang/contract/ids'
import { decodeJson, encodeJson } from './codec.js'
import { insertInto, prepareStatement, type WriteContext } from './context.js'

export type ArtifactVersionDraft = Omit<ArtifactVersion, 'change_seq'>
export type GitSnapshotDraft = Omit<GitSnapshot, 'change_seq'>

export type RetainedContent =
  | { readonly kind: 'action_payload'; readonly action: ActionId; readonly content: Uint8Array }
  | { readonly kind: 'file_read'; readonly read_at: EpochNs; readonly content: Uint8Array }
  | { readonly kind: 'hash_only'; readonly content_hash: ContentHash; readonly size_bytes: number }

export interface ArtifactReader {
  readonly getVersion: (id: ArtifactVersionId) => ArtifactVersion | null
  readonly versions: (run: RunId) => ArtifactVersion[]
  readonly versionsCreated: (run: RunId, after: ChangeSeq) => ArtifactVersion[]
  readonly unretained: () => ArtifactVersion[]
  readonly blob: (hash: ContentHash) => Uint8Array | null
  readonly getSnapshot: (id: GitSnapshotId) => GitSnapshot | null
  readonly snapshots: (run: RunId) => GitSnapshot[]
}

export interface ArtifactWriter extends ArtifactReader {
  readonly saveVersion: (draft: ArtifactVersionDraft) => ArtifactVersion
  readonly retain: (id: ArtifactVersionId, retained: RetainedContent) => ArtifactVersion
  readonly saveSnapshot: (draft: GitSnapshotDraft) => GitSnapshot
}

export interface ArtifactRepository {
  readonly reader: ArtifactReader
  readonly writer: (context: WriteContext) => ArtifactWriter
}

export type ArtifactObject = ArtifactVersion | GitSnapshot

export const artifactKinds = "'artifact_version', 'git_snapshot'"

export const isArtifactKind = (kind: string): kind is ArtifactObject['key']['kind'] =>
  kind === 'artifact_version' || kind === 'git_snapshot'

export const toArtifactObject = (kind: ArtifactObject['key']['kind'], data: string): ArtifactObject =>
  kind === 'artifact_version' ? ArtifactVersion.parse(decodeJson(data)) : GitSnapshot.parse(decodeJson(data))

const sameObject = (left: ArtifactObject, right: ArtifactObject): boolean =>
  encodeJson({ ...left, change_seq: 0 }) === encodeJson({ ...right, change_seq: 0 })

type StoreBlob = (source: 'action_payload' | 'file_read', content: Uint8Array, readAt: EpochNs | null) => ContentHash

const retentionOf = (retained: RetainedContent, storeBlob: StoreBlob): VersionRetention => {
  switch (retained.kind) {
    case 'action_payload':
      return { kind: 'action_payload', blob: storeBlob('action_payload', retained.content, null), action: retained.action }
    case 'file_read':
      return { kind: 'file_read', blob: storeBlob('file_read', retained.content, retained.read_at), read_at: retained.read_at }
    case 'hash_only':
      return { kind: 'hash_only', content_hash: retained.content_hash, size_bytes: retained.size_bytes }
  }
}

export const createArtifacts = (database: DatabaseSync): ArtifactRepository => {
  const selectById = prepareStatement(database, 'SELECT data FROM objects WHERE id = ? AND kind = ?')
  const selectOfRun = prepareStatement(
    database,
    'SELECT data FROM objects WHERE kind = ? AND run_id = ? ORDER BY change_seq, id',
  )
  const selectCreated = prepareStatement(
    database,
    "SELECT data FROM objects WHERE kind = 'artifact_version' AND run_id = ? AND created_seq > ? ORDER BY created_seq, id",
  )
  const selectUnretained = prepareStatement(
    database,
    "SELECT data FROM objects WHERE kind = 'artifact_version' AND json_extract(data, '$.retention.kind') = 'reference' ORDER BY run_id, change_seq, id",
  )
  const selectBlob = prepareStatement(database, 'SELECT content FROM blobs WHERE hash = ?')
  const insertBlob = prepareStatement(database, 'INSERT INTO blobs (hash, content) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING')
  const insertBlobRef = prepareStatement(
    database,
    'INSERT INTO blob_refs (hash, version_id, source, read_at) VALUES (?, ?, ?, ?) ON CONFLICT (hash, version_id) DO NOTHING',
  )
  const upsert = prepareStatement(
    database,
    `${insertInto('objects', ['id', 'kind', 'entity_key', 'run_id', 'data', 'change_seq', 'created_seq'])}
     ON CONFLICT (id) DO UPDATE SET run_id = excluded.run_id, data = excluded.data, change_seq = excluded.change_seq`,
  )

  const getVersion = (id: ArtifactVersionId): ArtifactVersion | null => {
    const row = selectById.get(id, 'artifact_version') as { readonly data: string } | undefined
    return row === undefined ? null : ArtifactVersion.parse(decodeJson(row.data))
  }
  const getSnapshot = (id: GitSnapshotId): GitSnapshot | null => {
    const row = selectById.get(id, 'git_snapshot') as { readonly data: string } | undefined
    return row === undefined ? null : GitSnapshot.parse(decodeJson(row.data))
  }
  const ofRun = (kind: string, run: RunId): unknown[] =>
    (selectOfRun.all(kind, run) as { readonly data: string }[]).map(({ data }) => decodeJson(data))

  const reader: ArtifactReader = {
    getVersion,
    versions: (run) => ofRun('artifact_version', run).map((value) => ArtifactVersion.parse(value)),
    versionsCreated: (run, after) =>
      (selectCreated.all(run, after) as { readonly data: string }[]).map(({ data }) =>
        ArtifactVersion.parse(decodeJson(data)),
      ),
    unretained: () =>
      (selectUnretained.all() as { readonly data: string }[]).map(({ data }) => ArtifactVersion.parse(decodeJson(data))),
    blob: (hash) => {
      const row = selectBlob.get(hash) as { readonly content: Uint8Array } | undefined
      return row === undefined ? null : row.content
    },
    getSnapshot,
    snapshots: (run) => ofRun('git_snapshot', run).map((value) => GitSnapshot.parse(value)),
  }

  const writer = (context: WriteContext): ArtifactWriter => {
    const write = <T extends ArtifactObject>(object: T, previous: T | null): T => {
      if (previous !== null && sameObject(previous, object)) {
        return previous
      }
      const stored = { ...object, change_seq: context.nextChangeSeq() }
      upsert.run({
        id: stored.id,
        kind: stored.key.kind,
        entity_key: canonicalJson(stored.key),
        run_id: stored.run,
        data: encodeJson(stored),
        change_seq: stored.change_seq,
        created_seq: stored.key.kind === 'artifact_version' ? stored.change_seq : null,
      })
      return stored
    }

    return {
      ...reader,
      saveVersion: (draft) => {
        context.assertActive()
        if (draft.id !== objectId(draft.key) || draft.run !== draft.key.run) {
          throw new Error('artifact version id or run does not match its key')
        }
        if (draft.artifact !== objectId({ kind: 'artifact', run: draft.run, artifact: draft.ref })) {
          throw new Error('artifact version does not belong to its artifact')
        }
        const version = ArtifactVersion.parse({ ...draft, change_seq: 1 })
        return write(version, getVersion(draft.id))
      },
      retain: (id, retained) => {
        context.assertActive()
        const version = getVersion(id)
        if (version === null) {
          throw new Error(`unknown artifact version ${id}`)
        }
        if (version.retention.kind !== 'reference') {
          throw new Error(`artifact version ${id} is already retained`)
        }
        const storeBlob: StoreBlob = (source, content, readAt) => {
          const hash = contentHash(content)
          insertBlob.run(hash, content)
          insertBlobRef.run(hash, id, source, readAt)
          return hash
        }
        return write({ ...version, retention: retentionOf(retained, storeBlob) }, version)
      },
      saveSnapshot: (draft) => {
        context.assertActive()
        if (draft.id !== objectId(draft.key)) {
          throw new Error('git snapshot id does not match its key')
        }
        const snapshot = GitSnapshot.parse({ ...draft, change_seq: 1 })
        return write(snapshot, getSnapshot(draft.id))
      },
    }
  }

  return { reader, writer }
}
