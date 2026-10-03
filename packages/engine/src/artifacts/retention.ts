import { createHash } from 'node:crypto'
import { type FileHandle, open, stat } from 'node:fs/promises'
import {
  type Action,
  type ActionId,
  type ActionKind,
  type ArtifactVersion,
  type ArtifactVersionId,
  ContentHash,
  type EpochNs,
  type Fact,
  type FactOf,
  type RunId,
  type SessionId,
} from '@aang/contract'
import { contentHash, objectId } from '@aang/contract/ids'
import type { RetainedContent, Store } from '@aang/store'
import { fieldOf } from '../checks/commands.js'
import { applyPatch } from './patches.js'
import { actionCandidates, type FilePatch } from './references.js'
import { actionWrites, type PathWrite } from './versions.js'

export interface RetentionOptions {
  readonly maxBlobBytes: number
  readonly now: () => EpochNs
}

interface Activity {
  readonly action: ActionId
  readonly started: EpochNs | null
  readonly ended: EpochNs | null
  readonly paths: ReadonlySet<string> | null
}

interface StoredRead {
  readonly at: EpochNs
  readonly blob: ContentHash
}

interface History {
  readonly writes: ReadonlyMap<string, readonly PathWrite[]>
  readonly activities: readonly Activity[]
  readonly reads: ReadonlyMap<string, readonly StoredRead[]>
  readonly originals: ReadonlyMap<ActionId, string | null>
}

type Base = { readonly kind: 'write'; readonly write: PathWrite } | { readonly kind: 'read'; readonly blob: ContentHash }

interface State {
  readonly at: EpochNs
  readonly since: EpochNs
  readonly action: ActionId | null
  readonly base: Base
}

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

const single = <T>(values: readonly T[], key: (value: T) => string): T | null => {
  const distinct = new Map(values.map((value) => [key(value), value]))
  const [only] = distinct.values()
  return distinct.size === 1 && only !== undefined ? only : null
}

const silentKinds: ReadonlySet<ActionKind> = new Set(['file_read', 'search', 'web', 'agent', 'question', 'plan'])

type Start = FactOf<'action_start'>

type End = FactOf<'action_end'>

type Exits = ReadonlyMap<string, readonly EpochNs[]>

const runningProcess = /^Process running with session ID (\d+)$/m

const exitedProcess = /^Process exited with code -?\d+$/m

const extreme = (times: readonly EpochNs[], later: boolean): EpochNs | null =>
  times.reduce<EpochNs | null>((found, time) => (found === null || (later ? time > found : time < found) ? time : found), null)

const startsOf = (facts: readonly Fact[]): Start[] => facts.filter((fact): fact is Start => fact.kind === 'action_start')

const endsOf = (facts: readonly Fact[]): End[] => facts.filter((fact): fact is End => fact.kind === 'action_end')

const headerOf = ({ payload }: End): string => (payload.output ?? '').split(/^Output:$/m, 1)[0] ?? ''

const settles = ({ payload }: End): boolean => payload.exit_code !== null || payload.outcome === 'ok' || payload.outcome === 'error'

const processExits = (actions: readonly Action[], facts: ReadonlyMap<string, readonly Fact[]>): Map<string, EpochNs[]> => {
  const exits = new Map<string, EpochNs[]>()
  for (const action of actions) {
    const own = facts.get(action.id) ?? []
    const polled = new Set(
      startsOf(own).flatMap(({ payload }) => {
        const process = fieldOf(payload.input, 'session_id')
        return payload.action_kind === 'command' && (typeof process === 'number' || typeof process === 'string') ? [String(process)] : []
      }),
    )
    for (const end of endsOf(own).filter((end) => exitedProcess.test(headerOf(end)))) {
      for (const process of polled) {
        added(exits, process, end.at)
      }
    }
  }
  return exits
}

const runningOf = (ends: readonly End[]): { readonly process: string; readonly since: EpochNs } | null => {
  if (ends.some(settles)) {
    return null
  }
  const [running] = ends.flatMap((end) => {
    const process = runningProcess.exec(headerOf(end))?.[1]
    return process === undefined ? [] : [{ process, since: end.at }]
  })
  return running ?? null
}

const endedAt = (action: Action, ends: readonly End[], exits: Exits): EpochNs | null => {
  const running = runningOf(ends)
  return running === null
    ? (extreme(ends.map(({ at }) => at), true) ?? action.ended_at)
    : extreme((exits.get(running.process) ?? []).filter((at) => at >= running.since), false)
}

