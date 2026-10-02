import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import { CollectedRecord, type CollectorBatch } from '@aang/contract'
import { createEngine } from '@aang/engine'
import { openStore } from '@aang/store'

const hook = (session: string, padding: string, start = false): CollectedRecord =>
  CollectedRecord.parse({
    runtime: 'claude',
    channel: 'hook',
    stream: null,
    position: { kind: 'spool', file: `${session}.evt` },
    observed_at: BigInt(Date.now()) * 1_000_000n,
    hook: { registration: 'plugin', env: {} },
    payload: JSON.stringify({
      hook_event_name: start ? 'SessionStart' : 'PreToolUse',
      source: 'startup',
      session_id: session,
      cwd: tmpdir(),
      padding,
    }),
  })

const gc = global.gc
assert.ok(gc)
for (const scenario of ['waiting hook', 'committed hook', 'deferred line']) {
  const home = await mkdtemp(join(tmpdir(), 'aang-memory-'))
  const store = openStore({ home })
  const engine = createEngine({
    store,
    adapters: new Map([
      ['claude', claudeAdapter],
      ['codex', codexAdapter],
    ]),
    watch: { all: true, roots: [] },
    holding: { totalBytes: 256 },
  })
  try {
    const deliver = async (): Promise<WeakRef<CollectedRecord>> => {
      const small = hook('small', '')
      const large = hook('large', 'x'.repeat(4 * 1024 ** 2), scenario === 'committed hook')
      let batch: CollectorBatch = { records: [small, large], cursors: [], gaps: [] }
      if (scenario === 'deferred line') {
        const payloads = [
          JSON.stringify({ type: 'queue-operation', sessionId: 'small' }),
          JSON.stringify({ type: 'queue-operation', sessionId: 'small', padding: 'x'.repeat(4 * 1024 ** 2) }),
        ]
        let offset = 0
        const records = payloads.map((payload, index): CollectedRecord => {
          const record: CollectedRecord = {
            ...small,
            channel: 'transcript',
            hook: null,
            payload,
            position: { kind: 'line', path: '/transcript.jsonl', line: index + 1, offset },
          }
          offset += Buffer.byteLength(payload) + 1
          return record
        })
        batch = {
          records,
          cursors: [{
            path: '/transcript.jsonl',
            dev: 1n,
            ino: 1n,
            stream: null,
            offset,
            line: 2,
            size: offset,
            last_ordinal: null,
          }],
          gaps: [],
        }
      }
      const dropped = batch.records[1]
      assert.ok(dropped)
      const ref = new WeakRef(dropped)
      const result = await engine.ingest(batch)
      assert.equal(result.waiting, scenario === 'deferred line' ? 1 : 0)
      assert.equal(result.deferred, scenario === 'waiting hook' ? 2 : 1)
      return ref
    }
    const dropped = await deliver()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await setImmediate()
      gc()
    }
    assert.equal(dropped.deref(), undefined, scenario)
    await engine.ingest({ records: [], cursors: [], gaps: [] })
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true, maxRetries: 5 })
  }
}
