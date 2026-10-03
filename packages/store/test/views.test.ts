import { AttentionItemId, ChangeSeq, ModelVersion, RunId } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import type { Store } from '@aang/store'
import { expect, test } from 'vitest'
import { createHome } from './home.js'
import { instant } from './records.js'

const run = runId({ kind: 'session', runtime: 'claude', session: 's1' })
const otherRun = runId({ kind: 'session', runtime: 'codex', session: 's2' })
const question = AttentionItemId.parse('attention:question')
const check = AttentionItemId.parse('attention:check')

const commitVersion = (store: Store, target: RunId): ChangeSeq =>
  store.transaction((transaction) => {
    const version = ModelVersion.parse(transaction.model.head(target) + 1)
    const changeSeq = transaction.nextChangeSeq()
    transaction.model.commit(
      {
        run: target,
        version,
        base_version: ModelVersion.parse(version - 1),
        author: 'rule',
        observer_call: null,
        created_at: instant(BigInt(version)),
        change_seq: changeSeq,
      },
      [],
    )
    return changeSeq
  })

test('a run keeps one view mark that the next mark replaces and that survives reopening', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const first = { run, version: ModelVersion.parse(2), change_seq: ChangeSeq.parse(7), marked_at: instant(10n) }
  const second = { run, version: ModelVersion.parse(3), change_seq: ChangeSeq.parse(9), marked_at: instant(20n) }
  const other = { run: otherRun, version: ModelVersion.parse(0), change_seq: ChangeSeq.parse(0), marked_at: instant(5n) }

  expect(store.views.mark(run)).toBeNull()
  store.transaction((transaction) => {
    transaction.views.saveMark(first)
    transaction.views.saveMark(other)
  })
  store.transaction((transaction) => {
    transaction.views.saveMark(second)
  })
  store.close()
  const reopened = home.open()

  expect(reopened.views.mark(run)).toEqual(second)
  expect(reopened.views.mark(otherRun)).toEqual(other)
})

test('the model version at a change sequence number is the last version of the run committed up to it', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const first = commitVersion(store, run)
  const other = commitVersion(store, otherRun)
  commitVersion(store, run)
  const third = commitVersion(store, run)

  expect(store.model.versionAt(run, ChangeSeq.parse(0))).toBe(0)
  expect(store.model.versionAt(run, ChangeSeq.parse(first - 1))).toBe(0)
  expect(store.model.versionAt(run, first)).toBe(1)
  expect(store.model.versionAt(run, other)).toBe(1)
  expect(store.model.versionAt(run, ChangeSeq.parse(third - 1))).toBe(2)
  expect(store.model.versionAt(run, third)).toBe(3)
  expect(store.model.versionAt(otherRun, third)).toBe(1)
})

test('viewing and dismissing an attention item each take a change sequence number, repeating them takes none', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const start = store.changes.head()

  const viewed = store.transaction((transaction) =>
    transaction.views.saveAttention(run, { item: question, viewed_at: instant(1n), dismissed_at: null }),
  )
  const repeated = store.transaction((transaction) =>
    transaction.views.saveAttention(run, { item: question, viewed_at: instant(1n), dismissed_at: null }),
  )
  const dismissed = store.transaction((transaction) =>
    transaction.views.saveAttention(run, { item: question, viewed_at: instant(1n), dismissed_at: instant(2n) }),
  )
  const checked = store.transaction((transaction) =>
    transaction.views.saveAttention(otherRun, { item: check, viewed_at: null, dismissed_at: instant(3n) }),
  )
  store.close()
  const reopened = home.open()

  expect(viewed).toEqual({ item: question, viewed_at: instant(1n), dismissed_at: null, change_seq: start + 1 })
  expect(repeated).toEqual(viewed)
  expect(dismissed).toEqual({ item: question, viewed_at: instant(1n), dismissed_at: instant(2n), change_seq: start + 2 })
  expect(checked).toEqual({ item: check, viewed_at: null, dismissed_at: instant(3n), change_seq: start + 3 })
  expect(reopened.changes.head()).toBe(start + 3)
  expect(reopened.views.attentionView(run, question)).toEqual(dismissed)
  expect(reopened.views.attentionView(run, check)).toBeNull()
  expect(reopened.views.attention(run, ChangeSeq.parse(0))).toEqual([dismissed])
  expect(reopened.views.attention(run, dismissed.change_seq)).toEqual([])
  expect(reopened.views.attention(otherRun, ChangeSeq.parse(0))).toEqual([checked])
})

test('attention views of a run are listed in the order of their changes after a position', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const view = (name: string, at: bigint) =>
    store.transaction((transaction) =>
      transaction.views.saveAttention(run, {
        item: AttentionItemId.parse(`attention:${name}`),
        viewed_at: instant(at),
        dismissed_at: null,
      }),
    )

  const first = view('c', 1n)
  const second = view('a', 2n)
  const third = view('b', 3n)

  expect(store.views.attention(run, ChangeSeq.parse(0))).toEqual([first, second, third])
  expect(store.views.attention(run, first.change_seq)).toEqual([second, third])
})

test('an attention view without a view or a dismissal is refused and rolled back', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const start = store.changes.head()

  expect(() =>
    store.transaction((transaction) =>
      transaction.views.saveAttention(run, { item: question, viewed_at: null, dismissed_at: null }),
    ),
  ).toThrow(/attention_views_marked/)
  expect(store.changes.head()).toBe(start)
  expect(store.views.attention(run, ChangeSeq.parse(0))).toEqual([])
})
