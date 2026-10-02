import { writeSync } from 'node:fs'
import { applyChangeSet, type ChangeSet } from '@aang/engine'
import { openStore, type Transaction } from '@aang/store'
import { history } from './model.ts'

const [, , home] = process.argv

if (home === undefined) {
  throw new Error('usage: model-writer <home>')
}

const store = openStore({ home })

const applyStep = (transaction: Transaction, step: readonly ChangeSet[]): void => {
  for (const changeSet of step) {
    applyChangeSet(transaction, changeSet)
  }
}

const steps = history()
const interrupted = steps.pop() ?? []

for (const step of steps) {
  store.transaction((transaction) => {
    applyStep(transaction, step)
  })
}

store.transaction((transaction) => {
  applyStep(transaction, interrupted)
  writeSync(1, 'ready\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
})
