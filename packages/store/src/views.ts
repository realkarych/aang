import type { DatabaseSync } from 'node:sqlite'
import { type AttentionItemId, AttentionView, type ChangeSeq, type RunId, ViewMark } from '@aang/contract'
import { prepareStatement, upsertInto, type WriteContext } from './context.js'

export type AttentionViewDraft = Omit<AttentionView, 'change_seq'>

export interface ViewReader {
  readonly mark: (run: RunId) => ViewMark | null
  readonly attentionView: (run: RunId, item: AttentionItemId) => AttentionView | null
  readonly attention: (run: RunId, after: ChangeSeq) => AttentionView[]
}

export interface ViewWriter extends ViewReader {
  readonly saveMark: (mark: ViewMark) => void
  readonly saveAttention: (run: RunId, view: AttentionViewDraft) => AttentionView
}

export interface ViewRepository {
  readonly reader: ViewReader
  readonly writer: (context: WriteContext) => ViewWriter
}

type MarkRow = {
  readonly run_id: string
  readonly model_version: bigint
  readonly change_seq: bigint
  readonly viewed_at: bigint
}

type AttentionViewRow = {
  readonly item_id: string
  readonly viewed_at: bigint | null
  readonly dismissed_at: bigint | null
  readonly change_seq: bigint
}

const markColumns = ['run_id', 'model_version', 'change_seq', 'viewed_at']

const attentionColumns = ['item_id', 'viewed_at', 'dismissed_at', 'change_seq']

const toMark = (row: MarkRow): ViewMark =>
  ViewMark.parse({
    run: row.run_id,
    version: Number(row.model_version),
    change_seq: Number(row.change_seq),
    marked_at: row.viewed_at,
  })

const toAttentionView = (row: AttentionViewRow): AttentionView =>
  AttentionView.parse({
    item: row.item_id,
    viewed_at: row.viewed_at,
    dismissed_at: row.dismissed_at,
    change_seq: Number(row.change_seq),
  })

const sameView = (left: AttentionViewDraft, right: AttentionViewDraft): boolean =>
  left.viewed_at === right.viewed_at && left.dismissed_at === right.dismissed_at

export const createViews = (database: DatabaseSync): ViewRepository => {
  const selectMark = prepareStatement(database, `SELECT ${markColumns.join(', ')} FROM view_marks WHERE run_id = ?`)
  const selectAttentionView = prepareStatement(
    database,
    `SELECT ${attentionColumns.join(', ')} FROM attention_views WHERE run_id = ? AND item_id = ?`,
  )
  const selectAttention = prepareStatement(
    database,
    `SELECT ${attentionColumns.join(', ')} FROM attention_views WHERE run_id = ? AND change_seq > ?
     ORDER BY change_seq, item_id`,
  )
  const upsertMark = prepareStatement(database, upsertInto('view_marks', 'run_id', markColumns))
  const upsertAttention = prepareStatement(
    database,
    `INSERT INTO attention_views (run_id, item_id, viewed_at, dismissed_at, change_seq)
     VALUES (:run_id, :item_id, :viewed_at, :dismissed_at, :change_seq)
     ON CONFLICT (run_id, item_id) DO UPDATE SET
       viewed_at = excluded.viewed_at, dismissed_at = excluded.dismissed_at, change_seq = excluded.change_seq`,
  )

  const attentionView = (run: RunId, item: AttentionItemId): AttentionView | null => {
    const row = selectAttentionView.get(run, item) as AttentionViewRow | undefined
    return row === undefined ? null : toAttentionView(row)
  }

  const reader: ViewReader = {
    mark: (run) => {
      const row = selectMark.get(run) as MarkRow | undefined
      return row === undefined ? null : toMark(row)
    },
    attentionView,
    attention: (run, after) => (selectAttention.all(run, after) as AttentionViewRow[]).map(toAttentionView),
  }

  const writer = (context: WriteContext): ViewWriter => ({
    ...reader,
    saveMark: (mark) => {
      context.assertActive()
      upsertMark.run({
        run_id: mark.run,
        model_version: mark.version,
        change_seq: mark.change_seq,
        viewed_at: mark.marked_at,
      })
    },
    saveAttention: (run, view) => {
      context.assertActive()
      const previous = attentionView(run, view.item)
      if (previous !== null && sameView(previous, view)) {
        return previous
      }
      const stored = AttentionView.parse({ ...view, change_seq: context.nextChangeSeq() })
      upsertAttention.run({
        run_id: run,
        item_id: stored.item,
        viewed_at: stored.viewed_at,
        dismissed_at: stored.dismissed_at,
        change_seq: stored.change_seq,
      })
      return stored
    },
  })

  return { reader, writer }
}
