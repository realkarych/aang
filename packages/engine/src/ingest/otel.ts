import { CollectedRecord, type RawSeq, type SessionKey } from '@aang/contract'
import type { Transaction } from '@aang/store'
import type { Adapters } from './records.js'

const pageSize = 256

export const normalizeOtel = (transaction: Transaction, adapters: Adapters): SessionKey[] => {
  const streams = transaction.scopes.list()
  const changed: SessionKey[] = []
  let after: RawSeq | null = null
  for (;;) {
    const records = transaction.rawRecords.pendingOtel(after, pageSize)
    if (records.length === 0) {
      return changed
    }
    for (const raw of records) {
      after = raw.seq
      const record = CollectedRecord.safeParse({
        channel: raw.channel,
        runtime: raw.runtime,
        stream: raw.stream,
        position: raw.position,
        hook: raw.hook,
        observed_at: raw.observed_at,
        payload: raw.payload,
      }).data
      if (record === undefined) {
        continue
      }
      const adapter = adapters[record.runtime]
      for (const { stream, scope, runtime } of streams) {
        if (runtime !== record.runtime) {
          continue
        }
        const candidate = { ...record, stream }
        const owner = adapter.owner(candidate)
        if (owner === null) {
          continue
        }
        if (scope !== 'watched' || owner.observer) {
          transaction.rawRecords.discardUnparsed(raw.seq)
          break
        }
        const result = adapter.parse(candidate)
        if (result.parse_state !== 'parsed' || result.facts.length === 0) {
          break
        }
        const facts = transaction.facts.insert(raw.seq, adapter.normalizerVersion, result.facts)
        transaction.rawRecords.markParsed(raw.seq, stream, result.source_ts)
        for (const { entity_key } of facts) {
          changed.push({ kind: 'session', runtime: entity_key.runtime, session: entity_key.session })
        }
        break
      }
    }
  }
}
