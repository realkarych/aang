import type {
  Adapter,
  AdapterRegistry,
  ChangeSeq,
  CollectedGap,
  CollectedRecord,
  CollectorBatch,
  Fact,
  FileCursor,
  EpochNs as EpochNsType,
  RecordOwner,
  Runtime,
  ScopeDecision,
  SessionId,
  SessionKey,
  StreamKey,
} from '@aang/contract'
import { EpochNs } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { GapDraft, SessionScope, Store, Transaction } from '@aang/store'
import { refreshChecks } from '../checks/attention.js'
import { createContractCatalog } from '../checks/catalog.js'
import { projectSession } from '../observations/project.js'
import { lostSessions, type QuietWatch, quietWatchOf, settleQuiet, watchQuiet } from '../observations/freshness.js'
import { type SourceRecord, streamOwner } from '../observations/sources.js'
import { reparse, type ReparseResult } from '../reparse/reparse.js'
import { normalizeOtel } from './otel.js'
import { queueFacts } from './queue.js'
import { type Evidence, noEvidence, withOwner } from './evidence.js'
import {
  advanceFile,
  committedFile,
  type FileStep,
  type HeldFile,
  laggingFile,
  type TrackedFile,
  trackedFiles,
  trimmed,
} from './files.js'
import {
  type Adapters,
  draftOf,
  factsOf,
  type Owned,
  ownedRecord,
  type Parsed,
  parseRecord,
  sessionName,
} from './records.js'
import { createScopeJudge, type WatchedRoots } from './scope.js'

export interface HoldingLimits {
  readonly fileBytes: number
  readonly totalBytes: number
}

export interface EngineOptions {
  readonly store: Store
  readonly adapters: AdapterRegistry
  readonly watch: WatchedRoots
  readonly holding?: Partial<HoldingLimits>
  readonly now?: () => EpochNsType
  readonly quietAfterMs?: number
}

export interface IngestResult {
  readonly head: ChangeSeq
  readonly inserted: number
  readonly duplicates: number
  readonly discarded: number
  readonly waiting: number
  readonly deferred: number
  readonly settled: readonly CollectorBatch[]
  readonly rescan: readonly StreamKey[]
}

export interface Engine {
  readonly ingest: (batch: CollectorBatch) => Promise<IngestResult>
  readonly refreshFreshness: () => Promise<ChangeSeq>
  readonly reparse: () => Promise<ReparseResult>
}

interface HeldHook {
  readonly hook: Owned
  readonly owner: RecordOwner
  readonly batch: CollectorBatch
  readonly since: number
}

interface State {
  readonly files: ReadonlyMap<string, TrackedFile>
  readonly hooks: readonly HeldHook[]
  readonly evidence: ReadonlyMap<string, Evidence>
  readonly open: readonly CollectorBatch[]
}

type Item =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'hook'; readonly hook: Owned; readonly owner: RecordOwner; readonly since: number }
  | { readonly kind: 'otel'; readonly record: CollectedRecord }
  | { readonly kind: 'unowned'; readonly record: CollectedRecord }

interface SessionScopes {
  readonly get: (session: SessionKey) => ScopeDecision | null
  readonly set: (session: SessionKey, scope: ScopeDecision) => void
}

interface Tally {
  inserted: number
  duplicates: number
  discarded: number
  deferred: number
}

interface Committed {
  readonly tally: Tally
  readonly files: Map<string, TrackedFile>
  readonly hooks: readonly HeldHook[]
  readonly rescan: readonly StreamKey[]
  readonly quiet: QuietWatch
}

const mebibyte = 1024 ** 2

const defaultHolding: HoldingLimits = {
  fileBytes: 32 * mebibyte,
  totalBytes: 128 * mebibyte,
}

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

