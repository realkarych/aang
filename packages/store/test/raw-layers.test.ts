import { ChangeSeq, FactId, RawSeq, type SessionKey, StreamKey } from '@aang/contract'
import { factIds } from '@aang/contract/ids'
import { MissingRawRecordError, type Store, type Transaction } from '@aang/store'
import { expect, test } from 'vitest'
import { createHome } from './home.js'
import {
  hookRecord,
  mainStream,
  messageFact,
  normalizerVersion,
  permissionFact,
  registryFact,
  snapshotRecord,
  sourceLostGap,
  subagentStream,
  transcriptCursor,
  transcriptRecord,
} from './records.js'

const start = ChangeSeq.parse(0)

const ingestLine = (transaction: Transaction, line: number): void => {
  const { seq } = transaction.rawRecords.insert(transcriptRecord(line))
  transaction.facts.insert(seq, normalizerVersion, [messageFact(`m${String(line)}`, `line ${String(line)}`)])
  transaction.cursors.save(transcriptCursor(line))
}

const describeLayers = (store: Store): unknown => ({
  head: store.changes.head(),
  changes: store.changes
    .after(start, 1000)
    .map((change) => [
      change.change_seq,
      change.layer,
      change.layer === 'raw_record' ? change.record.dedupe_key : null,
    ]),
  cursors: store.cursors.list(),
  scope: store.scopes.get(mainStream),
})

test('raw records of every channel are read back exactly as they were inserted', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const drafts = [transcriptRecord(1), hookRecord('1759370000123-4242-a1.evt'), snapshotRecord('run-1:turn-3')]

  const results = store.transaction((transaction) => drafts.map((draft) => transaction.rawRecords.insert(draft)))
  store.close()
  const reopened = home.open()

  expect(results).toEqual([
    { status: 'inserted', seq: 1 },
    { status: 'inserted', seq: 2 },
    { status: 'inserted', seq: 3 },
  ])
  expect(results.map(({ seq }) => reopened.rawRecords.get(seq))).toEqual(
    drafts.map((draft, index) => ({ seq: index + 1, ...draft })),
  )
  expect(reopened.rawRecords.get(RawSeq.parse(4))).toBeNull()
})

test('inserting a raw record with a known dedupe key reports a duplicate and stores nothing', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  store.transaction((transaction) => transaction.rawRecords.insert(transcriptRecord(1)))

  const sameTransaction = store.transaction((transaction) => [
    transaction.rawRecords.insert(transcriptRecord(2)),
    transaction.rawRecords.insert(transcriptRecord(2, { payload: '{"uuid":"u2","type":"user"}' })),
  ])
  const laterTransaction = store.transaction((transaction) =>
    transaction.rawRecords.insert(transcriptRecord(1, { payload: '{}' })),
  )
  store.close()
  const reopened = home.open()
  const afterRestart = reopened.transaction((transaction) => transaction.rawRecords.insert(transcriptRecord(1)))

  expect(sameTransaction).toEqual([
    { status: 'inserted', seq: 2 },
    { status: 'duplicate', seq: 2 },
  ])
  expect(laterTransaction).toEqual({ status: 'duplicate', seq: 1 })
  expect(afterRestart).toEqual({ status: 'duplicate', seq: 1 })
  expect(describeLayers(reopened)).toEqual({
    head: 2,
    changes: [
      [1, 'raw_record', 'claude:s1:u1'],
      [2, 'raw_record', 'claude:s1:u2'],
    ],
    cursors: [],
    scope: null,
  })
  expect(reopened.rawRecords.get(RawSeq.parse(1))).toEqual({ seq: 1, ...transcriptRecord(1) })
  expect(reopened.rawRecords.get(RawSeq.parse(2))).toEqual({ seq: 2, ...transcriptRecord(2) })
})

