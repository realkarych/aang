import type { DatabaseSync } from 'node:sqlite'
import { Gap, type GapId, type GapKind } from '@aang/contract'
import { canonicalJson, objectId } from '@aang/contract/ids'
import { decodeJson } from './codec.js'
import { prepareStatement, upsertInto, type WriteContext } from './context.js'

export type GapDraft = Omit<Gap, 'id' | 'kind' | 'change_seq'>

export interface GapReader {
  readonly get: (id: GapId) => Gap | null
  readonly open: (kind: GapKind) => Gap[]
}

export interface GapWriter extends GapReader {
  readonly save: (draft: GapDraft) => Gap
}

export interface GapRepository {
  readonly reader: GapReader
  readonly writer: (context: WriteContext) => GapWriter
}

export type GapRow = {
  readonly id: string
  readonly entity_key: string
  readonly kind: string
  readonly run_id: string | null
  readonly session_id: string | null
  readonly stream: string | null
  readonly details: string | null
  readonly detected_at: bigint
  readonly closed_at: bigint | null
  readonly change_seq: bigint
}

const columns = [
  'id',
  'entity_key',
  'kind',
  'run_id',
  'session_id',
  'stream',
  'details',
  'detected_at',
  'closed_at',
  'change_seq',
]

export const gapColumns = columns.join(', ')

export const toGap = (row: GapRow): Gap =>
  Gap.parse({
    id: row.id,
    key: decodeJson(row.entity_key),
    kind: row.kind,
    run: row.run_id,
    session: row.session_id,
    stream: row.stream,
    details: row.details,
    detected_at: row.detected_at,
    closed_at: row.closed_at,
    change_seq: Number(row.change_seq),
  })

const sameGap = (stored: Gap, draft: GapDraft): boolean =>
  stored.run === draft.run &&
  stored.session === draft.session &&
  stored.stream === draft.stream &&
  stored.details === draft.details &&
  stored.detected_at === draft.detected_at &&
  stored.closed_at === draft.closed_at

export const createGaps = (database: DatabaseSync): GapRepository => {
  const selectOpen = prepareStatement(database, `SELECT ${gapColumns} FROM gaps WHERE kind = ? AND closed_at IS NULL ORDER BY detected_at, id`)
  const selectById = prepareStatement(database, `SELECT ${gapColumns} FROM gaps WHERE id = ?`)
  const upsertGap = prepareStatement(database, upsertInto('gaps', 'id', columns))

  const reader: GapReader = {
    open: (kind) => (selectOpen.all(kind) as GapRow[]).map(toGap),
    get: (id) => {
      const row = selectById.get(id) as GapRow | undefined
      return row === undefined ? null : toGap(row)
    },
  }

  const writer = (context: WriteContext): GapWriter => ({
    ...reader,
    save: (draft) => {
      context.assertActive()
      const id = objectId(draft.key)
      const stored = reader.get(id)
      if (stored !== null && sameGap(stored, draft)) {
        return stored
      }
      const gap: Gap = {
        id,
        key: draft.key,
        kind: draft.key.gap,
        run: draft.run,
        session: draft.session,
        stream: draft.stream,
        details: draft.details,
        detected_at: draft.detected_at,
        closed_at: draft.closed_at,
        change_seq: context.nextChangeSeq(),
      }
      upsertGap.run({
        id: gap.id,
        entity_key: canonicalJson(gap.key),
        kind: gap.kind,
        run_id: gap.run,
        session_id: gap.session,
        stream: gap.stream,
        details: gap.details,
        detected_at: gap.detected_at,
        closed_at: gap.closed_at,
        change_seq: gap.change_seq,
      })
      return gap
    },
  })

  return { reader, writer }
}
