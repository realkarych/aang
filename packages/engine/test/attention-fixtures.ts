import { readFileSync } from 'node:fs'
import {
  type AttentionItem,
  EpochNs,
  type Fact,
  type JsonValue,
  type ModelChange,
  ModelVersion,
  type Question,
  type Runtime,
  type SessionKey,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, type Engine } from '@aang/engine'
import type { Store } from '@aang/store'
import type { TestContext } from 'vitest'
import { batchOf, type HookDelivery, jsonlFile } from './batches.js'
import { factsOf, recordsOf, sessionKey, startEngine } from './harness.js'
import { createHome, type Home } from './home.js'
import { decisionRecord } from './otel-records.js'
import { claudeHook, codexHook, codexRollout } from './samples.js'

export const cwd = '/work/attention'

export const command = { command: 'touch probe-perm.txt', description: 'Create empty probe file' }

export const millisecond = 1_000_000

export const linkRun = (store: Store, key: SessionKey): void => {
  const run = runId(key)
  const session = objectId(key)
  const created = EpochNs.parse(1n)
  store.transaction((transaction) =>
    applyChangeSet(transaction, {
      run,
      author: 'rule',
      at: created,
      changes: [
        {
          op: 'run.create',
          basis: { kind: 'observed' },
          evidence: [],
          put: {
            kind: 'run',
            value: {
              id: run,
              runtime: key.runtime,
              root_session: session,
              goal: null,
              brief: null,
              start_pruned: false,
              created_at: created,
            },
          },
        },
        {
          op: 'run.create',
          basis: { kind: 'observed' },
          evidence: [],
          put: { kind: 'session_membership', value: { session, run } },
        },
      ],
    }),
  )
}

export interface Observed {
  readonly home: Home
  readonly store: Store
  readonly key: SessionKey
  readonly engine: Engine
}

export const observeSession = async (
  onTestFinished: TestContext['onTestFinished'],
  runtime: Runtime,
  session: string,
): Promise<Observed> => {
  const home = await createHome(onTestFinished)
  const store = home.open()
  const key = sessionKey(runtime, session)
  linkRun(store, key)
  return { home, store, key, engine: startEngine(store, { all: true }) }
}

export const attentionOf = (store: Store, key: SessionKey): AttentionItem[] =>
  store.model.entities(runId(key)).flatMap((entity) => (entity.kind === 'attention_item' ? [entity.value] : []))

export const questionId = (key: SessionKey, question: string): Question['id'] =>
  objectId({ kind: 'question', runtime: key.runtime, session: key.session, question })

export const actionId = (key: SessionKey, call: string) =>
  objectId({ kind: 'action', runtime: key.runtime, session: key.session, call })

export const questionOf = (store: Store, key: SessionKey, question: string): Question => {
  const found = store.observations.getQuestion(questionId(key, question))
  if (found === null) {
    throw new Error(`missing question ${question}`)
  }
  return found
}

export const itemOf = (store: Store, key: SessionKey, question: string): AttentionItem => {
  const id = questionId(key, question)
  const found = attentionOf(store, key).find((item) => item.question === id)
  if (found === undefined) {
    throw new Error(`missing attention item for ${question}`)
  }
  return found
}

export const attentionChanges = (store: Store, key: SessionKey): ModelChange[] =>
  store.model
    .changes(runId(key), ModelVersion.parse(0))
    .filter(({ target }) => target.kind === 'attention_item')

export const factOf = (store: Store, file: string): Fact => {
  const raw = recordsOf(store).find(({ position }) => position.kind === 'spool' && position.file === file)
  const fact = raw === undefined ? undefined : factsOf(store).find(({ seq }) => seq === raw.seq)
  if (fact === undefined) {
    throw new Error(`missing fact of ${file}`)
  }
  return fact
}

