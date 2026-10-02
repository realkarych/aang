import { writeSync } from 'node:fs'
import { openStore } from '@aang/store'
import { batchOf } from './batches.ts'
import { startEngine } from './harness.ts'
import { decisionRecord } from './otel-records.ts'

const home = process.argv[2]
if (home === undefined) {
  throw new Error('missing store home')
}
const store = openStore({ home })
await startEngine(store, { all: true }).ingest(batchOf({ records: [decisionRecord()] }))
writeSync(1, 'committed\n')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
