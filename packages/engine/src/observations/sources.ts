import { CollectedRecord, type EpochNs, type RawRecord, type RawSeq, type RecordOwner, type Session, type StreamKey } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { RawRecordReader, Transaction } from '@aang/store'
import { type Adapters, collectedFields } from '../ingest/records.js'

export interface SourceRecord {
  readonly raw: RawRecord
  readonly owner: RecordOwner
}

export const collectedOf = (raw: RawRecord): CollectedRecord | null =>
  CollectedRecord.safeParse(collectedFields(raw)).data ?? null

export const streamOwner = (
  { rawRecords }: { readonly rawRecords: RawRecordReader },
  adapters: Adapters,
  stream: StreamKey,
): RecordOwner | null => {
  let after: RawSeq | null = null
  for (;;) {
    const records = rawRecords.ofStream(stream, after, 64)
    if (records.length === 0) { return null }
    for (const raw of records) {
      after = raw.seq
      const record = collectedOf(raw)
      if (record === null) { continue }
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
  const unknown = { kind: 'gap', gap: 'unknown_records', subject: session.id } as const
  const unrecognised = transaction.gaps.get(objectId(unknown))
  if (session.unknown_records > 0) {
    transaction.gaps.save({
      key: unknown, session: session.id, run: session.run, stream: null,
      details: `${String(session.unknown_records)} unrecognised session records`,
      detected_at: unrecognised?.detected_at ?? at,
      closed_at: null,
    })
  } else if (unrecognised?.closed_at === null) {
    transaction.gaps.save({
      key: unknown, session: session.id, run: session.run, stream: null,
      details: unrecognised.details, detected_at: unrecognised.detected_at, closed_at: at,
    })
  }
}