test('facts of a raw record get deterministic ids and are read back in their order', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const first = transcriptRecord(1)
  const drafts = [
    messageFact('m1', 'part one'),
    permissionFact('call-1'),
    messageFact('m1', 'part two'),
    registryFact(),
  ]
  const later = [messageFact('m1', 'part three')]

  const inserted = store.transaction((transaction) => {
    const { seq } = transaction.rawRecords.insert(first)
    const facts = transaction.facts.insert(seq, normalizerVersion, drafts)
    transaction.rawRecords.insert(hookRecord('1759370000123-4242-a1.evt'))
    const { seq: laterSeq } = transaction.rawRecords.insert(transcriptRecord(2))
    return [...facts, ...transaction.facts.insert(laterSeq, normalizerVersion, later)]
  })
  store.close()
  const reopened = home.open()

  const ids = [...factIds(first.dedupe_key, drafts), ...factIds(transcriptRecord(2).dedupe_key, later)]
  const expected = [
    ...drafts.map((draft) => ({ ...draft, seq: 1 })),
    ...later.map((draft) => ({ ...draft, seq: 3 })),
  ].map((fact, index) => ({ ...fact, id: ids[index], normalizer_version: normalizerVersion }))
  expect(new Set(ids).size).toBe(ids.length)
  expect(inserted).toEqual(expected)
  expect(reopened.facts.ofRecord(RawSeq.parse(1))).toEqual(expected.slice(0, 4))
  expect(reopened.facts.ofRecord(RawSeq.parse(3))).toEqual(expected.slice(4))
  expect(reopened.facts.ofEntity({ kind: 'message', runtime: 'claude', session: 's1', message: 'm1' })).toEqual([
    expected[0],
    expected[2],
    expected[4],
  ])
  expect(reopened.facts.ofEntity({ kind: 'session', runtime: 'claude', session: 's1' })).toEqual([expected[3]])
  expect(inserted.map(({ id }) => reopened.facts.get(id))).toEqual(expected)
  expect(reopened.facts.get(FactId.parse('0'.repeat(32)))).toBeNull()
  expect(reopened.facts.ofRecord(RawSeq.parse(2))).toEqual([])
})

test('facts cannot be stored for a raw record that does not exist', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()

  expect(() =>
    store.transaction((transaction) =>
      transaction.facts.insert(RawSeq.parse(7), normalizerVersion, [messageFact('m1', 'orphan')]),
    ),
  ).toThrow(MissingRawRecordError)
  expect(store.changes.head()).toBe(0)
})

test('a stream scope decision is stored and can be changed', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()

  store.transaction((transaction) => {
    transaction.scopes.decide({ stream: mainStream, runtime: 'claude', scope: 'external' })
    transaction.scopes.decide({ stream: subagentStream, runtime: 'claude', scope: 'observer' })
  })
  const external = store.scopes.get(mainStream)
  store.transaction((transaction) => {
    transaction.scopes.decide({ stream: mainStream, runtime: 'claude', scope: 'watched' })
  })
  store.close()
  const reopened = home.open()

  expect(external).toEqual({ stream: mainStream, runtime: 'claude', scope: 'external' })
  expect(reopened.scopes.get(mainStream)).toEqual({ stream: mainStream, runtime: 'claude', scope: 'watched' })
  expect(reopened.scopes.get(subagentStream)).toEqual({ stream: subagentStream, runtime: 'claude', scope: 'observer' })
  expect(reopened.scopes.get(StreamKey.parse('codex:t1'))).toBeNull()
  expect(reopened.changes.head()).toBe(0)
})

test('a root session scope decision is stored per runtime and can be changed', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const claudeSession: SessionKey = { kind: 'session', runtime: 'claude', session: 's1' }
  const codexSession: SessionKey = { kind: 'session', runtime: 'codex', session: 's1' }

  store.transaction((transaction) => {
    transaction.scopes.decideSession({ session: claudeSession, scope: 'external' })
    transaction.scopes.decideSession({ session: codexSession, scope: 'observer' })
  })
  const external = store.scopes.ofSession(claudeSession)
  store.transaction((transaction) => {
    transaction.scopes.decideSession({ session: claudeSession, scope: 'watched' })
  })
  store.close()
  const reopened = home.open()

  expect(external).toEqual({ session: claudeSession, scope: 'external' })
  expect(reopened.scopes.ofSession(claudeSession)).toEqual({ session: claudeSession, scope: 'watched' })
  expect(reopened.scopes.ofSession(codexSession)).toEqual({ session: codexSession, scope: 'observer' })
  expect(reopened.scopes.ofSession({ kind: 'session', runtime: 'claude', session: 's2' })).toBeNull()
  expect(reopened.scopes.get(mainStream)).toBeNull()
  expect(reopened.changes.head()).toBe(0)
})

test('a root session scope decision is rolled back with its transaction', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const session: SessionKey = { kind: 'session', runtime: 'claude', session: 's1' }

  expect(() => {
    store.transaction((transaction) => {
      transaction.scopes.decideSession({ session, scope: 'watched' })
      throw new Error('interrupted')
    })
  }).toThrow('interrupted')

  expect(store.scopes.ofSession(session)).toBeNull()
})

