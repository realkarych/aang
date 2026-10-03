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
import { contentHash } from '@aang/contract/ids'
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

export const pruneRuns = (store: Store, request: PruneRequest): RunId[] => {
  const latest = new Map<RunId, EpochNs>()
  for (const { run, last_event_at: at } of store.observations.sessions()) {
    const known = run === null ? undefined : latest.get(run)
    if (run !== null && (known === undefined || at > known)) {
      latest.set(run, at)
    }
  }
  if (request.scope === 'run') {
    return latest.has(request.run) || store.model.entity(request.run, { kind: 'run', id: request.run }) !== null
      ? [request.run]
      : []
  }
  return [...latest].flatMap(([run, at]) => (at < request.before ? [run] : [])).sort(compareText)
}

const hookStream = (store: Store, adapters: Adapters, session: SessionKey): StreamKey | null => {
  for (const fact of store.facts.ofSession(session)) {
    const raw = store.rawRecords.get(fact.seq)
    const record = raw?.channel === 'hook' ? collectedOf(raw) : null
    const stream = record === null ? null : adapters[record.runtime].streamKey([record.payload])
    if (stream !== null) {
      return stream
    }
  }
  return null
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

export const pruneTarget = (store: Store, adapters: Adapters, runs: readonly RunId[]): PruneTarget & { readonly owners: readonly StreamOwner[] } => {
  const targets = new Set<string>(runs)
  const sessions = store.observations
    .sessions()
    .flatMap(({ run, key }) => (run !== null && targets.has(run) ? [key] : []))
  const names = new Set(sessions.map(sessionName))
  const owners = new Map<StreamKey, StreamOwner>()
  for (const { stream, scope } of store.scopes.list()) {
    const owner = scope === 'watched' ? streamOwner(store, adapters, stream) : null
    if (owner !== null && names.has(sessionName(owner.session))) {
      owners.set(stream, { stream, session: owner.session })
    }
  }
  for (const session of sessions) {
    for (const { stream } of store.pruned.ofSession(session)) {
      owners.set(stream, { stream, session })
    }
    const bounded = [...owners.values()].some((owner) => sessionName(owner.session) === sessionName(session))
    const stream = bounded ? null : hookStream(store, adapters, session)
    if (stream !== null) {
      owners.set(stream, { stream, session })
    }
  }
  return {
    runs,
    sessions,
    streams: [...owners.keys()],
    records: hooksOf(store, adapters, names),
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
    const furthest = files.reduce<(typeof files)[number] | null>(
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
