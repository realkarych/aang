import { relative, sep } from 'node:path'
import type {
  ArtifactContent,
  ArtifactVersion,
  ArtifactVersionId,
  ArtifactVersionResponse,
  EpochNs,
  VersionRetention,
} from '@aang/contract'
import type { Store } from '@aang/store'
import { utf8Text } from '../artifacts/text.js'
import { readGitBytes } from '../ingest/git.js'
import { contains } from '../ingest/scope.js'
import type { ReadContext } from './context.js'

type StoredContent = Extract<ArtifactContent, { kind: 'stored' }>

type UnavailableContent = Extract<ArtifactContent, { kind: 'unavailable' }>

const unavailable = (reason: UnavailableContent['reason']): UnavailableContent => ({ kind: 'unavailable', reason })

const stored = (source: StoredContent['source'], bytes: Uint8Array, readAt: EpochNs | null): StoredContent => {
  const text = utf8Text(bytes)
  return {
    kind: 'stored',
    source,
    encoding: text === null ? 'base64' : 'utf8',
    data: text ?? Buffer.from(bytes).toString('base64'),
    size_bytes: bytes.byteLength,
    read_at: readAt,
  }
}

const keptContent = (store: Store, retention: VersionRetention): ArtifactContent | null => {
  switch (retention.kind) {
    case 'reference':
      return unavailable('reference_only')
    case 'hash_only':
      return unavailable('hash_only')
    case 'action_payload':
    case 'file_read': {
      const bytes = store.artifacts.blob(retention.blob)
      const readAt = retention.kind === 'file_read' ? retention.read_at : null
      return bytes === null ? unavailable('blob_missing') : stored(retention.kind, bytes, readAt)
    }
    case 'commit':
      return null
  }
}

const committedContent = async ({ ref, retention }: ArtifactVersion): Promise<ArtifactContent> => {
  if (retention.kind !== 'commit' || ref.kind !== 'file' || !contains(retention.repository, ref.path)) {
    return unavailable('commit_missing')
  }
  const path = relative(retention.repository, ref.path).split(sep).join('/')
  try {
    const bytes = await readGitBytes(retention.repository, ['cat-file', 'blob', `${retention.sha}:./${path}`])
    return stored('commit', bytes, null)
  } catch {
    return unavailable('commit_missing')
  }
}

export const artifactVersion = async (
  { store }: ReadContext,
  id: ArtifactVersionId,
): Promise<ArtifactVersionResponse | null> => {
  const found = store.read(() => {
    const version = store.artifacts.getVersion(id)
    return version === null ? null : { version, kept: keptContent(store, version.retention) }
  })
  if (found === null) {
    return null
  }
  const { version, kept } = found
  return { version, content: kept ?? (await committedContent(version)) }
}
