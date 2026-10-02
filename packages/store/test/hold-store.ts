import { writeSync } from 'node:fs'
import { openStore, type Transaction } from '@aang/store'
import { mainStream, messageFact, normalizerVersion, transcriptCursor, transcriptRecord } from './records.ts'

const [, , home, mode] = process.argv

if (home === undefined) {
  throw new Error('usage: hold-store <home> <open|transaction|ingest>')
}

const store = openStore({ home })

const announceReady = (): void => {
  writeSync(1, 'ready\n')
}

const blockForever = (): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

const ingestLine = (transaction: Transaction, line: number): void => {
  const { seq } = transaction.rawRecords.insert(transcriptRecord(line))
  transaction.facts.insert(seq, normalizerVersion, [messageFact(`m${String(line)}`, `line ${String(line)}`)])
  transaction.cursors.save(transcriptCursor(line))
}

if (mode === 'transaction') {
  store.transaction((transaction) => transaction.nextChangeSeq())
  store.transaction((transaction) => {
    transaction.nextChangeSeq()
    transaction.nextChangeSeq()
    announceReady()
    blockForever()
  })
} else if (mode === 'ingest') {
  store.transaction((transaction) => {
    transaction.scopes.decide({ stream: mainStream, runtime: 'claude', scope: 'watched' })
    ingestLine(transaction, 1)
  })
  store.transaction((transaction) => {
    ingestLine(transaction, 2)
    announceReady()
    blockForever()
  })
} else {
  announceReady()
  setInterval(() => store, 60_000)
}
