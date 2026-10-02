import { createCollector } from '@aang/collector'
import { Config, type CollectorBatch } from '@aang/contract'

const [spool, claude, codex, mode] = process.argv.slice(2)
if (spool === undefined || claude === undefined || codex === undefined) {
  throw new Error('missing collector paths')
}
const collector = createCollector({
  spool,
  runtimeRoots: { claude, codex },
  adapters: new Map(),
  config: Config.parse({ collector: { fsWatch: false, rootsScanIntervalMs: 50, spoolScanIntervalMs: 50 } }),
})
const listener = await collector.listenOtel({ port: 0, token: 'reliability' })
process.send?.({ listener })
let first: CollectorBatch | undefined
let count = 0
process.on('message', (message) => {
  if (message === 'ack-first' && first !== undefined) {
    void collector.ack(first).then(() => process.send?.({ acknowledged: true }))
  }
})
for await (const batch of collector.start([])) {
  first ??= batch
  count += batch.records.length
  if (mode === 'drain') {
    await collector.ack(batch)
  }
  process.send?.({ count, gaps: batch.gaps.length, observedAt: String(batch.records[0]?.observed_at), bytes: batch.records.reduce((n, r) => n + Buffer.byteLength(r.payload), 0) })
}