const unattributedGap = ({ record, key, result }: Parsed): GapDraft => ({
  key: { kind: 'gap', gap: 'unknown_records', subject: `record:${key}` },
  run: null,
  session: null,
  stream: null,
  details: `${record.runtime} ${record.channel} record (${result.parse_state}) discarded: it names no session`,
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

const heldLines = (files: ReadonlyMap<string, TrackedFile>): number =>
  [...files.values()].reduce((total, file) => total + (file.kind === 'held' ? file.lines.length : 0), 0)

export const createEngine = ({
  store, adapters: registry, watch, holding = {},
  now = () => EpochNs.parse(BigInt(Date.now()) * 1_000_000n), quietAfterMs = 300_000,
}: EngineOptions): Engine => {
  if (!Number.isSafeInteger(quietAfterMs) || quietAfterMs < 1) {
    throw new RangeError('quiet interval must be a positive safe integer in milliseconds')
  }
  const adapters = adaptersOf(registry)
  const contracts = createContractCatalog(watch)
  const limits: HoldingLimits = { ...defaultHolding, ...holding }
  let state: State = { files: trackedFiles(store.cursors.list()), hooks: [], evidence: new Map(), open: [] }
  let quiet = quietWatchOf(store.observations.sessions())
  let queue: Promise<unknown> = Promise.resolve()

  const sessionScopes = (): SessionScopes => {
    const known = new Map<string, ScopeDecision | null>()
    return {
      get: (session: SessionKey): ScopeDecision | null => {
        const name = sessionName(session)
        if (!known.has(name)) {
          known.set(name, store.scopes.ofSession(session)?.scope ?? null)
        }
        return known.get(name) ?? null
      },
      set: (session: SessionKey, scope: ScopeDecision): void => {
        known.set(sessionName(session), scope)
      },
    }
  }

  const itemsOf = (batch: CollectorBatch, now: number): Item[] => {
    const seen = new Set<string>()
    const items = batch.records.flatMap((record): Item[] => {
      if (record.position.kind === 'line') {
        const { path } = record.position
        if (seen.has(path)) {
          return []
        }
        seen.add(path)
        return [{ kind: 'file', path }]
      }
      if (record.channel === 'otel' && record.runtime === 'codex') { return [{ kind: 'otel', record }] }
      const hook = ownedRecord(adapters, record)
      return hook.owner === null
        ? [{ kind: 'unowned', record }]
        : [{ kind: 'hook', hook, owner: hook.owner, since: now }]
    })
    const cursorsOnly = batch.cursors
      .filter(({ path }) => !seen.has(path))
      .map(({ path }): Item => ({ kind: 'file', path }))
    return [...items, ...cursorsOnly]
  }

  const fileSteps = (batch: CollectorBatch, now: number): Map<string, FileStep> => {
    const lines = linesByPath(batch.records)
    const cursors = new Map(batch.cursors.map((cursor) => [cursor.path, cursor]))
    for (const path of lines.keys()) {
      if (!cursors.has(path)) {
        throw new Error(`the batch has lines of ${path} without the cursor of the file`)
      }
    }
    return new Map(
      [...cursors.values()].map((cursor: FileCursor) => [
        cursor.path,
        advanceFile(adapters, state.files.get(cursor.path), cursor, lines.get(cursor.path) ?? [], now),
      ]),
    )
  }

  const gatherEvidence = (
    steps: ReadonlyMap<string, FileStep>,
    items: readonly Item[],
    scopes: SessionScopes,
  ): Map<string, Evidence> => {
    const evidence = new Map(state.evidence)
    const note = (owner: RecordOwner, readFromStart: boolean): void => {
      if (scopes.get(owner.session) !== null) {
        return
      }
      const name = sessionName(owner.session)
      evidence.set(name, withOwner(evidence.get(name) ?? noEvidence(owner.session), owner, readFromStart))
    }
    for (const step of steps.values()) {
      if (step.kind === 'held') {
        for (const owner of step.sightings) {
          note(owner, true)
        }
      }
    }
    for (const item of items) {
      if (item.kind === 'hook') {
        note(item.owner, false)
      }
    }
    return evidence
  }

  const decideSessions = async (
    evidence: Map<string, Evidence>,
    scopes: SessionScopes,
  ): Promise<SessionScope[]> => {
    const judge = createScopeJudge(watch)
    const decided: SessionScope[] = []
    for (const [name, gathered] of [...evidence]) {
      const cwd = gathered.start
      const stored = scopes.get(gathered.session)
      const scope = stored ?? (gathered.observer ? 'observer' : cwd === null ? null : await judge(cwd))
      if (scope !== null) {
        evidence.delete(name)
        if (stored === null) {
          scopes.set(gathered.session, scope)
          decided.push({ session: gathered.session, scope })
        }
      }
    }
    return decided
  }

  const commit = (
    batch: CollectorBatch,
    items: readonly Item[],
    steps: ReadonlyMap<string, FileStep>,
    decided: readonly SessionScope[],
    scopes: SessionScopes,
  ): Committed =>
    store.transaction((transaction: Transaction) => {
      const changedSessions = new Map<string, SessionKey>()
      const sourceRecords = new Map<string, SourceRecord[]>()
      const tally: Tally = { inserted: 0, duplicates: 0, discarded: 0, deferred: 0 }
      const files = new Map(state.files)
      const hooks: HeldHook[] = []
      const rescan = new Set<StreamKey>()
      const streamScopes = new Map<StreamKey, ScopeDecision>()
      const inserted: Fact[] = []

      const changed = (facts: readonly Fact[]): void => {
        for (const { entity_key } of facts) {
          const key: SessionKey = { kind: 'session', runtime: entity_key.runtime, session: entity_key.session }
          changedSessions.set(sessionName(key), key)
        }
      }

      const insert = (parsed: Parsed, fallback: RecordOwner | null = null): void => {
        const { status, seq } = transaction.rawRecords.insert(draftOf(parsed))
        if (status === 'duplicate') {
          tally.duplicates += 1
          return
        }
        const facts = transaction.facts.insert(seq, parsed.normalizerVersion, factsOf(parsed))
        inserted.push(...facts)
        const owner = adapters[parsed.record.runtime].owner(parsed.record) ?? fallback
        if (owner !== null && parsed.record.channel !== 'otel') {
          const name = sessionName(owner.session)
          changedSessions.set(name, owner.session)
          const records = sourceRecords.get(name) ?? []
          records.push({ raw: { ...draftOf(parsed), seq }, owner })
          sourceRecords.set(name, records)
        }
        changed(facts)
        tally.inserted += 1
      }

      const keep = (records: readonly CollectedRecord[], scope: ScopeDecision): void => {
        if (scope === 'watched') {
          const first = records[0]
          let fallback = records.map((record) => adapters[record.runtime].owner(record)).find((owner) => owner !== null) ?? null
          if (fallback === null && first?.stream !== null && first?.stream !== undefined) {
            fallback = streamOwner(transaction, adapters, first.stream)
          }
          for (const record of records) {
            insert(parseRecord(adapters, record), fallback)
          }
        } else {
          tally.discarded += records.length
        }
      }

      const streamScope = (stream: StreamKey): ScopeDecision | null =>
        streamScopes.get(stream) ?? transaction.scopes.get(stream)?.scope ?? null

      const settleStream = (stream: StreamKey, session: SessionKey | null): ScopeDecision | null => {
        const known = streamScope(stream)
        if (known !== null || session === null) {
          return known
        }
        const scope = scopes.get(session)
        if (scope !== null) {
          transaction.scopes.decide({ stream, runtime: session.runtime, scope })
          streamScopes.set(stream, scope)
        }
        return scope
      }

      const saveCursor = (cursor: FileCursor, stream: StreamKey | null): void => {
        transaction.cursors.save({ ...cursor, stream })
        files.set(cursor.path, committedFile(cursor, stream))
      }

      const saveGap = (gap: CollectedGap, stream: StreamKey | null): void => {
        const owner = stream === null ? null : streamOwner(transaction, adapters, stream)
        const session = owner === null ? null : objectId(owner.session)
        const run = session === null ? null : transaction.observations.getSession(session)?.run ?? null
        transaction.gaps.save({ ...gap, stream, run, session })
        if (owner !== null) { changedSessions.set(sessionName(owner.session), owner.session) }
      }

      const commitHeld = (file: HeldFile): void => {
        const { stream } = file
        const scope = stream === null ? null : settleStream(stream, file.session)
        if (stream === null || scope === null) {
          files.set(file.path, file)
          return
        }
        keep(
          file.lines.map(({ record }) => record),
          scope,
        )
        if (scope === 'watched') {
          for (const gap of file.gaps) {
            saveGap(gap, stream)
          }
        }
        if (file.full && scope === 'watched') {
          files.set(file.path, laggingFile(file.cursor, stream))
          rescan.add(stream)
          return
        }
        saveCursor(file.cursor, stream)
      }

      const commitStep = (step: FileStep): void => {
        switch (step.kind) {
          case 'append': {
            const scope = streamScope(step.stream)
            if (scope === null) {
              throw new Error(`the stream ${step.stream} of ${step.file.path} has no scope decision`)
            }
            keep(step.lines, scope)
            saveCursor(step.cursor, step.stream)
            return
          }
          case 'nameless':
            tally.discarded += step.lines.length
            if (step.first !== null) {
              transaction.gaps.save(namelessGap(step.path, step.first))
            }
            for (const gap of step.gaps) {
              saveGap(gap, null)
            }
            saveCursor(step.cursor, null)
            return
          case 'lagging':
            tally.deferred += step.skipped
            return
          case 'held':
            tally.deferred += step.skipped
            commitHeld(step.file)
        }
      }

      const commitHook = (held: HeldHook): void => {
        const scope = scopes.get(held.owner.session)
        if (scope === null) {
          hooks.push(held)
        } else {
          const record = held.hook.record
          const stream = adapters[record.runtime].streamKey([record.payload])
          if (stream !== null) {
            transaction.scopes.decide({ stream, runtime: record.runtime, scope })
          }
          keep([record], scope)
        }
      }

      const resolveGap = (gap: CollectedGap): void => {
        const file = gap.stream === null ? files.get(gap.key.subject) : undefined
        if (file?.kind === 'held') {
          files.set(file.path, { ...file, gaps: [...file.gaps, gap] })
          return
        }
        const stream = gap.stream ?? file?.stream ?? null
        const scope = stream === null ? null : streamScope(stream)
        if (scope === null || scope === 'watched') {
          saveGap(gap, stream)
        }
      }

      for (const { session, scope } of decided) {
        transaction.scopes.decideSession({ session, scope })
      }
      state.hooks.forEach(commitHook)
      for (const file of state.files.values()) {
        if (file.kind === 'held' && !steps.has(file.path)) {
          commitHeld(file)
        }
      }
      for (const item of items) {
        switch (item.kind) {
          case 'file': {
            const step = steps.get(item.path)
            if (step !== undefined) {
              commitStep(step)
            }
            break
          }
          case 'hook':
            commitHook({ hook: item.hook, owner: item.owner, batch, since: item.since })
            break
          case 'otel': {
            const parsed = parseRecord(adapters, { ...item.record, stream: null })
            insert({ ...parsed, record: item.record, key: adapters[item.record.runtime].rawKey(item.record) })
            break
          }
          case 'unowned':
            tally.discarded += 1
            transaction.gaps.save(unattributedGap(parseRecord(adapters, item.record)))
        }
      }
      batch.gaps.forEach(resolveGap)
      const otelFacts = normalizeOtel(transaction, adapters)
      inserted.push(...otelFacts)
      changed(otelFacts)
      const instant = now()
      const watch = new Map(quiet)
      const lost = changedSessions.size === 0 ? new Set<SessionId>() : lostSessions(transaction)
      for (const key of changedSessions.values()) {
        const projection = projectSession(transaction, key, sourceRecords.get(sessionName(key)) ?? [], lost, instant, quietAfterMs)
        if (projection !== null) { watchQuiet(watch, projection.session) }
      }
      queueFacts(transaction, inserted)
      refreshChecks(transaction, changedSessions.values(), contracts)
      settleQuiet(transaction, watch, instant, quietAfterMs)
      return { tally, files, hooks, rescan: [...rescan], quiet: watch }
    })

  const withinLimits = (committed: Committed) => {
    const files = new Map(committed.files)
    const hooks: HeldHook[] = []
    const abandoned = new Set<CollectorBatch>()
    const retained = new Set<CollectorBatch>()
    let deferred = 0
    let budget = limits.totalBytes
    const sources = [
      ...[...files.values()].flatMap((file) => (file.kind === 'held' ? [{ since: file.since, file }] : [])),
      ...committed.hooks.map((hook) => ({ since: hook.since, hook })),
    ].sort((left, right) => left.since - right.since)
    for (const source of sources) {
      if ('file' in source) {
        const { file, dropped } = trimmed(source.file, Math.min(limits.fileBytes, budget))
        files.set(file.path, file)
        budget -= file.bytes
        deferred += dropped
      } else {
        const { batch } = source.hook
        if (!retained.has(batch) && !abandoned.has(batch)) {
          const bytes = batch.records.reduce((total, record) => total + Buffer.byteLength(record.payload), 0)
          if (bytes <= budget) {
            budget -= bytes
            retained.add(batch)
          } else {
            abandoned.add(batch)
          }
        }
        if (retained.has(batch)) {
          hooks.push(source.hook)
        } else {
          deferred += 1
        }
      }
    }
    return { files, hooks, abandoned, deferred }
  }

  const ingestBatch = async (batch: CollectorBatch): Promise<IngestResult> => {
    const now = Date.now()
    const steps = fileSteps(batch, now)
    const items = itemsOf(batch, now)
    const scopes = sessionScopes()
    const evidence = gatherEvidence(steps, items, scopes)
    const decided = await decideSessions(evidence, scopes)
    const committed = commit(batch, items, steps, decided, scopes)
    quiet = committed.quiet
    const kept = withinLimits(committed)
    const holdingBatches = new Set(kept.hooks.map((hook) => hook.batch))
    const candidates = [...state.open, batch]
    state = {
      files: kept.files,
      hooks: kept.hooks,
      evidence,
      open: candidates.filter((open) => holdingBatches.has(open) && !kept.abandoned.has(open)),
    }
    return {
      head: store.changes.head(),
      ...committed.tally,
      deferred: committed.tally.deferred + kept.deferred,
      waiting: heldLines(kept.files) + kept.hooks.length,
      settled: candidates.filter((open) => !holdingBatches.has(open) && !kept.abandoned.has(open)),
      rescan: committed.rescan,
    }
  }

  const enqueue = <T>(work: () => T | Promise<T>): Promise<T> => {
    const result = queue.then(work)
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    refreshFreshness: () =>
      enqueue(() => {
        const watch = new Map(quiet)
        store.transaction((transaction) => { settleQuiet(transaction, watch, now(), quietAfterMs) })
        quiet = watch
        return store.changes.head()
      }),
    ingest: (batch) => enqueue(() => ingestBatch(batch)),
    reparse: () =>
      enqueue(() => {
        const watch = new Map(quiet)
        const result = reparse(store, adapters, contracts, watch, now(), quietAfterMs)
        quiet = watch
        return result
      }),
  }
}
