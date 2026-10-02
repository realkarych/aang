import { CollectedRecord, type EpochNs, type RawRecord, type RawSeq, type RecordOwner, type Session, type StreamKey } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { Transaction } from '@aang/store'
import type { Adapters } from '../ingest/records.js'

export interface SourceRecord {
  readonly raw: RawRecord
  readonly owner: RecordOwner
}

export const streamOwner = (transaction: Transaction, adapters: Adapters, stream: StreamKey): RecordOwner | null => {
  let after: RawSeq | null = null
  for (;;) {
    const records = transaction.rawRecords.ofStream(stream, after, 64)
    if (records.length === 0) { return null }
    for (const raw of records) {
      after = raw.seq
      const record = CollectedRecord.safeParse({
        channel: raw.channel, runtime: raw.runtime, stream: raw.stream, position: raw.position,
        hook: raw.hook, observed_at: raw.observed_at, payload: raw.payload,
      }).data
      if (record === undefined) { continue }
      const owner = adapters[record.runtime].owner(record)
      if (owner !== null) { return owner }
    }
  }
}

export const sourceGaps = (transaction: Transaction, session: Omit<Session, 'change_seq'>, at: EpochNs): void => {
  const key = { kind: 'gap', gap: 'hooks_inactive', subject: session.id } as const
  const previous = transaction.gaps.get(objectId(key))
  if (session.support_mode === 'files_only' || previous !== null) {
    transaction.gaps.save({
      key, session: session.id, run: session.run, stream: null,
      details: 'Session files are available without hook events',
      detected_at: previous?.detected_at ?? at,
      closed_at: session.support_mode === 'files_only' ? null : previous?.closed_at ?? at,
    })
  }
  if (session.unknown_records > 0) {
    const unknown = { kind: 'gap', gap: 'unknown_records', subject: session.id } as const
    transaction.gaps.save({
      key: unknown, session: session.id, run: session.run, stream: null,
      details: `${String(session.unknown_records)} unrecognised session records`,
      detected_at: transaction.gaps.get(objectId(unknown))?.detected_at ?? at,
      closed_at: null,
    })
  }
}
