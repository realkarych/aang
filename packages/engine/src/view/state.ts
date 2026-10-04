import {
  type AttentionItemId,
  type AttentionView,
  EpochNs,
  type RunId,
  type ViewMark,
  type ViewPosition,
} from '@aang/contract'
import type { AttentionViewDraft, Store, Transaction } from '@aang/store'
import { InvalidPositionError } from '../read/context.js'

export interface ViewStateOptions {
  readonly store: Store
  readonly now?: () => EpochNs
}

export interface ViewState {
  readonly markViewed: (run: RunId, position: ViewPosition) => ViewMark | null
  readonly viewItem: (run: RunId, item: AttentionItemId) => AttentionView | null
  readonly dismissItem: (run: RunId, item: AttentionItemId) => AttentionView | null
}

type ItemChange = (previous: AttentionView | null, at: EpochNs) => Omit<AttentionViewDraft, 'item'>

const hasRun = (transaction: Transaction, run: RunId): boolean =>
  transaction.model.entity(run, { kind: 'run', id: run })?.kind === 'run'

const hasItem = (transaction: Transaction, run: RunId, item: AttentionItemId): boolean =>
  transaction.model.entity(run, { kind: 'attention_item', id: item })?.kind === 'attention_item'

export const createViewState = ({
  store,
  now = () => EpochNs.parse(BigInt(Date.now()) * 1_000_000n),
}: ViewStateOptions): ViewState => {
  const changeItem = (run: RunId, item: AttentionItemId, change: ItemChange): AttentionView | null =>
    store.transaction((transaction) =>
      hasItem(transaction, run, item)
        ? transaction.views.saveAttention(run, { item, ...change(transaction.views.attentionView(run, item), now()) })
        : null,
    )

  return {
    markViewed: (run, { version, change_seq: changeSeq }) =>
      store.transaction((transaction) => {
        if (!hasRun(transaction, run)) {
          return null
        }
        const head = store.changes.head()
        if (changeSeq > head) {
          throw new InvalidPositionError(
            `change position ${String(changeSeq)} is ahead of the change feed at ${String(head)}`,
          )
        }
        const seen = transaction.model.versionAt(run, changeSeq)
        if (version !== seen) {
          throw new InvalidPositionError(
            `model version ${String(version)} and change position ${String(changeSeq)} are not one state: the run was at version ${String(seen)}`,
          )
        }
        const mark: ViewMark = { run, version, change_seq: changeSeq, marked_at: now() }
        transaction.views.saveMark(mark)
        return mark
      }),
    viewItem: (run, item) =>
      changeItem(run, item, (previous, at) => ({
        viewed_at: previous?.viewed_at ?? at,
        dismissed_at: previous?.dismissed_at ?? null,
      })),
    dismissItem: (run, item) =>
      changeItem(run, item, (previous, at) => ({
        viewed_at: previous?.viewed_at ?? null,
        dismissed_at: previous?.dismissed_at ?? at,
      })),
  }
}
