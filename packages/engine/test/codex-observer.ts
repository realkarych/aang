import { readFileSync } from 'node:fs'
import { type Fact, type JsonValue, ObserverCallId } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, beginObserverCall } from '@aang/engine'
import type { TestContext } from 'vitest'
import { jsonlFile } from './batches.js'
import { factsOf, startEngine } from './harness.js'
import { createHome } from './home.js'
import { at, drafts, membership, observed, put, stages } from './model.js'
import { inputFor } from './observer-fixtures.js'
import { codexRollout } from './samples.js'

const thread = 'codex-observed-thread'
const sessionKey = { kind: 'session', runtime: 'codex', session: thread } as const

export const codexRun = runId(sessionKey)
export const codexSession = objectId(sessionKey)
export const codexCall = ObserverCallId.parse('codex-call')

const rolloutSample = (name: string): Record<string, JsonValue> =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/research/samples/codex-cli/rollout/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, JsonValue>

const itemLine = (name: string, ordinal: number, item: Record<string, JsonValue>): string => {
  const sample = rolloutSample(name)
  const payload = sample['payload'] as Record<string, JsonValue>
  return JSON.stringify({
    ...sample,
    ordinal,
    payload: { ...payload, thread_id: thread, item: { ...(payload['item'] as Record<string, JsonValue>), ...item } },
  })
}

export const asyncQuestionLine = (ordinal: number): string =>
  itemLine('event_msg.item_completed.AgentMessage.question-async.mock.json', ordinal, {})

export const userMessageLine = (ordinal: number, text: string): string =>
  itemLine('event_msg.item_completed.UserMessage.real.json', ordinal, {
    id: `user-message-${String(ordinal)}`,
    content: [{ type: 'text', text, text_elements: [] }],
  })

export const setupCodexObserver = async (onTestFinished: TestContext['onTestFinished'], extra: string[] = []) => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const lines = [...codexRollout({ thread, cwd: home.path }), ...extra]
  const file = jsonlFile({ runtime: 'codex', path: `${home.path}/rollout.jsonl`, lines, ino: 30n })
  await startEngine(store, { all: true }).ingest(file.batch(1, lines.length))
  store.transaction((transaction) => {
    applyChangeSet(transaction, {
      run: codexRun,
      author: 'rule',
      at: at(1),
      changes: [
        put(
          'run.create',
          { kind: 'run', value: { ...drafts.runA, id: codexRun, runtime: 'codex', root_session: codexSession } },
          observed,
          [],
        ),
        put('run.create', membership(codexSession, codexRun), observed, []),
      ],
    })
    const session = transaction.observations.getSession(codexSession)
    if (session === null) {
      throw new Error('the rollout must create a session observation')
    }
    transaction.observations.save({ ...session, run: codexRun })
    applyChangeSet(transaction, {
      run: codexRun,
      author: 'rule',
      at: at(2),
      changes: [put('stage.create', { kind: 'stage', value: { ...drafts.build, run: codexRun } }, observed, [])],
    })
  })
  const facts = factsOf(store)
  const begin = (batch: Fact[], id = codexCall) => {
    const generic = inputFor(store, batch, codexRun)
    const input = { ...generic, run: { ...generic.run, runtime: 'codex' as const } }
    store.transaction((transaction) => {
      beginObserverCall(transaction, { id, backend: 'codex', crossVendor: false, input, at: at(10) })
    })
    return input
  }
  const stage = () => store.model.entity(codexRun, { kind: 'stage', id: stages.build })
  return { home, store, facts, begin, stage }
}
