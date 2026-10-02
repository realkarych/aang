import type {
  Adapter,
  AdapterRegistry,
  ChangeSeq,
  CollectedGap,
  CollectedRecord,
  CollectorBatch,
  FileCursor,
  Runtime,
  ScopeDecision,
  SessionKey,
  StreamKey,
} from '@aang/contract'
import type { GapDraft, Store, Transaction } from '@aang/store'
import { type FileState, type FileWork, fileWork, type KnownFile, knownFiles, type WaitingFile } from './files.js'
import {
  type Adapters,
  draftOf,
  type Evidence,
  factsOf,
  firstSession,
  type Parsed,
  parseRecord,
  sessionName,
  sessionOf,
  withFact,
} from './parse.js'
import { createScopeJudge, type WatchedRoots } from './scope.js'

export interface EngineOptions {
  readonly store: Store
  readonly adapters: AdapterRegistry
  readonly watch: WatchedRoots
}

export interface IngestResult {
  readonly head: ChangeSeq
  readonly inserted: number
  readonly duplicates: number
  readonly discarded: number
  readonly waiting: number
}

export interface Engine {
  readonly ingest: (batch: CollectorBatch) => Promise<IngestResult>
}

interface FileItem {
  readonly kind: 'file'
  readonly work: FileWork
  readonly parsed: readonly Parsed[]
}

interface RecordItem {
  readonly kind: 'record'
  readonly parsed: Parsed
}

type Item = FileItem | RecordItem

interface SessionDecision {
  readonly session: SessionKey
  readonly scope: ScopeDecision
}

interface Decisions {
  readonly streams: ReadonlyMap<StreamKey, ScopeDecision>
  readonly sessions: ReadonlyMap<string, ScopeDecision>
  readonly decided: readonly SessionDecision[]
}

interface Candidate {
  readonly session: SessionKey
  evidence: Evidence
}

interface Tally {
  inserted: number
  duplicates: number
  discarded: number
}

const noEvidence: Evidence = { observer: false, cwd: null }

const requireAdapter = (registry: AdapterRegistry, runtime: Runtime): Adapter => {
  const adapter = registry.get(runtime)
  if (adapter?.runtime !== runtime) {
    throw new Error(`the adapter registry has no ${runtime} adapter`)
  }
  return adapter
}

const adaptersOf = (registry: AdapterRegistry): Adapters => ({
  claude: requireAdapter(registry, 'claude'),
  codex: requireAdapter(registry, 'codex'),
})

const linesByPath = (records: readonly CollectedRecord[]): Map<string, CollectedRecord[]> => {
  const lines = new Map<string, CollectedRecord[]>()
  for (const record of records) {
    if (record.position.kind === 'line') {
      const { path } = record.position
      const list = lines.get(path)
      if (list === undefined) {
        lines.set(path, [record])
      } else {
        list.push(record)
      }
    }
  }
  return lines
}

const itemsOf = (adapters: Adapters, state: FileState, batch: CollectorBatch): Item[] => {
  const lines = linesByPath(batch.records)
  const cursors = new Map(batch.cursors.map((cursor) => [cursor.path, cursor]))
  const seen = new Set<string>()
  const fileItem = (cursor: FileCursor): FileItem => {
    seen.add(cursor.path)
    const work = fileWork(adapters, state, cursor, lines.get(cursor.path) ?? [])
    const { naming } = work
    return {
      kind: 'file',
      work,
      parsed:
        naming.kind === 'named'
          ? work.records.map((record) => parseRecord(adapters, { ...record, stream: naming.stream }))
          : [],
    }
  }
  const items = batch.records.flatMap((record): Item[] => {
    if (record.position.kind !== 'line') {
      return [{ kind: 'record', parsed: parseRecord(adapters, record) }]
    }
    const { path } = record.position
    if (seen.has(path)) {
      return []
    }
    const cursor = cursors.get(path)
    if (cursor === undefined) {
      throw new Error(`the batch has lines of ${path} without the cursor of the file`)
    }
    return [fileItem(cursor)]
  })
  const unread = new Map<string, FileCursor>()
  for (const cursor of [...batch.cursors, ...[...state.waiting.values()].map((file) => file.cursor)]) {
    if (!seen.has(cursor.path) && !unread.has(cursor.path)) {
      unread.set(cursor.path, cursor)
    }
  }
  return [...items, ...[...unread.values()].map(fileItem)]
}

const namedStream = (item: Item): StreamKey | null =>
  item.kind === 'file' && item.work.naming.kind === 'named' ? item.work.naming.stream : null

const parsedOf = (item: Item): readonly Parsed[] => (item.kind === 'file' ? item.parsed : [item.parsed])

const unattributedGap = ({ record, key, result }: Parsed, reason: string): GapDraft => ({
  key: { kind: 'gap', gap: 'unknown_records', subject: `record:${key}` },
  run: null,
  session: null,
  stream: null,
  details: `${record.runtime} ${record.channel} record (${result.parse_state}) discarded: ${reason}`,
  detected_at: record.observed_at,
  closed_at: null,
})

const namelessGap = (path: string, first: CollectedRecord): GapDraft => ({
  key: { kind: 'gap', gap: 'unknown_stream_layout', subject: path },
  run: null,
  session: null,
  stream: null,
  details: `the ${first.runtime} adapter names no stream from the first lines of ${path}`,
  detected_at: first.observed_at,
  closed_at: null,
})

