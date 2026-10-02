import { writeSync } from 'node:fs'
import { createCollector } from '@aang/collector'
import { Config } from '@aang/contract'
import { openStore } from '@aang/store'
import { startEngine } from './harness.ts'

const [, , home, spool, claude, codex, root, mode] = process.argv

if (home === undefined || spool === undefined || claude === undefined || codex === undefined || root === undefined) {
  throw new Error('usage: ingest-process <home> <spool> <claude> <codex> <root> [crash-after-<batch>]')
}

const crashAfter = mode?.startsWith('crash-after-') === true ? Number(mode.slice('crash-after-'.length)) : null

const store = openStore({ home })
const engine = startEngine(store, { roots: [root] })
const collector = createCollector({
  spool,
  runtimeRoots: { claude, codex },
  config: Config.parse({ collector: { spoolScanIntervalMs: 50, rootsScanIntervalMs: 50 } }),
})

let batches = 0
for await (const batch of collector.start(store.cursors.list())) {
  await engine.ingest(batch)
  batches += 1
  if (batches === crashAfter) {
    writeSync(1, 'committed\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  await collector.ack(batch)
  writeSync(1, `acknowledged ${String(batches)}\n`)
}
