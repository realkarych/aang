import type { DatabaseSync } from 'node:sqlite'
import {
  type AttentionItemId,
  AttentionView,
  ChangeSeq,
  type EpochNs,
  type RunId,
  ViewMark,
  ViewRule,
  type ViewRuleId,
  type ViewRuleSource,
  type ViewRuleSpec,
} from '@aang/contract'
import { decodeJson, encodeJson } from './codec.js'
import { prepareStatement, upsertInto, type WriteContext } from './context.js'

export type AttentionViewDraft = Omit<AttentionView, 'change_seq'>

export type ViewRuleDraft = ViewRuleSpec & {
  readonly run: RunId
  readonly source: ViewRuleSource
  readonly created_at: EpochNs
}

export interface ViewReader {
  readonly mark: (run: RunId) => ViewMark | null
  readonly markChangeSeq: (run: RunId) => ChangeSeq | null
  readonly attentionView: (run: RunId, item: AttentionItemId) => AttentionView | null
  readonly attention: (run: RunId, after: ChangeSeq) => AttentionView[]
  readonly rules: (run: RunId) => ViewRule[]
  readonly rule: (run: RunId, id: ViewRuleId) => ViewRule | null
}

export interface ViewWriter extends ViewReader {
  readonly saveMark: (mark: ViewMark) => void
  readonly saveAttention: (run: RunId, view: AttentionViewDraft) => AttentionView
  readonly saveRule: (draft: ViewRuleDraft) => ViewRule
  readonly revokeRule: (run: RunId, id: ViewRuleId, at: EpochNs) => ViewRule | null
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
  readonly mark_change_seq: bigint
}

type AttentionViewRow = {
  readonly item_id: string
  readonly viewed_at: bigint | null
  readonly dismissed_at: bigint | null
  readonly change_seq: bigint
}

type RuleRow = {
  readonly id: bigint
  readonly run_id: string
  readonly action: string
  readonly selector: string
  readonly params: string | null
  readonly source: string
  readonly created_at: bigint
  readonly revoked_at: bigint | null
}

const markColumns = ['run_id', 'model_version', 'change_seq', 'viewed_at', 'mark_change_seq']

const ruleColumns = 'id, run_id, action, selector, params, source, created_at, revoked_at'

const ruleNumber = /^[1-9][0-9]*$/

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

const toRule = (row: RuleRow): ViewRule =>
  ViewRule.parse({
    id: String(row.id),
    run: row.run_id,
    action: row.action,
    selector: decodeJson(row.selector),
    params: row.params === null ? null : decodeJson(row.params),
    source: row.source,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  })

const sameView = (left: AttentionViewDraft, right: AttentionViewDraft): boolean =>
  left.viewed_at === right.viewed_at && left.dismissed_at === right.dismissed_at

const sameMark = (left: ViewMark, right: ViewMark): boolean =>
  left.version === right.version && left.change_seq === right.change_seq && left.marked_at === right.marked_at

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
  const selectRules = prepareStatement(database, `SELECT ${ruleColumns} FROM view_rules WHERE run_id = ? ORDER BY id`)
  const selectRule = prepareStatement(database, `SELECT ${ruleColumns} FROM view_rules WHERE run_id = ? AND id = ?`)
  const insertRule = prepareStatement(
    database,
    `INSERT INTO view_rules (run_id, action, selector, params, source, created_at, change_seq)
     VALUES (:run_id, :action, :selector, :params, :source, :created_at, :change_seq)
     RETURNING ${ruleColumns}`,
  )
  const updateRevoked = prepareStatement(
    database,
    `UPDATE view_rules SET revoked_at = ?, change_seq = ? WHERE id = ? RETURNING ${ruleColumns}`,
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

  const markRow = (run: RunId): MarkRow | undefined => selectMark.get(run) as MarkRow | undefined

  const rule = (run: RunId, id: ViewRuleId): ViewRule | null => {
    if (!ruleNumber.test(id)) {
      return null
    }
    const row = selectRule.get(run, BigInt(id)) as RuleRow | undefined
    return row === undefined ? null : toRule(row)
  }

  const reader: ViewReader = {
    mark: (run) => {
      const row = markRow(run)
      return row === undefined ? null : toMark(row)
    },
    markChangeSeq: (run) => {
      const row = markRow(run)
      return row === undefined ? null : ChangeSeq.parse(Number(row.mark_change_seq))
    },
    attentionView,
    attention: (run, after) => (selectAttention.all(run, after) as AttentionViewRow[]).map(toAttentionView),
    rules: (run) => (selectRules.all(run) as RuleRow[]).map(toRule),
    rule,
  }

  const writer = (context: WriteContext): ViewWriter => ({
    ...reader,
    saveMark: (mark) => {
      context.assertActive()
      const previous = reader.mark(mark.run)
      if (previous !== null && sameMark(previous, mark)) {
        return
      }
      upsertMark.run({
        run_id: mark.run,
        model_version: mark.version,
        change_seq: mark.change_seq,
        viewed_at: mark.marked_at,
        mark_change_seq: context.nextChangeSeq(),
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
    saveRule: (draft) => {
      context.assertActive()
      return toRule(
        insertRule.get({
          run_id: draft.run,
          action: draft.action,
          selector: encodeJson(draft.selector),
          params: draft.params === null ? null : encodeJson(draft.params),
          source: draft.source,
          created_at: draft.created_at,
          change_seq: context.nextChangeSeq(),
        }) as RuleRow,
      )
    },
    revokeRule: (run, id, at) => {
      context.assertActive()
      const previous = rule(run, id)
      if (previous === null || previous.revoked_at !== null) {
        return previous
      }
      const revokedAt = at > previous.created_at ? at : previous.created_at
      return toRule(updateRevoked.get(revokedAt, context.nextChangeSeq(), BigInt(id)) as RuleRow)
    },
  })

  return { reader, writer }
}
