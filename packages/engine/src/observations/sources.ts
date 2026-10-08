import {
  CollectedRecord,
  type EpochNs,
  type RawRecord,
  type RawSeq,
  type RecordOwner,
  type Session,
  type StreamKey,
  type SupportMode,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { RawRecordReader, Transaction } from '@aang/store'
import { type Adapters, collectedFields } from '../ingest/records.js'
import { isSilent, type SessionSilence } from './silence.js'

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

type Silence = Omit<SessionSilence, 'awaiting'>

const silenceGaps = (
  transaction: Transaction,
  session: Omit<Session, 'change_seq'>,
  at: EpochNs,
  { silences, hooks }: Silence,
  previous: SupportMode | null,
): void => {
  const current = new Set<string>()
  for (const { from, until } of silences) {
    const key = { kind: 'gap', gap: 'hooks_inactive', subject: `${session.id}/${String(from)}` } as const
    current.add(objectId(key))
    transaction.gaps.save({
      key, session: session.id, run: session.run, stream: null,
      details: 'A turn in the session files has no hook events',
      detected_at: from,
      closed_at: until,
    })
  }
  if (previous !== 'files_only') { return }
  for (const gap of transaction.gaps.open('hooks_inactive')) {
    if (gap.session === session.id && gap.key.subject !== session.id && !current.has(gap.id)) {
      transaction.gaps.save({
        key: gap.key, session: gap.session, run: gap.run, stream: gap.stream,
        details: gap.details, detected_at: gap.detected_at, closed_at: hooks.find((time) => time >= gap.detected_at) ?? at,
      })
    }
  }
}

export const sourceGaps = (
  transaction: Transaction,
  session: Omit<Session, 'change_seq'>,
  at: EpochNs,
  silence: Silence,
  previous: SupportMode | null,
): void => {
  const key = { kind: 'gap', gap: 'hooks_inactive', subject: session.id } as const
  const whole = transaction.gaps.get(objectId(key))
  const inactive = session.support_mode === 'files_only' && !isSilent(silence.silences)
  if (inactive || whole !== null) {
    transaction.gaps.save({
      key, session: session.id, run: session.run, stream: null,
      details: 'Session files are available without hook events',
      detected_at: whole?.detected_at ?? at,
      closed_at: inactive ? null : whole?.closed_at ?? at,
    })
  }
  silenceGaps(transaction, session, at, silence, previous)
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
