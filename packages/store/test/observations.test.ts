import { type AgentId, ChangeSeq, type ObservationRemoval } from '@aang/contract'
import type { Change, Store } from '@aang/store'
import { expect, test } from 'vitest'
import { createHome } from './home.js'
import { type AgentDraft, agentDraft, instant } from './records.js'

const provisional = agentDraft('subagent', { kind: 'subagent', agent_id: 'a7' })
const teammate = agentDraft(
  'teammate',
  { kind: 'teammate', name: 'worker', team: 'crew' },
  { execution: { state: 'done' }, ended_at: instant(900n) },
)
const corrected = agentDraft('teammate', { kind: 'teammate', name: 'worker', team: 'review' })

const replacing = (removed: AgentDraft, replacement: AgentDraft): ObservationRemoval => ({
  kind: 'agent',
  id: removed.id,
  replaced_by: replacement.id,
})

const removed = (agent: AgentDraft): { readonly kind: 'agent'; readonly id: AgentId } => ({
  kind: 'agent',
  id: agent.id,
})

const summarize = (changes: readonly Change[]): unknown[] =>
  changes.map((change) => {
    switch (change.layer) {
      case 'object':
        return [change.change_seq, change.layer, change.object.id]
      case 'removal':
        return [change.change_seq, change.layer, change.removal.id, change.removal.replaced_by]
      default:
        return [change.change_seq, change.layer]
    }
  })

const saveAll = (store: Store, ...agents: readonly AgentDraft[]): void => {
  store.transaction((transaction) => {
    for (const agent of agents) {
      transaction.observations.save(agent)
    }
  })
}

test('a provisional agent is retracted in favour of its refined identity and stays retracted after reopening', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  saveAll(store, provisional)
  const position = store.changes.head()

  const removal = store.transaction((transaction) => {
    transaction.observations.save(teammate)
    return transaction.observations.remove(replacing(provisional, teammate))
  })
  store.close()
  const reopened = home.open()

  expect(removal).toEqual({
    kind: 'agent',
    id: provisional.id,
    replaced_by: teammate.id,
    run: provisional.run,
    change_seq: 3,
  })
  expect(reopened.observations.getAgent(provisional.id)).toBeNull()
  expect(reopened.observations.agents(provisional.session)).toEqual([{ ...teammate, change_seq: 2 }])
  expect(reopened.observations.getRemoval(removed(provisional))).toEqual(removal)
  expect(reopened.observations.getRemoval(removed(teammate))).toBeNull()
  expect(summarize(reopened.changes.after(position, 100))).toEqual([
    [2, 'object', teammate.id],
    [3, 'removal', provisional.id, teammate.id],
  ])
})

test('repeating a removal or removing an agent that was never stored issues no change', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  saveAll(store, provisional, teammate)
  const removal = store.transaction((transaction) => transaction.observations.remove(replacing(provisional, teammate)))
  const head = store.changes.head()

  const repeated = store.transaction((transaction) => transaction.observations.remove(replacing(provisional, teammate)))
  const unknown = store.transaction((transaction) => transaction.observations.remove(replacing(corrected, teammate)))

  expect(repeated).toEqual(removal)
  expect(unknown).toBeNull()
  expect(store.observations.getRemoval(removed(corrected))).toBeNull()
  expect(store.changes.head()).toBe(head)
})

test('an agent is replaced only by another stored agent', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  saveAll(store, provisional)

  expect(() =>
    store.transaction((transaction) => transaction.observations.remove(replacing(provisional, teammate))),
  ).toThrow(`replacement agent ${teammate.id} is not stored`)
  expect(() =>
    store.transaction((transaction) => transaction.observations.remove(replacing(provisional, provisional))),
  ).toThrow('an observation cannot replace itself')
  expect(store.observations.getAgent(provisional.id)).toEqual({ ...provisional, change_seq: 1 })
  expect(store.observations.getRemoval(removed(provisional))).toBeNull()
  expect(store.changes.head()).toBe(1)
})