export const claudeHooks = (session: string) => {
  const source = { session, cwd }
  const hook = (file: string, arrival: number, name: string, changes: Record<string, JsonValue> = {}): HookDelivery => ({
    file,
    arrival,
    payload: claudeHook(name, source, changes),
  })
  return {
    start: (arrival = 0) => hook('start.evt', arrival, 'SessionStart.startup.json'),
    pre: (
      file: string,
      call: string,
      arrival: number,
      input: JsonValue = command,
      tool = 'Bash',
      changes: Record<string, JsonValue> = {},
    ) => hook(file, arrival, 'PreToolUse.Bash.json', { tool_use_id: call, tool_name: tool, tool_input: input, ...changes }),
    request: (file: string, arrival: number, input: JsonValue = command, changes: Record<string, JsonValue> = {}) =>
      hook(file, arrival, 'PermissionRequest.Bash.json', { tool_input: input, ...changes }),
    post: (file: string, call: string, arrival: number, tool = 'Bash', response: JsonValue = 'done') =>
      hook(file, arrival, 'PostToolUse.Bash.json', { tool_use_id: call, tool_name: tool, tool_response: response }),
    denied: (file: string, call: string, arrival: number) =>
      hook(file, arrival, 'PostToolBatch.denied-by-human.json', {
        tool_calls: [
          { tool_name: 'Bash', tool_input: command, tool_use_id: call, tool_response: 'Denied by the human (aang probe).' },
        ],
      }),
    stop: (file: string, arrival: number) => hook(file, arrival, 'Stop.json'),
    end: (file: string, arrival: number) => hook(file, arrival, 'SessionEnd.json'),
    prompt: (file: string, arrival: number) =>
      hook(file, arrival, 'SessionStart.startup.json', { hook_event_name: 'UserPromptSubmit', prompt: 'Next task' }),
    notification: (file: string, arrival: number, type: string) =>
      hook(file, arrival, 'Notification.permission_prompt.json', { notification_type: type }),
    elicitation: (file: string, arrival: number, elicitation: string) =>
      hook(file, arrival, 'SessionStart.startup.json', {
        hook_event_name: 'Elicitation',
        mcp_server_name: 'tracker',
        message: 'Which ticket should be closed?',
        elicitation_id: elicitation,
      }),
    elicitationResult: (file: string, arrival: number, elicitation: string, action: string) =>
      hook(file, arrival, 'SessionStart.startup.json', {
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'tracker',
        elicitation_id: elicitation,
        action,
        content: action === 'accept' ? { ticket: 'AANG-6' } : null,
      }),
  }
}

export const codexHooks = (session: string) => {
  const source = { session, cwd }
  const request = JSON.parse(codexHook('PermissionRequest.json', source)) as { readonly tool_input: JsonValue }
  const hook = (file: string, arrival: number, name: string, changes: Record<string, JsonValue> = {}): HookDelivery => ({
    runtime: 'codex',
    registration: 'user',
    file,
    arrival,
    payload: codexHook(name, source, changes),
  })
  return {
    input: request.tool_input,
    start: (arrival = 0) => hook('start.evt', arrival, 'SessionStart.startup.json'),
    pre: (file: string, call: string, arrival: number) =>
      hook(file, arrival, 'PreToolUse.Bash.json', { tool_use_id: call, tool_input: request.tool_input }),
    request: (file: string, arrival: number) => hook(file, arrival, 'PermissionRequest.json'),
    post: (file: string, call: string, arrival: number) =>
      hook(file, arrival, 'PostToolUse.Bash.json', { tool_use_id: call, tool_input: request.tool_input }),
    interrupt: (file: string, arrival: number) => hook(file, arrival, 'Interrupt.json'),
    prompt: (file: string, arrival: number) => hook(file, arrival, 'UserPromptSubmit.json'),
    end: (file: string, arrival: number) => hook(file, arrival, 'SessionEnd.json'),
  }
}

type JsonObject = Record<string, JsonValue>

export const rolloutEvent = (name: string): JsonObject =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/research/samples/codex-cli/rollout/${name}`, import.meta.url), 'utf8'),
  ) as JsonObject

export const blockingQuestion = (): JsonObject => {
  const event = rolloutEvent('event_msg.item_completed.AgentMessage.question-async.mock.json')
  const payload = event['payload'] as JsonObject
  const item = Object.fromEntries(Object.entries(payload['item'] as JsonObject).filter(([name]) => name !== 'delivery'))
  return { ...event, payload: { ...payload, item } }
}

export const codexRolloutFile = (thread: string, events: readonly (string | JsonObject)[], ino: bigint) => {
  const meta = codexRollout({ thread, cwd })[0]
  if (meta === undefined) {
    throw new Error('missing session meta')
  }
  const lines = [
    meta,
    ...events.map((event, index) =>
      JSON.stringify({ ...(typeof event === 'string' ? rolloutEvent(event) : event), ordinal: index + 1 }),
    ),
  ]
  return jsonlFile({ runtime: 'codex', path: `/rollout-${thread}.jsonl`, lines, ino })
}

const otelArrival = 1_790_856_592_228_739_000n

export const otelDecision = (session: string, call: string, source: string, decision: string, arrival: number) => {
  const record = decisionRecord(session, { call_id: call, source, decision })
  const log = JSON.parse(record.payload) as Record<string, JsonValue>
  const at = (otelArrival + BigInt(arrival)).toString()
  return batchOf({
    records: [{ ...record, payload: JSON.stringify({ ...log, timeUnixNano: at, observedTimeUnixNano: at }) }],
  })
}
