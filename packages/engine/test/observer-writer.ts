import { writeSync } from 'node:fs'
import { EpochNs, ObserverCallId, ObserverInput } from '@aang/contract'
import { applyObserverResponse, beginObserverCall } from '@aang/engine'
import { openStore } from '@aang/store'

const [, , home, phase] = process.argv
if (home === undefined || phase === undefined) {
  throw new Error('usage: observer-writer <home> <phase>')
}
const store = openStore({ home })
const input = ObserverInput.parse(store.settings.get('observer-test-input'))
const call = ObserverCallId.parse('crash-call')
store.transaction((transaction) => {
  beginObserverCall(transaction, { id: call, backend: 'claude', crossVendor: false, input, at: EpochNs.parse(1_759_370_010_000_000_000n) })
})
const hold = (): void => {
  writeSync(1, 'ready\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
if (phase === 'started') {
  hold()
} else {
  store.transaction((transaction) => {
    applyObserverResponse(transaction, {
      call,
      output: {
        base_version: input.model.version,
        needs: [],
        ops: [
          {
            op: 'brief.update',
            text: 'Committed observer interpretation',
            evidence: input.batch.facts.map(({ id }) => id),
            rationale: 'Summary',
          },
        ],
      },
      at: EpochNs.parse(1_759_370_020_000_000_000n),
    })
    if (phase === 'applying') {
      hold()
    }
  })
  hold()
}