export const createEngine = ({ store, adapters: registry, watch }: EngineOptions): Engine => {
  const adapters = adaptersOf(registry)
  const known = knownFiles(store.cursors.list())
  let waiting: ReadonlyMap<string, WaitingFile> = new Map()
  let queue: Promise<unknown> = Promise.resolve()

  const storedStreamScope = (stream: StreamKey): ScopeDecision | null => store.scopes.get(stream)?.scope ?? null

  const decide = async (items: readonly Item[]): Promise<Decisions> => {
    const streams = new Map<StreamKey, ScopeDecision>()
    for (const stream of items.flatMap((item) => namedStream(item) ?? [])) {
      const stored = storedStreamScope(stream)
      if (stored !== null) {
        streams.set(stream, stored)
      }
    }
    const subjects = items.flatMap((item): SessionKey[] => {
      const stream = namedStream(item)
      const undecided = item.kind === 'record' || (stream !== null && !streams.has(stream))
      const session = undecided ? firstSession(parsedOf(item)) : null
      return session === null ? [] : [session]
    })
    const sessions = new Map<string, ScopeDecision>()
    const candidates = new Map<string, Candidate>()
    for (const session of subjects) {
      const name = sessionName(session)
      if (!sessions.has(name) && !candidates.has(name)) {
        const stored = store.scopes.ofSession(session)
        if (stored === null) {
          candidates.set(name, { session, evidence: noEvidence })
        } else {
          sessions.set(name, stored.scope)
        }
      }
    }
    for (const fact of items.flatMap(parsedOf).flatMap(factsOf)) {
      const candidate = candidates.get(sessionName(sessionOf(fact)))
      if (candidate !== undefined) {
        candidate.evidence = withFact(candidate.evidence, fact)
      }
    }
    const judge = createScopeJudge(watch)
    const decided: SessionDecision[] = []
    for (const { session, evidence } of candidates.values()) {
      const scope = await judge(evidence)
      if (scope !== null) {
        sessions.set(sessionName(session), scope)
        decided.push({ session, scope })
      }
    }
    return { streams, sessions, decided }
  }

  const commit = (items: readonly Item[], decisions: Decisions, gaps: readonly CollectedGap[]) =>
    store.transaction((transaction: Transaction) => {
      const tally: Tally = { inserted: 0, duplicates: 0, discarded: 0 }
      const saved = new Map<string, KnownFile>()
      const stillWaiting = new Map<string, WaitingFile>()
      const streams = new Map(decisions.streams)

      const insert = (parsed: Parsed): void => {
        const { status, seq } = transaction.rawRecords.insert(draftOf(parsed))
        if (status === 'duplicate') {
          tally.duplicates += 1
          return
        }
        transaction.facts.insert(seq, parsed.normalizerVersion, factsOf(parsed))
        tally.inserted += 1
      }

      const keep = (parsed: readonly Parsed[], scope: ScopeDecision): void => {
        if (scope === 'watched') {
          parsed.forEach(insert)
        } else {
          tally.discarded += parsed.length
        }
      }

      const sessionScope = (session: SessionKey | null): ScopeDecision | null =>
        session === null ? null : (decisions.sessions.get(sessionName(session)) ?? null)

      const decideStream = (stream: StreamKey, session: SessionKey | null): ScopeDecision | null => {
        const scope = sessionScope(session)
        if (session !== null && scope !== null) {
          transaction.scopes.decide({ stream, runtime: session.runtime, scope })
          streams.set(stream, scope)
        }
        return scope
      }

      const saveCursor = (cursor: FileCursor, stream: StreamKey | null): void => {
        transaction.cursors.save({ ...cursor, stream })
        saved.set(cursor.path, { dev: cursor.dev, ino: cursor.ino, stream })
      }

      const commitFile = ({ work, parsed }: FileItem): void => {
        const { path, cursor, records, naming } = work
        switch (naming.kind) {
          case 'nameless':
            tally.discarded += records.length
            if (naming.first !== null) {
              transaction.gaps.save(namelessGap(path, naming.first))
            }
            saveCursor(cursor, null)
            return
          case 'unnamed':
            stillWaiting.set(path, { cursor, stream: null, records })
            return
          case 'named': {
            const scope = streams.get(naming.stream) ?? decideStream(naming.stream, firstSession(parsed))
            if (scope === null) {
              stillWaiting.set(path, { cursor, stream: naming.stream, records })
              return
            }
            keep(parsed, scope)
            saveCursor(cursor, naming.stream)
          }
        }
      }

      const commitRecord = (parsed: Parsed): void => {
        const session = firstSession([parsed])
        const scope = sessionScope(session)
        if (scope === null) {
          tally.discarded += 1
          const reason = session === null ? 'it names no session' : 'its session has no scope decision'
          transaction.gaps.save(unattributedGap(parsed, reason))
          return
        }
        keep([parsed], scope)
      }

      for (const { session, scope } of decisions.decided) {
        transaction.scopes.decideSession({ session, scope })
      }
      for (const item of items) {
        if (item.kind === 'file') {
          commitFile(item)
        } else {
          commitRecord(item.parsed)
        }
      }
      for (const gap of gaps) {
        const scope = gap.stream === null ? null : (streams.get(gap.stream) ?? storedStreamScope(gap.stream))
        if (scope === null || scope === 'watched') {
          transaction.gaps.save({ ...gap, run: null, session: null })
        }
      }
      return { tally, saved, waiting: stillWaiting }
    })

  const ingestBatch = async (batch: CollectorBatch): Promise<IngestResult> => {
    const items = itemsOf(adapters, { known, waiting }, batch)
    const decisions = await decide(items)
    const committed = commit(items, decisions, batch.gaps)
    for (const [path, file] of committed.saved) {
      known.set(path, file)
    }
    waiting = committed.waiting
    const held = [...waiting.values()].reduce((total, file) => total + file.records.length, 0)
    return { head: store.changes.head(), ...committed.tally, waiting: held }
  }

  return {
    ingest: (batch) => {
      const result = queue.then(() => ingestBatch(batch))
      queue = result.catch(() => undefined)
      return result
    },
  }
}
