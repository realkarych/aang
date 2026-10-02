import { codexAdapter } from '@aang/adapter-codex'
import type { FactDraft } from '@aang/contract'
import { expect, test } from 'vitest'
import {
  archivedPath,
  factsOf,
  realRollout,
  realThread,
  record,
  rolloutLines,
  sampleLine,
  sessionsPath,
  streamFrom,
} from './rollout-records.js'

const firstTurn = '01a0f752-4102-7740-9432-0533263c2dc1'
const resumedTurn = '01a0f755-c3a7-75a1-acf1-7d0839bc2d5c'
const codeCell = 'call_MxHF39QIUjLqImvlqfhdfE2y'
const nestedCommand = 'exec-a8b47079-66cf-4c58-ba7c-268717fda6fb'

const readRollout = (path: string) => {
  const lines = rolloutLines(realRollout)
  const stream = codexAdapter.streamKey(lines.slice(0, 3))
  let offset = 0
  return lines.map((payload, index) => {
    const collected = record(payload, stream, { position: { kind: 'line', path, offset, line: index + 1 } })
    offset += Buffer.byteLength(payload) + 1
    return collected
  })
}

const describeFact = (fact: FactDraft): string => {
  switch (fact.kind) {
    case 'session_start':
      return `${fact.payload.launch} in ${String(fact.payload.cwd)}`
    case 'turn_end':
      return `${fact.payload.outcome}: ${String(fact.payload.final_message)}`
    case 'turn_settings':
      return `${String(fact.payload.model)} ${String(fact.payload.approval_policy)} ${String(fact.payload.sandbox)}`
    case 'prompt':
    case 'message':
      return fact.payload.text
    case 'action_start':
      return `${fact.payload.action_kind} ${fact.entity_key.kind === 'action' ? fact.entity_key.call : ''}`
    case 'action_end':
      return `${fact.payload.outcome} ${fact.entity_key.kind === 'action' ? fact.entity_key.call : ''}`
    case 'compaction':
      return fact.payload.phase
    default:
      return ''
  }
}

test('the real exec rollout with resume and compaction is keyed by thread and ordinal and has no invalid lines', () => {
  const records = readRollout(sessionsPath)

  expect(records[0]?.stream).toBe(`codex:${realThread}:${realThread}`)
  expect(records.map((collected) => codexAdapter.rawKey(collected))).toEqual(
    records.map((_, ordinal) => `codex:${realThread}:${String(ordinal)}`),
  )
  const states = records.map((collected) => codexAdapter.parse(collected).parse_state)
  expect(states).not.toContain('invalid')
  expect(states.flatMap((state, ordinal) => (state === 'unknown' ? [ordinal] : []))).toEqual([
    6, 11, 14, 17, 18, 20, 21, 23, 24, 25, 26, 32, 38, 39,
  ])
})

test('the real rollout yields the session, both turns, the code-mode cell and its nested command', () => {
  const facts = readRollout(sessionsPath).flatMap((collected) => {
    const result = codexAdapter.parse(collected)
    return result.parse_state === 'parsed' ? factsOf(result) : []
  })

  expect(
    facts.map((fact) => [fact.runtime_ids.ordinal, fact.kind, fact.runtime_ids.turn_id, describeFact(fact)]),
  ).toEqual([
    [0, 'session_start', null, 'startup in /tmp/aang-spike/codex-cli/run1'],
    [1, 'turn_start', firstTurn, ''],
    [7, 'turn_settings', firstTurn, 'gpt-6.1-sol never read-only'],
    [9, 'prompt', firstTurn, 'Run the shell command `echo hi` exactly once, then reply with just: OK'],
    [10, 'action_start', firstTurn, `code_cell ${codeCell}`],
    [12, 'action_start', firstTurn, `command ${nestedCommand}`],
    [12, 'action_end', firstTurn, `ok ${nestedCommand}`],
    [13, 'action_end', firstTurn, `unknown ${codeCell}`],
    [15, 'message', firstTurn, 'OK'],
    [19, 'turn_end', firstTurn, 'completed: OK'],
    [22, 'turn_start', resumedTurn, ''],
    [27, 'compaction', resumedTurn, 'started'],
    [27, 'compaction', resumedTurn, 'completed'],
    [33, 'turn_settings', resumedTurn, 'gpt-6.1-sol never read-only'],
    [35, 'prompt', resumedTurn, 'Reply with just: OK2'],
    [36, 'message', resumedTurn, 'OK2'],
    [40, 'turn_end', resumedTurn, 'completed: OK2'],
  ])
  expect(new Set(facts.map((fact) => fact.entity_key.session))).toEqual(new Set([realThread]))
  expect(facts.filter((fact) => fact.urgent).map((fact) => [fact.runtime_ids.ordinal, fact.kind])).toEqual([
    [15, 'message'],
    [19, 'turn_end'],
    [27, 'compaction'],
    [27, 'compaction'],
    [36, 'message'],
    [40, 'turn_end'],
  ])
  expect(facts.every((fact) => fact.format_verified)).toBe(true)
})

test('an archived rollout re-read from another path yields the same keys and facts', () => {
  const live = readRollout(sessionsPath)
  const archived = readRollout(archivedPath)

  expect(archived.map((collected) => codexAdapter.rawKey(collected))).toEqual(
    live.map((collected) => codexAdapter.rawKey(collected)),
  )
  expect(archived.map((collected) => codexAdapter.parse(collected))).toEqual(
    live.map((collected) => codexAdapter.parse(collected)),
  )
})

test('the stream of a sub-agent rollout names its root session and its own thread', () => {
  expect(streamFrom(sampleLine('session_meta.subagent.thread_spawn.mock.json'))).toBe(
    'codex:01a0f75c-465e-7a01-876f-c7df6fc989a0:01a0f75c-46d2-7430-92a2-c3b0cd5d85b6',
  )
  expect(streamFrom(sampleLine('session_meta.guardian.mock.json'))).toBe(
    'codex:01a0f75b-8043-70d2-95ed-39bd0831b81a:01a0f75b-8064-73c2-8b8a-ba66c5467425',
  )
})

test('a file that does not open with session_meta has no stream', () => {
  const lines = rolloutLines(realRollout)

  expect(codexAdapter.streamKey([])).toBeNull()
  expect(codexAdapter.streamKey(lines.slice(1))).toBeNull()
  expect(codexAdapter.streamKey(['{"timestamp": "2026-10-01T11:55:58.087Z", "ordinal": 0'])).toBeNull()
  expect(codexAdapter.streamKey([lines[0]?.replace('"id": "01a0f752', '"id": "01:a0f752') ?? ''])).toBeNull()
})
