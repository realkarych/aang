import { type CollectorBatch, EpochNs, type JsonValue, type Runtime } from '@aang/contract'
import { contentHash, objectId } from '@aang/contract/ids'
import { createEngine } from '@aang/engine'
import type { Store } from '@aang/store'
import { batchOf, hookBatch } from './batches.js'
import { adapters, sessionKey } from './harness.js'
import { claudeHook, codexHook } from './samples.js'

export const source = { session: 'state-session', cwd: '/workspace' }
export const epoch = 1_790_856_592_228_739_000n
export const at = (milliseconds: number): EpochNs => EpochNs.parse(epoch + BigInt(milliseconds) * 1_000_000n)
export const sessionId = (runtime: Runtime = 'claude') => objectId(sessionKey(runtime, source.session))

export const hook = (
  event: string,
  milliseconds: number,
  fields: Record<string, JsonValue> = {},
  runtime: Runtime = 'claude',
): CollectorBatch => hookBatch({
  runtime,
  file: `${event}-${String(milliseconds)}.evt`,
  arrival: milliseconds * 1_000_000,
  payload: (runtime === 'claude' ? claudeHook : codexHook)('SessionStart.startup.json', source, {
    hook_event_name: event,
    ...fields,
  }),
})

export const registry = (status: string, milliseconds: number, updated = milliseconds): CollectorBatch => {
  const payload = JSON.stringify({
    pid: 123,
    sessionId: source.session,
    cwd: source.cwd,
    status,
    waitingFor: status === 'waiting' ? 'permission prompt' : null,
    statusUpdatedAt: Number(at(updated) / 1_000_000n),
  })
  return batchOf({ records: [{
    runtime: 'claude',
    channel: 'registry',
    stream: null,
    hook: null,
    observed_at: at(milliseconds),
    position: { kind: 'file', path: '/claude/sessions/123.json', content_hash: contentHash(payload) },
    payload,
  }] })
}

export const clockedEngine = (store: Store, quietAfterMs = 300_000) => {
  let now = at(0)
  return {
    engine: createEngine({ store, adapters, watch: { all: true, roots: [] }, now: () => now, quietAfterMs }),
    advance: (milliseconds: number) => { now = at(milliseconds) },
  }
}
