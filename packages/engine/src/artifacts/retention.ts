import { createHash } from 'node:crypto'
import { type FileHandle, open, stat } from 'node:fs/promises'
import { type ArtifactVersion, type ArtifactVersionId, ContentHash, type EpochNs, type RunId } from '@aang/contract'
import { contentHash } from '@aang/contract/ids'
import type { RetainedContent, Store } from '@aang/store'
import { actionCandidates } from './references.js'

export interface RetentionOptions {
  readonly maxBlobBytes: number
  readonly now: () => EpochNs
}

const hashOnly = (content: Uint8Array): RetainedContent => ({
  kind: 'hash_only',
  content_hash: contentHash(content),
  size_bytes: content.byteLength,
})

const basesOf = (store: Store, run: RunId): Set<ArtifactVersionId> =>
  new Set(
    store.model.entities(run).flatMap((entity) => {
      if (entity.kind !== 'link') {
        return []
      }
      const link = entity.value
      return link.kind === 'artifact' ? [link.version] : link.kind === 'dependency' && link.via !== null ? [link.via] : []
    }),
  )

const payloadContent = (store: Store, version: ArtifactVersion, limit: number): RetainedContent | null => {
  const { identity } = version.key
  const action = version.produced_by === null ? null : store.observations.getAction(version.produced_by)
  if (identity.kind !== 'content' || action === null || version.ref.kind !== 'file') {
    return null
  }
  const { path } = version.ref
  const content =
    actionCandidates(store.facts.ofEntity(action.key)).find(
      (candidate) => candidate.path === path && candidate.content !== null && contentHash(candidate.content) === identity.hash,
    )?.content ?? null
  if (content === null) {
    return null
  }
  const bytes = Buffer.from(content, 'utf8')
  return bytes.byteLength > limit ? hashOnly(bytes) : { kind: 'action_payload', action: action.id, content: bytes }
}

const streamedHash = async (handle: FileHandle): Promise<RetainedContent> => {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    const bytes = chunk as Buffer
    hash.update(bytes)
    size += bytes.byteLength
  }
  return { kind: 'hash_only', content_hash: ContentHash.parse(hash.digest('hex')), size_bytes: size }
}

const fileContent = async (path: string, { maxBlobBytes, now }: RetentionOptions): Promise<RetainedContent | null> => {
  let handle: FileHandle | null = null
  try {
    if (!(await stat(path)).isFile()) {
      return null
    }
    handle = await open(path, 'r')
    const readAt = now()
    if ((await handle.stat()).size > maxBlobBytes) {
      return await streamedHash(handle)
    }
    const content = await handle.readFile()
    return content.byteLength > maxBlobBytes ? hashOnly(content) : { kind: 'file_read', read_at: readAt, content }
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

const retainedContent = async (
  store: Store,
  version: ArtifactVersion,
  options: RetentionOptions,
): Promise<RetainedContent | null> =>
  payloadContent(store, version, options.maxBlobBytes) ??
  (version.ref.kind === 'file' ? await fileContent(version.ref.path, options) : null)

export const retainBases = async (
  store: Store,
  options: RetentionOptions,
  runs: ReadonlySet<RunId> | null,
): Promise<ArtifactVersion[]> => {
  const scanned = runs ?? new Set(store.artifacts.unretained().map(({ run }) => run))
  const pending = [...scanned].flatMap((run) =>
    [...basesOf(store, run)].flatMap((id) => {
      const version = store.artifacts.getVersion(id)
      return version?.retention.kind === 'reference' ? [version] : []
    }),
  )
  const retained: { readonly version: ArtifactVersion; readonly content: RetainedContent }[] = []
  for (const version of pending) {
    const content = await retainedContent(store, version, options)
    if (content !== null) {
      retained.push({ version, content })
    }
  }
  if (retained.length === 0) {
    return []
  }
  return store.transaction((transaction) =>
    retained.flatMap(({ version, content }) =>
      transaction.artifacts.getVersion(version.id)?.retention.kind === 'reference'
        ? [transaction.artifacts.retain(version.id, content)]
        : [],
    ),
  )
}
