import type { DatabaseSync } from 'node:sqlite'
import { ChangeSeq, type Fact, type Gap, type RawRecord } from '@aang/contract'
import { prepareStatement } from './context.js'
import { factColumns, type FactRow, toFact } from './facts.js'
import { gapColumns, type GapRow, toGap } from './gaps.js'
import { rawRecordColumns, type RawRecordRow, toRawRecord } from './raw-records.js'

export type Change =
  | { readonly layer: 'raw_record'; readonly change_seq: ChangeSeq; readonly record: RawRecord }
  | { readonly layer: 'fact'; readonly change_seq: ChangeSeq; readonly fact: Fact }
  | { readonly layer: 'gap'; readonly change_seq: ChangeSeq; readonly gap: Gap }

export interface ChangeFeed {
  readonly head: () => ChangeSeq
  readonly after: (position: ChangeSeq, limit: number) => Change[]
}

const changeSeqOf = (row: { readonly change_seq: bigint }): ChangeSeq => ChangeSeq.parse(Number(row.change_seq))

const byChangeSeq = (left: Change, right: Change): number => left.change_seq - right.change_seq

export const createChangeFeed = (database: DatabaseSync): ChangeFeed => {
  const selectHead = prepareStatement(database, 'SELECT value FROM change_counter')
  const selectRawRecords = prepareStatement(
    database,
    `SELECT ${rawRecordColumns} FROM raw_records WHERE change_seq > ? ORDER BY change_seq LIMIT ?`,
  )
  const selectFacts = prepareStatement(
    database,
    `SELECT ${factColumns} FROM facts WHERE change_seq > ? ORDER BY change_seq LIMIT ?`,
  )
  const selectGaps = prepareStatement(
    database,
    `SELECT ${gapColumns} FROM gaps WHERE change_seq > ? ORDER BY change_seq LIMIT ?`,
  )

  return {
    head: () => ChangeSeq.parse(Number((selectHead.get() as { readonly value: bigint }).value)),
    after: (position, limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError(`change feed limit must be a positive integer, got ${String(limit)}`)
      }
      const records = (selectRawRecords.all(position, limit) as RawRecordRow[]).map(
        (row): Change => ({ layer: 'raw_record', change_seq: changeSeqOf(row), record: toRawRecord(row) }),
      )
      const facts = (selectFacts.all(position, limit) as FactRow[]).map(
        (row): Change => ({ layer: 'fact', change_seq: changeSeqOf(row), fact: toFact(row) }),
      )
      const gaps = (selectGaps.all(position, limit) as GapRow[]).map(
        (row): Change => ({ layer: 'gap', change_seq: changeSeqOf(row), gap: toGap(row) }),
      )
      return [...records, ...facts, ...gaps].sort(byChangeSeq).slice(0, limit)
    },
  }
}