test('file cursors are stored by path, replaced on save and survive a restart', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const largestFileId = 18_446_744_073_709_551_615n
  const rollout = transcriptCursor(40, {
    path: '/home/u/.codex/sessions/2026/10/02/rollout-t1.jsonl',
    stream: StreamKey.parse('codex:t1'),
    dev: largestFileId,
    ino: largestFileId,
    last_ordinal: 39,
  })
  const pending = transcriptCursor(0, { path: '/home/u/.claude/projects/p/s2.jsonl', stream: null, size: 0 })

  store.transaction((transaction) => {
    transaction.scopes.decide({ stream: mainStream, runtime: 'claude', scope: 'watched' })
    transaction.scopes.decide({ stream: StreamKey.parse('codex:t1'), runtime: 'codex', scope: 'watched' })
    transaction.cursors.save(transcriptCursor(1))
    transaction.cursors.save(rollout)
    transaction.cursors.save(pending)
  })
  store.transaction((transaction) => {
    transaction.cursors.save(transcriptCursor(5))
  })
  store.close()
  const reopened = home.open()

  expect(reopened.cursors.list()).toEqual([transcriptCursor(5), pending, rollout])
  expect(reopened.changes.head()).toBe(0)
})

test('a cursor of a stream cannot be saved before the scope of the stream is decided', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()

  expect(() => {
    store.transaction((transaction) => {
      transaction.cursors.save(transcriptCursor(1))
    })
  }).toThrow(/FOREIGN KEY constraint failed/)
  expect(store.cursors.list()).toEqual([])
})

test('records, facts, scope and cursor of a batch are committed or rolled back together', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  store.transaction((transaction) => {
    transaction.scopes.decide({ stream: mainStream, runtime: 'claude', scope: 'watched' })
    ingestLine(transaction, 1)
  })
  const committed = describeLayers(store)

  expect(() =>
    store.transaction((transaction) => {
      transaction.scopes.decide({ stream: mainStream, runtime: 'claude', scope: 'external' })
      ingestLine(transaction, 2)
      transaction.gaps.save(sourceLostGap())
      throw new Error('adapter failed')
    }),
  ).toThrow('adapter failed')

  expect(describeLayers(store)).toEqual(committed)
  expect(committed).toEqual({
    head: 2,
    changes: [
      [1, 'raw_record', 'claude:s1:u1'],
      [2, 'fact', null],
    ],
    cursors: [transcriptCursor(1)],
    scope: { stream: mainStream, runtime: 'claude', scope: 'watched' },
  })
  expect(store.transaction((transaction) => transaction.rawRecords.insert(transcriptRecord(2)))).toEqual({
    status: 'inserted',
    seq: 2,
  })
})

test('a writer killed inside an ingest transaction leaves only the batches it committed', async ({
  onTestFinished,
}) => {
  const home = await createHome(onTestFinished)
  const holder = await home.hold('ingest')

  await holder.kill()
  const store = home.open()

  expect(describeLayers(store)).toEqual({
    head: 2,
    changes: [
      [1, 'raw_record', 'claude:s1:u1'],
      [2, 'fact', null],
    ],
    cursors: [transcriptCursor(1)],
    scope: { stream: mainStream, runtime: 'claude', scope: 'watched' },
  })
})

test('a finished transaction refuses every write', async ({ onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const finished = store.transaction((transaction) => {
    transaction.scopes.decide({ stream: mainStream, runtime: 'claude', scope: 'watched' })
    transaction.rawRecords.insert(transcriptRecord(1))
    return transaction
  })

  const writes = [
    () => finished.rawRecords.insert(transcriptRecord(1)),
    () => finished.rawRecords.insert(transcriptRecord(2)),
    () => finished.facts.insert(RawSeq.parse(1), normalizerVersion, [messageFact('m1', 'late')]),
    () => {
      finished.scopes.decide({ stream: mainStream, runtime: 'claude', scope: 'external' })
    },
    () => {
      finished.scopes.decideSession({
        session: { kind: 'session', runtime: 'claude', session: 's1' },
        scope: 'external',
      })
    },
    () => {
      finished.cursors.save(transcriptCursor(1))
    },
    () => finished.gaps.save(sourceLostGap()),
  ]

  for (const write of writes) {
    expect(write).toThrow('transaction has already finished')
  }
  expect(describeLayers(store)).toEqual({
    head: 1,
    changes: [[1, 'raw_record', 'claude:s1:u1']],
    cursors: [],
    scope: { stream: mainStream, runtime: 'claude', scope: 'watched' },
  })
  expect(store.scopes.ofSession({ kind: 'session', runtime: 'claude', session: 's1' })).toBeNull()
})
