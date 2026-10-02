import { CollectedRecord, type Fact, type RawSeq } from '@aang/contract'
import type { Transaction } from '@aang/store'
import { type Adapters, collectedFields } from './records.js'

const pageSize = 256

export const normalizeOtel = (transaction: Transaction, adapters: Adapters): Fact[] => {
  const streams = transaction.scopes.list()
  const inserted: Fact[] = []
  let after: RawSeq | null = null
  for (;;) {
    const records = transaction.rawRecords.pendingOtel(after, pageSize)
    if (records.length === 0) {
      return inserted
    }
    for (const raw of records) {
      after = raw.seq
      const record = CollectedRecord.safeParse(collectedFields(raw)).data
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
        inserted.push(...transaction.facts.insert(raw.seq, adapter.normalizerVersion, result.facts))
        transaction.rawRecords.markParsed(raw.seq, stream, result.source_ts)
        break
      }
    }
  }
}
