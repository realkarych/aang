import { writeSync } from 'node:fs'
import { openStore } from '@aang/store'

const [, , home, mode] = process.argv

if (home === undefined) {
  throw new Error('usage: hold-store <home> <open|transaction>')
}

const store = openStore({ home })

const announceReady = (): void => {
  writeSync(1, 'ready\n')
}

if (mode === 'transaction') {
  store.transaction((transaction) => transaction.nextChangeSeq())
  store.transaction((transaction) => {
    transaction.nextChangeSeq()
    transaction.nextChangeSeq()
    announceReady()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  })
} else {
  announceReady()
  setInterval(() => store, 60_000)
}
