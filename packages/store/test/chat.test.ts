import { ChangeSeq, ChatMessageId, ModelVersion, StageId, ViewRuleId } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import type { ChatAnswer, Store } from '@aang/store'
import { expect, test } from 'vitest'
import { createHome } from './home.js'
import { instant } from './records.js'

const run = runId({ kind: 'session', runtime: 'claude', session: 's1' })
const otherRun = runId({ kind: 'session', runtime: 'codex', session: 's2' })
const stage = StageId.parse('stage:build')

const answer = (overrides: Partial<ChatAnswer> = {}): ChatAnswer => ({
  answer: 'The build stage is done.',
  citations: [{ kind: 'stage', id: stage }],
  unconfirmed_citations: false,
  insufficient_data: false,
  view_rule: null,
  answered_at: instant(30n),
  ...overrides,
})

const ask = (store: Store, question: string, version = 1, target = run) =>
  store.transaction((transaction) =>
    transaction.chat.ask({
      run: target,
      stage: target === run ? stage : null,
      question,
      version: ModelVersion.parse(version),
      asked_at: instant(10n),
    }),
  )

test('a question waits for its answer at the model version it was asked on, and the answer replaces it at a new change sequence number', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const before = store.changes.head()

  const asked = ask(store, 'What is left?', 3)
  const answered = store.transaction((transaction) =>
    transaction.chat.answer(run, asked.id, answer({ unconfirmed_citations: true, view_rule: ViewRuleId.parse('4') })),
  )

  expect(asked).toEqual({
    id: asked.id,
    run,
    stage,
    question: 'What is left?',
    status: 'pending',
    version: 3,
    answer: null,
    citations: [],
    unconfirmed_citations: false,
    insufficient_data: false,
    view_rule: null,
    error: null,
    asked_at: instant(10n),
    answered_at: null,
  })
  expect(answered).toEqual({
    ...asked,
    status: 'answered',
    answer: 'The build stage is done.',
    citations: [{ kind: 'stage', id: stage }],
    unconfirmed_citations: true,
    view_rule: '4',
    answered_at: instant(30n),
  })
  expect(store.chat.changed(run, before)).toEqual([{ change_seq: before + 2, message: answered }])
  expect(store.chat.changed(run, ChangeSeq.parse(before + 1))).toEqual([{ change_seq: before + 2, message: answered }])
  expect(store.chat.changed(run, ChangeSeq.parse(before + 2))).toEqual([])
  expect(store.chat.changed(otherRun, before)).toEqual([])
  expect(store.changes.head()).toBe(before + 2)
})

test('the chat of a run keeps its questions in order, apart from other runs, and survives reopening', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const first = ask(store, 'What is left?')
  const other = ask(store, 'Why did it stop?', 2, otherRun)
  const second = ask(store, 'Who reviews it?')
  const insufficient = store.transaction((transaction) =>
    transaction.chat.answer(run, second.id, answer({ answer: null, citations: [], insufficient_data: true })),
  )
  const failed = store.transaction((transaction) =>
    transaction.chat.fail(otherRun, other.id, { error: 'Codex did not complete its turn', answered_at: instant(20n) }),
  )
  store.close()
  const reopened = home.open()

  expect(reopened.chat.messages(run)).toEqual([first, insufficient])
  expect(reopened.chat.messages(otherRun)).toEqual([failed])
  expect(failed).toMatchObject({ status: 'failed', answer: null, error: 'Codex did not complete its turn', answered_at: instant(20n) })
  expect(insufficient).toMatchObject({ status: 'answered', answer: null, citations: [], insufficient_data: true })
  expect(reopened.chat.message(run, first.id)).toEqual(first)
  expect(reopened.chat.message(otherRun, first.id)).toBeNull()
  expect(reopened.chat.message(run, ChatMessageId.parse('question-1'))).toBeNull()
  expect(reopened.chat.pending()).toEqual([first])
})

test('only a pending question gets an answer or a failure, and a refused one changes nothing', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const pending = ask(store, 'What is left?')
  const answered = ask(store, 'Who reviews it?')
  store.transaction((transaction) => transaction.chat.answer(run, answered.id, answer()))
  const head = store.changes.head()
  const missing = /is missing or no longer pending/

  expect(() => store.transaction((transaction) => transaction.chat.answer(run, answered.id, answer()))).toThrow(missing)
  expect(() =>
    store.transaction((transaction) => transaction.chat.fail(run, answered.id, { error: 'late', answered_at: instant(40n) })),
  ).toThrow(missing)
  expect(() => store.transaction((transaction) => transaction.chat.answer(otherRun, pending.id, answer()))).toThrow(missing)
  expect(() =>
    store.transaction((transaction) => transaction.chat.answer(run, ChatMessageId.parse('99'), answer())),
  ).toThrow(missing)
  expect(() =>
    store.transaction((transaction) => transaction.chat.answer(run, pending.id, answer({ view_rule: ViewRuleId.parse('rule') }))),
  ).toThrow(/view rule rule is not a stored view rule id/)

  expect(store.changes.head()).toBe(head)
  expect(store.chat.message(run, pending.id)).toEqual(pending)
})

test('pruning a run removes its chat and keeps the chat of other runs', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const pruned = ask(store, 'What is left?')
  store.transaction((transaction) => transaction.chat.answer(run, pruned.id, answer()))
  const kept = ask(store, 'Why did it stop?', 2, otherRun)

  store.transaction((transaction) => {
    transaction.pruning.remove({ runs: [run], sessions: [], streams: [], records: [] })
  })

  expect(store.chat.messages(run)).toEqual([])
  expect(store.chat.messages(otherRun)).toEqual([kept])
  expect(store.chat.pending()).toEqual([kept])
})
