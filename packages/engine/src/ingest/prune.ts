import type {
  ContentHash,
  EpochNs,
  PruneBoundary,
  PruneRequest,
  RawSeq,
  RunId,
  SessionKey,
  StreamKey,
} from '@aang/contract'
import { contentHash, runId } from '@aang/contract/ids'
import type { PruneTarget, Store } from '@aang/store'
import { compareText } from '../observations/evidence.js'
import { collectedOf, streamOwner } from '../observations/sources.js'
import { type Adapters, sessionName } from './records.js'

export type PrefixHash = (path: string, offset: number) => Promise<ContentHash | null>

export interface PruneOutcome {
  readonly runs: readonly RunId[]
  readonly boundaries: readonly PruneBoundary[]
}

interface StreamOwner {
  readonly stream: StreamKey
  readonly session: SessionKey
}

const pageSize = 256

const emptyPrefix = contentHash('')

export const prunedSession = ({ runtime, session }: PruneBoundary): SessionKey => ({ kind: 'session', runtime, session })

export const pruneRuns = (store: Store, request: PruneRequest): RunId[] => {
  const latest = new Map<RunId, EpochNs>()
  for (const { run, last_event_at: at } of store.observations.sessions()) {
    const known = run === null ? undefined : latest.get(run)
    if (run !== null && (known === undefined || at > known)) {
      latest.set(run, at)
    }
  }
  if (request.scope === 'run') {
    const known =
      latest.has(request.run) ||
      store.model.entity(request.run, { kind: 'run', id: request.run }) !== null ||
      store.pruned.list().some((boundary) => runId(prunedSession(boundary)) === request.run)
    return known ? [request.run] : []
  }
  return [...latest].flatMap(([run, at]) => (at < request.before ? [run] : [])).sort(compareText)
}

const hooksOf = (store: Store, adapters: Adapters, sessions: ReadonlySet<string>): RawSeq[] => {
  const owned: RawSeq[] = []
  let after: RawSeq | null = null
  for (let page = store.rawRecords.hooksWithoutFacts(after, pageSize); page.length > 0; page = store.rawRecords.hooksWithoutFacts(after, pageSize)) {
    for (const raw of page) {
      after = raw.seq
      const record = collectedOf(raw)
      const owner = record === null ? null : adapters[record.runtime].owner(record)
      if (owner !== null && sessions.has(sessionName(owner.session))) {
        owned.push(raw.seq)
      }
    }
  }
  return owned
}

const sessionsOf = (store: Store, runs: readonly RunId[]): Map<string, SessionKey> => {
  const targets = new Set<string>(runs)
  const sessions = new Map<string, SessionKey>()
  for (const { run, key } of store.observations.sessions()) {
    if (run !== null && targets.has(run)) {
      sessions.set(sessionName(key), key)
    }
  }
  for (const boundary of store.pruned.list()) {
    const session = prunedSession(boundary)
    if (targets.has(runId(session))) {
      sessions.set(sessionName(session), session)
    }
  }
  return sessions
}

export const pruneTarget = (store: Store, adapters: Adapters, runs: readonly RunId[]): PruneTarget & { readonly owners: readonly StreamOwner[] } => {
  const sessions = sessionsOf(store, runs)
  const owners = new Map<StreamKey, StreamOwner>()
  for (const { stream } of store.scopes.list()) {
    const owner = streamOwner(store, adapters, stream)
    if (owner !== null && sessions.has(sessionName(owner.session))) {
      owners.set(stream, { stream, session: owner.session })
    }
  }
  for (const session of sessions.values()) {
    for (const { stream } of store.pruned.ofSession(session)) {
      owners.set(stream, { stream, session })
    }
  }
  return {
    runs,
    sessions: [...sessions.values()],
    streams: [...owners.keys()],
    records: hooksOf(store, adapters, new Set(sessions.keys())),
    owners: [...owners.values()],
  }
}

export const pruneBoundaries = async (
  store: Store,
  owners: readonly StreamOwner[],
  prefixHash: PrefixHash,
  at: EpochNs,
): Promise<PruneBoundary[]> => {
  const cursors = store.cursors.list()
  const changed = new Set(store.gaps.open('stream_changed_after_prune').map(({ stream }) => stream))
  const boundaries: PruneBoundary[] = []
  for (const { stream, session } of owners) {
    const files = cursors.filter((cursor) => cursor.stream === stream)
    if (session.runtime === 'codex') {
      const ordinals = files.flatMap(({ last_ordinal: ordinal }) => (ordinal === null ? [] : [ordinal]))
      boundaries.push({
        runtime: 'codex',
        stream,
        session: session.session,
        last_ordinal: Math.max(0, ...ordinals),
        pruned_at: at,
      })
      continue
    }
    const furthest = changed.has(stream)
      ? null
      : files.reduce<(typeof files)[number] | null>(
          (best, cursor) => (best === null || cursor.offset > best.offset ? cursor : best),
          null,
        )
    boundaries.push({
      runtime: 'claude',
      stream,
      session: session.session,
      offset: furthest?.offset ?? 0,
      prefix_hash: furthest === null ? emptyPrefix : ((await prefixHash(furthest.path, furthest.offset)) ?? emptyPrefix),
      pruned_at: at,
    })
  }
  return boundaries
}
