import { ChangeSeq, GapKey, RawSeq, RunId } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import type { Change, Store } from '@aang/store'
import { expect, test } from 'vitest'
import { createHome } from './home.js'
import {
  hookRecord,
  instant,
  mainStream,
  messageFact,
  normalizerVersion,
  sourceLostGap,
  transcriptCursor,
  transcriptRecord,
} from './records.js'

const start = ChangeSeq.parse(0)

const summarize = (changes: readonly Change[]): unknown[] =>
  changes.map((change) => {
    switch (change.layer) {
      case 'raw_record':
        return [change.change_seq, change.layer, change.record.seq]
      case 'fact':
        return [change.change_seq, change.layer, change.fact.id]
      case 'gap':
        return [change.change_seq, change.layer, change.gap.id, change.gap.closed_at]
    }
  })

const fillStore = (store: Store): void => {
  store.transaction((transaction) => {
    transaction.scopes.decide({ stream: mainStream, runtime: 'claude', scope: 'watched' })
    const { seq } = transaction.rawRecords.insert(transcriptRecord(1))
    transaction.facts.insert(seq, normalizerVersion, [messageFact('m1', 'one'), messageFact('m2', 'two')])
    transaction.cursors.save(transcriptCursor(1))
  })
  store.transaction((transaction) => {
    transaction.gaps.save(sourceLostGap())
    transaction.rawRecords.insert(hookRecord('1759370000999-4242-b2.evt'))
  })
  store.transaction((transaction) => {
    transaction.gaps.save(sourceLostGap({ closed_at: instant(3_000n) }))
  })
}

test('a gap is stored under the id of its key and saving it unchanged issues no change', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const draft = sourceLostGap({ run: RunId.parse('a'.repeat(32)) })
  const id = objectId(draft.key)

  const saved = store.transaction((transaction) => transaction.gaps.save(draft))
  const unchanged = store.transaction((transaction) => transaction.gaps.save(sourceLostGap({ run: draft.run })))
  const closed = store.transaction((transaction) =>
    transaction.gaps.save({ ...draft, closed_at: instant(5_000n), details: 'transcript found again' }),
  )
  store.close()
  const reopened = home.open()

  expect(saved).toEqual({ ...draft, id, kind: 'source_lost', change_seq: 1 })
  expect(unchanged).toEqual(saved)
  expect(closed).toEqual({
    ...saved,
    closed_at: instant(5_000n),
    details: 'transcript found again',
    change_seq: 2,
  })
  expect(reopened.gaps.get(id)).toEqual(closed)
  expect(reopened.changes.head()).toBe(2)
  expect(reopened.gaps.get(objectId(GapKey.parse({ kind: 'gap', gap: 'read_failed', subject: mainStream })))).toBeNull()
})

test('a gap cannot be closed before it was detected', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const draft = sourceLostGap()

  expect(() =>
    store.transaction((transaction) => transaction.gaps.save({ ...draft, closed_at: instant(999n) })),
  ).toThrow(/CHECK constraint failed: closed_at >= detected_at/)
})

test('the change feed lists raw records, facts and gaps after a position in the order of their changes', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  fillStore(store)
  const [first, second] = store.facts.ofRecord(RawSeq.parse(1))
  const gapId = objectId(sourceLostGap().key)

  const everything = summarize(store.changes.after(start, 100))
  const latest = summarize(store.changes.after(ChangeSeq.parse(4), 100))

  expect(everything).toEqual([
    [1, 'raw_record', 1],
    [2, 'fact', first?.id],
    [3, 'fact', second?.id],
    [5, 'raw_record', 2],
    [6, 'gap', gapId, instant(3_000n)],
  ])
  expect(latest).toEqual(everything.slice(3))
  expect(store.changes.head()).toBe(6)
  expect(store.changes.after(store.changes.head(), 100)).toEqual([])
})

test('paging through the change feed returns every change exactly once', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  fillStore(store)
  const pages: Change[][] = []

  let position = start
  for (;;) {
    const page = store.changes.after(position, 2)
    if (page.length === 0) {
      break
    }
    pages.push(page)
    position = page.at(-1)?.change_seq ?? position
  }

  expect(pages.map((page) => page.length)).toEqual([2, 2, 1])
  expect(pages.flat()).toEqual(store.changes.after(start, 100))
})

test('the change feed limit must be a positive integer', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()

  for (const limit of [0, -1, 1.5, Number.NaN]) {
    expect(() => store.changes.after(start, limit)).toThrow(RangeError)
  }
})
