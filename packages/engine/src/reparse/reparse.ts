import {
  type AgentKey,
  type ChangeSeq,
  CollectedRecord,
  type EpochNs,
  type Fact,
  type RawSeq,
  type RecordOwner,
  type ReparseResponse,
  type SessionKey,
  type StreamKey,
} from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import type { Observation, Store, Transaction } from '@aang/store'
import { refreshChecks } from '../checks/attention.js'
import type { ContractCatalog } from '../checks/catalog.js'
import { normalizeOtel } from '../ingest/otel.js'
import { queueFacts } from '../ingest/queue.js'
import { type Adapters, collectedFields, sessionName } from '../ingest/records.js'
import type { AgentMove } from '../observations/agents.js'
import { agentKey } from '../observations/evidence.js'
import { lostSessions, type QuietWatch, settleQuiet, watchQuiet } from '../observations/freshness.js'
import { projectSession } from '../observations/project.js'
import { streamOwner } from '../observations/sources.js'

export interface ReparseResult extends ReparseResponse {
  readonly head: ChangeSeq
}

interface Reparsed {
  readonly keys: Map<string, SessionKey>
  readonly unknown: Map<string, number>
  readonly moves: Map<string, AgentMove[]>
  readonly added: Fact[]
}

const pageSize = 256

const agentsOf = (facts: readonly Fact[]): Map<string, AgentKey> =>
  new Map(facts.map((fact) => [canonicalJson(agentKey(fact)), agentKey(fact)]))

const recordMoves = (moves: Map<string, AgentMove[]>, previous: readonly Fact[], current: readonly Fact[]): void => {
  const before = agentsOf(previous)
  const after = agentsOf(current)
  for (const from of before.keys()) {
    if (after.has(from)) {
      continue
    }
    for (const [name, to] of after) {
      if (!before.has(name)) {
        const evidence = current.filter((fact) => canonicalJson(agentKey(fact)) === name).map(({ id }) => id)
        moves.set(from, [...(moves.get(from) ?? []), { to, evidence }])
      }
    }
  }
}

const reparseRecords = (transaction: Transaction, adapters: Adapters, reparsed: Reparsed): ReparseResponse => {
  const tally = { records: 0, facts_added: 0, facts_kept: 0, facts_missing: 0 }
  const streamOwners = new Map<StreamKey, RecordOwner | null>()
  const ownerOf = (record: CollectedRecord): RecordOwner | null => {
    const owner = adapters[record.runtime].owner(record)
    if (owner !== null || record.stream === null) {
      return owner
    }
    const known = streamOwners.get(record.stream)
    if (known !== undefined) {
      return known
    }
    const found = streamOwner(transaction, adapters, record.stream)
    streamOwners.set(record.stream, found)
    return found
  }
  for (const adapter of Object.values(adapters)) {
    let after: RawSeq | null = null
    for (;;) {
      const page = transaction.rawRecords.outdated(adapter.runtime, adapter.normalizerVersion, after, pageSize)
      if (page.length === 0) {
        break
      }
      for (const raw of page) {
        after = raw.seq
        const record = CollectedRecord.parse(collectedFields(raw))
        const result = adapter.parse(record)
        const sourceTs = result.parse_state === 'invalid' ? null : result.source_ts
        const previous = transaction.facts.ofRecord(raw.seq)
        const revision = transaction.facts.replace(
          raw.seq,
          adapter.normalizerVersion,
          result.parse_state === 'parsed' ? result.facts : [],
        )
        recordMoves(reparsed.moves, previous, [...revision.kept, ...revision.added])
        reparsed.added.push(...revision.added)
        if (
          result.parse_state !== raw.parse_state ||
          sourceTs !== raw.source_ts ||
          revision.added.length > 0 ||
          revision.removed.length > 0
        ) {
          transaction.rawRecords.setParse(raw.seq, result.parse_state, sourceTs)
        }
        const owner = record.channel === 'otel' ? null : ownerOf(record)
        if (owner !== null) {
          const name = sessionName(owner.session)
          reparsed.keys.set(name, owner.session)
          if (result.parse_state !== 'parsed') {
            reparsed.unknown.set(name, (reparsed.unknown.get(name) ?? 0) + 1)
          }
        }
        tally.records += 1
        tally.facts_added += revision.added.length
        tally.facts_kept += revision.kept.length
        tally.facts_missing += revision.removed.length
      }
    }
  }
  const otel = normalizeOtel(transaction, adapters)
  reparsed.added.push(...otel)
  tally.facts_added += otel.length
  return tally
}

const storedObservations = (transaction: Transaction, key: SessionKey): Observation[] => {
  const session = objectId(key)
  return [
    ...[transaction.observations.getSession(session)].filter((observation) => observation !== null),
    ...transaction.observations.agents(session),
    ...transaction.observations.actions(session),
    ...transaction.observations.questions(session),
  ]
}

const rebuildProjections = (
  transaction: Transaction,
  reparsed: Reparsed,
  quiet: QuietWatch,
  now: EpochNs,
  quietAfterMs: number,
): SessionKey[] => {
  const supported = new Map(reparsed.keys)
  for (const key of transaction.facts.sessions()) {
    supported.set(sessionName(key), key)
  }
  const sessions = new Map(supported)
  for (const { key } of transaction.observations.sessions()) {
    sessions.set(sessionName(key), key)
  }
  const lost = lostSessions(transaction)
  const rebuilt: SessionKey[] = []
  for (const [name, key] of sessions) {
    const rebuild = { unknownRecords: reparsed.unknown.get(name) ?? 0, moves: reparsed.moves }
    const projection = supported.has(name)
      ? projectSession(transaction, key, [], lost, now, quietAfterMs, rebuild)
      : null
    if (projection === null) {
      quiet.delete(objectId(key))
    } else {
      watchQuiet(quiet, projection.session)
      rebuilt.push(key)
    }
    const projected = new Set(projection?.objects)
    for (const observation of storedObservations(transaction, key)) {
      if (!projected.has(observation.id)) {
        transaction.observations.delete(observation)
      }
    }
  }
  return rebuilt
}

export const reparse = (
  store: Store,
  adapters: Adapters,
  contracts: ContractCatalog,
  quiet: QuietWatch,
  now: EpochNs,
  quietAfterMs: number,
): ReparseResult => {
  const tally = store.transaction((transaction) => {
    const reparsed: Reparsed = { keys: new Map(), unknown: new Map(), moves: new Map(), added: [] }
    const counted = reparseRecords(transaction, adapters, reparsed)
    const rebuilt = rebuildProjections(transaction, reparsed, quiet, now, quietAfterMs)
    queueFacts(transaction, reparsed.added)
    refreshChecks(transaction, rebuilt, contracts, now)
    settleQuiet(transaction, quiet, now, quietAfterMs)
    return counted
  })
  return { ...tally, head: store.changes.head() }
}