const activityOf = (action: Action, facts: readonly Fact[], session: string | null, exits: Exits): Activity | null => {
  if (silentKinds.has(action.action_kind) || action.outcome?.value === 'denied') {
    return null
  }
  const starts = startsOf(facts)
  const background = starts.some(({ payload }) => fieldOf(payload.input, 'run_in_background') === true)
  const written = action.action_kind === 'file_write' ? actionCandidates(facts, session) : []
  return {
    action: action.id,
    started: extreme(starts.map(({ at }) => at), false),
    ended: background ? null : endedAt(action, endsOf(facts), exits),
    paths: written.length === 0 ? null : new Set(written.flatMap(({ path, patch }) => (patch === null ? [path] : [path, patch.base]))),
  }
}

const originalOf = (facts: readonly Fact[]): string | null | undefined => {
  const results = facts.flatMap((fact) => (fact.kind === 'action_end' && fact.payload.result !== null ? [fact.payload.result] : []))
  if (results.some((result) => fieldOf(result, 'userModified') === true)) {
    return null
  }
  const originals = results.flatMap((result) => {
    const original = fieldOf(result, 'originalFile')
    return typeof original === 'string' ? [original] : []
  })
  return originals.length === 0 ? undefined : single(originals, (text) => text)
}

const storedReads = (store: Store, run: RunId): Map<string, StoredRead[]> => {
  const reads = new Map<string, StoredRead[]>()
  for (const { ref, retention } of store.artifacts.versions(run)) {
    if (ref.kind === 'file' && retention.kind === 'file_read') {
      added(reads, ref.path, { at: retention.read_at, blob: retention.blob })
    }
  }
  return reads
}

const historyOf = (store: Store, run: RunId, session: SessionId): History => {
  const writes = new Map<string, PathWrite[]>()
  const activities: Activity[] = []
  const originals = new Map<ActionId, string | null>()
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
    const actions = store.observations.actions(id).filter(({ inherited }) => !inherited)
    const exits = processExits(actions, facts)
    for (const action of actions) {
      const own = facts.get(action.id) ?? []
      for (const write of actionWrites(action, own, owner.cwd)) {
        added(writes, write.path, write)
      }
      const activity = activityOf(action, own, owner.cwd, exits)
      if (activity !== null) {
        activities.push(activity)
      }
      const original = action.action_kind === 'file_write' ? originalOf(own) : undefined
      if (original !== undefined) {
        originals.set(action.id, original)
      }
    }
  }
  return { writes, activities, reads: storedReads(store, run), originals }
}

const baseOf = (history: History, write: PathWrite, path: string): Base | null => {
  const states: State[] = [
    ...(history.writes.get(path) ?? []).flatMap((other): State[] =>
      other.action.id !== write.action.id && other.ended < write.started
        ? [{ at: other.ended, since: other.started, action: other.action.id, base: { kind: 'write', write: other } }]
        : [],
    ),
    ...(history.reads.get(path) ?? []).flatMap(({ at, blob }): State[] =>
      at < write.started ? [{ at, since: at, action: null, base: { kind: 'read', blob } }] : [],
    ),
  ]
  const latest = states.reduce<State | null>((found, state) => (found === null || state.at > found.at ? state : found), null)
  if (latest === null || states.filter(({ at }) => at === latest.at).length > 1) {
    return null
  }
  const touched = history.activities.some(
    ({ action, started, ended, paths }) =>
      action !== write.action.id &&
      action !== latest.action &&
      (paths === null || paths.has(path)) &&
      (started === null || started <= write.ended) &&
      (ended === null || ended >= latest.since),
  )
  return touched ? null : latest.base
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const blobText = (store: Store, blob: ContentHash): string | null => {
  const bytes = store.artifacts.blob(blob)
  try {
    return bytes === null ? null : decoder.decode(bytes)
  } catch {
    return null
  }
}

const writeKey = ({ action, path }: PathWrite): string => `${action.id}\0${path}`

const contentOf = (retention: Retention, history: History, write: PathWrite): string | null => {
  const patched: { readonly write: PathWrite; readonly patch: FilePatch }[] = []
  let current = write
  let content: string | null
  for (;;) {
    const known = retention.contents.get(writeKey(current))
    if (known !== undefined || patched.some((step) => step.write === current)) {
      content = known ?? null
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
    const original = history.originals.get(current.action.id)
    const base = original === undefined ? baseOf(history, current, patch.base) : null
    if (base?.kind !== 'write') {
      content = original ?? (base === null ? null : blobText(retention.store, base.blob))
      break
    }
    current = base.write
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
  const write = history.writes.get(path)?.find((candidate) => candidate.action.id === action.id)
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
