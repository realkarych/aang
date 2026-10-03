import { createHash } from 'node:crypto'
import { type FileHandle, open, stat } from 'node:fs/promises'
import {
  type ActionId,
  type ArtifactVersion,
  type ArtifactVersionId,
  ContentHash,
  type EpochNs,
  type Fact,
  type RunId,
  type SessionId,
} from '@aang/contract'
import { contentHash, objectId } from '@aang/contract/ids'
import type { RetainedContent, Store } from '@aang/store'
import { applyPatch } from './patches.js'
import { actionCandidates, type FilePatch } from './references.js'
import { actionWrites, type PathWrite } from './versions.js'

export interface RetentionOptions {
  readonly maxBlobBytes: number
  readonly now: () => EpochNs
}

type History = ReadonlyMap<string, readonly PathWrite[]>

interface Retention {
  readonly store: Store
  readonly options: RetentionOptions
  readonly histories: Map<RunId, History>
  readonly contents: Map<string, string | null>
}

const hashOnly = (content: Uint8Array): RetainedContent => ({
  kind: 'hash_only',
  content_hash: contentHash(content),
  size_bytes: content.byteLength,
})

const produced = (action: ActionId, content: string, limit: number): RetainedContent => {
  const bytes = Buffer.from(content, 'utf8')
  return bytes.byteLength > limit ? hashOnly(bytes) : { kind: 'action_payload', action, content: bytes }
}

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

const sessionsOf = (store: Store, run: RunId, session: SessionId): SessionId[] => [
  ...new Set([
    session,
    ...store.model.entities(run).flatMap((entity) => (entity.kind === 'session_membership' ? [entity.value.session] : [])),
  ]),
]

const added = <T>(groups: Map<string, T[]>, key: string, value: T): void => {
  const group = groups.get(key)
  if (group === undefined) {
    groups.set(key, [value])
  } else {
    group.push(value)
  }
}

const historyOf = (store: Store, run: RunId, session: SessionId): History => {
  const history = new Map<string, PathWrite[]>()
  for (const id of sessionsOf(store, run, session)) {
    const owner = store.observations.getSession(id)
    if (owner === null) {
      continue
    }
    const facts = new Map<string, Fact[]>()
    for (const fact of store.facts.ofSession(owner.key)) {
      if (fact.entity_key.kind === 'action') {
        added(facts, objectId(fact.entity_key), fact)
      }
    }
    for (const action of store.observations.actions(id)) {
      if (action.inherited) {
        continue
      }
      for (const write of actionWrites(action, facts.get(action.id) ?? [], owner.cwd)) {
        added(history, write.path, write)
      }
    }
  }
  return history
}

const baseOf = (history: History, write: PathWrite, path: string): PathWrite | null => {
  const others = (history.get(path) ?? []).filter(({ action }) => action.id !== write.action.id)
  if (others.some(({ started, ended }) => started <= write.ended && ended >= write.started)) {
    return null
  }
  const earlier = others.filter(({ ended }) => ended < write.started)
  const latest = earlier.reduce<PathWrite | null>((found, other) => (found === null || other.ended > found.ended ? other : found), null)
  return latest === null || earlier.filter(({ ended }) => ended === latest.ended).length > 1 ? null : latest
}

const single = <T>(values: readonly T[], key: (value: T) => string): T | null => {
  const distinct = new Map(values.map((value) => [key(value), value]))
  const [only] = distinct.values()
  return distinct.size === 1 && only !== undefined ? only : null
}

const writeKey = ({ action, path }: PathWrite): string => `${action.id}\0${path}`

const contentOf = (retention: Retention, history: History, write: PathWrite): string | null => {
  const patched: { readonly write: PathWrite; readonly patch: FilePatch }[] = []
  let current: PathWrite | null = write
  let content: string | null = null
  while (current !== null) {
    const known = retention.contents.get(writeKey(current))
    if (known !== undefined) {
      content = known
      break
    }
    const full = current.candidates.flatMap(({ content: text }) => (text === null ? [] : [text]))
    const patch = single(
      current.candidates.flatMap((candidate) => (candidate.patch === null ? [] : [candidate.patch])),
      (candidate) => JSON.stringify(candidate),
    )
    if (full.length > 0 || patch === null) {
      content = single(full, (text) => text)
      retention.contents.set(writeKey(current), content)
      break
    }
    patched.push({ write: current, patch })
    current = baseOf(history, current, patch.base)
  }
  for (const { write: step, patch } of patched.toReversed()) {
    content = content === null ? null : applyPatch(patch.change, content)
    retention.contents.set(writeKey(step), content)
  }
  return content
}

const payloadContent = (retention: Retention, version: ArtifactVersion): RetainedContent | null => {
  const { store, options } = retention
  const action = version.produced_by === null ? null : store.observations.getAction(version.produced_by)
  const session = action === null ? null : store.observations.getSession(action.session)
  if (action === null || session === null || version.ref.kind !== 'file') {
    return null
  }
  const { identity } = version.key
  const { path } = version.ref
  const candidates = actionCandidates(store.facts.ofEntity(action.key), session.cwd).filter((candidate) => candidate.path === path)
  if (identity.kind === 'content') {
    const content =
      candidates.find(({ content }) => content !== null && contentHash(content) === identity.hash)?.content ?? null
    return content === null ? null : produced(action.id, content, options.maxBlobBytes)
  }
  if (candidates.every(({ patch }) => patch === null)) {
    return null
  }
  const history = retention.histories.get(version.run) ?? historyOf(store, version.run, session.id)
  retention.histories.set(version.run, history)
  const write = history.get(path)?.find((candidate) => candidate.action.id === action.id)
  const content = write === undefined ? null : contentOf(retention, history, write)
  return content === null ? null : produced(action.id, content, options.maxBlobBytes)
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

const retainedContent = async (retention: Retention, version: ArtifactVersion): Promise<RetainedContent | null> =>
  payloadContent(retention, version) ??
  (version.ref.kind === 'file' ? await fileContent(version.ref.path, retention.options) : null)

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
  const retention: Retention = { store, options, histories: new Map(), contents: new Map() }
  const retained: { readonly version: ArtifactVersion; readonly content: RetainedContent }[] = []
  for (const version of pending) {
    const content = await retainedContent(retention, version)
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