test('a removal is rolled back together with its ingest transaction', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  saveAll(store, provisional)

  expect(() =>
    store.transaction((transaction) => {
      transaction.observations.save(teammate)
      transaction.observations.remove(replacing(provisional, teammate))
      throw new Error('ingest failed')
    }),
  ).toThrow('ingest failed')

  expect(store.observations.agents(provisional.session)).toEqual([{ ...provisional, change_seq: 1 }])
  expect(store.observations.getRemoval(removed(provisional))).toBeNull()
  expect(summarize(store.changes.after(ChangeSeq.parse(0), 100))).toEqual([[1, 'object', provisional.id]])
})

test('retracting a replacement redirects earlier removals, so every removal names a stored agent', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  saveAll(store, provisional, teammate)
  store.transaction((transaction) => transaction.observations.remove(replacing(provisional, teammate)))
  const position = store.changes.head()

  const removal = store.transaction((transaction) => {
    transaction.observations.save(corrected)
    return transaction.observations.remove(replacing(teammate, corrected))
  })

  expect(removal).toEqual({ ...replacing(teammate, corrected), run: teammate.run, change_seq: 5 })
  expect(store.observations.getRemoval(removed(provisional))).toEqual({
    ...replacing(provisional, corrected),
    run: provisional.run,
    change_seq: 6,
  })
  expect(store.observations.agents(provisional.session)).toEqual([{ ...corrected, change_seq: 4 }])
  expect(summarize(store.changes.after(position, 100))).toEqual([
    [4, 'object', corrected.id],
    [5, 'removal', teammate.id, corrected.id],
    [6, 'removal', provisional.id, corrected.id],
  ])
})

test('a retracted agent is pointed at a corrected replacement as a new change', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  saveAll(store, provisional, teammate, corrected)
  store.transaction((transaction) => transaction.observations.remove(replacing(provisional, teammate)))

  const pointed = store.transaction((transaction) => transaction.observations.remove(replacing(provisional, corrected)))

  expect(pointed).toEqual({ ...replacing(provisional, corrected), run: provisional.run, change_seq: 5 })
  expect(store.observations.getRemoval(removed(provisional))).toEqual(pointed)
  expect(store.observations.getAgent(teammate.id)).toEqual({ ...teammate, change_seq: 2 })
  expect(summarize(store.changes.after(ChangeSeq.parse(3), 100))).toEqual([
    [5, 'removal', provisional.id, corrected.id],
  ])
})

test('saving a retracted agent again restores it and withdraws its removal', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  saveAll(store, provisional, teammate)
  store.transaction((transaction) => transaction.observations.remove(replacing(provisional, teammate)))

  const restored = store.transaction((transaction) => transaction.observations.save(provisional))

  expect(restored).toEqual({ ...provisional, change_seq: 4 })
  expect(store.observations.getRemoval(removed(provisional))).toBeNull()
  expect(store.observations.agents(provisional.session)).toEqual([
    { ...provisional, change_seq: 4 },
    { ...teammate, change_seq: 2 },
  ])
  expect(summarize(store.changes.after(ChangeSeq.parse(2), 100))).toEqual([[4, 'object', provisional.id]])
})

test('paging through the change feed returns every object and removal exactly once', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  saveAll(store, provisional, teammate)
  store.transaction((transaction) => {
    transaction.observations.save(corrected)
    transaction.observations.remove(replacing(provisional, teammate))
    transaction.observations.remove(replacing(teammate, corrected))
  })
  const pages: Change[][] = []

  let position = ChangeSeq.parse(0)
  for (;;) {
    const page = store.changes.after(position, 2)
    if (page.length === 0) {
      break
    }
    pages.push(page)
    position = page.at(-1)?.change_seq ?? position
  }

  expect(summarize(pages.flat())).toEqual([
    [3, 'object', corrected.id],
    [5, 'removal', teammate.id, corrected.id],
    [6, 'removal', provisional.id, corrected.id],
  ])
  expect(pages.flat()).toEqual(store.changes.after(ChangeSeq.parse(0), 100))
})
