import {
  type ChangeSeq,
  CollectedRecord,
  type EpochNs,
  type RawSeq,
  type RecordOwner,
  type ReparseResponse,
  type SessionKey,
  type StreamKey,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { Observation, Store, Transaction } from '@aang/store'
import { normalizeOtel } from '../ingest/otel.js'
import { type Adapters, collectedFields, sessionName } from '../ingest/records.js'
import { lostSessions, type QuietWatch, settleQuiet, watchQuiet } from '../observations/freshness.js'
import { projectSession } from '../observations/project.js'
import { streamOwner } from '../observations/sources.js'

export interface ReparseResult extends ReparseResponse {
  readonly head: ChangeSeq
}

interface OwnedSessions {
  readonly keys: Map<string, SessionKey>
  readonly unknown: Map<string, number>
}

const pageSize = 256

const reparseRecords = (transaction: Transaction, adapters: Adapters, owned: OwnedSessions): ReparseResponse => {
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
        const revision = transaction.facts.replace(
          raw.seq,
          adapter.normalizerVersion,
          result.parse_state === 'parsed' ? result.facts : [],
        )
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
          owned.keys.set(name, owner.session)
          if (result.parse_state !== 'parsed') {
            owned.unknown.set(name, (owned.unknown.get(name) ?? 0) + 1)
          }
        }
        tally.records += 1
        tally.facts_added += revision.added.length
        tally.facts_kept += revision.kept.length
        tally.facts_missing += revision.removed.length
      }
    }
  }
  tally.facts_added += normalizeOtel(transaction, adapters).length
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
  owned: OwnedSessions,
  quiet: QuietWatch,
  now: EpochNs,
  quietAfterMs: number,
): void => {
  const supported = new Map(owned.keys)
  for (const key of transaction.facts.sessions()) {
    supported.set(sessionName(key), key)
  }
  const sessions = new Map(supported)
  for (const { key } of transaction.observations.sessions()) {
    sessions.set(sessionName(key), key)
  }
  const lost = lostSessions(transaction)
  for (const [name, key] of sessions) {
    const projection = supported.has(name)
      ? projectSession(transaction, key, [], lost, now, quietAfterMs, owned.unknown.get(name) ?? 0)
      : null
    if (projection === null) {
      quiet.delete(objectId(key))
    } else {
      watchQuiet(quiet, projection.session)
    }
    const projected = new Set(projection?.objects)
    for (const observation of storedObservations(transaction, key)) {
      if (!projected.has(observation.id)) {
        transaction.observations.delete(observation)
      }
    }
  }
  settleQuiet(transaction, quiet, now, quietAfterMs)
}

export const reparse = (
  store: Store,
  adapters: Adapters,
  quiet: QuietWatch,
  now: EpochNs,
  quietAfterMs: number,
): ReparseResult => {
  const tally = store.transaction((transaction) => {
    const owned: OwnedSessions = { keys: new Map(), unknown: new Map() }
    const counted = reparseRecords(transaction, adapters, owned)
    rebuildProjections(transaction, owned, quiet, now, quietAfterMs)
    return counted
  })
  return { ...tally, head: store.changes.head() }
}
