import { readFileSync } from 'node:fs'
import { codexAdapter } from '@aang/adapter-codex'
import {
  type CollectedPosition,
  CollectedRecord,
  type DecisionSource,
  EpochNs,
  type PermissionDecision,
  type Speaker,
  StreamKey,
} from '@aang/contract'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { factsOf, threadStream } from './rollout-records.js'

const otelSamples = new URL('../../../docs/research/samples/codex-otel/', import.meta.url)
const receivedAt = EpochNs.parse(1_790_860_423_509_072_000n)

const LogRecord = z.looseObject({
  observedTimeUnixNano: z.string(),
  attributes: z.array(z.looseObject({ key: z.string(), value: z.looseObject({ stringValue: z.string().optional() }) })),
})
type LogRecord = z.infer<typeof LogRecord>

const Variant = z.looseObject({ _case: z.string(), logRecord: LogRecord.optional() })

const OtherEvent = z.looseObject({ _event: z.string(), logRecord: LogRecord })

const Envelope = z.looseObject({
  resourceLogs: z.array(z.looseObject({ scopeLogs: z.array(z.looseObject({ logRecords: z.array(LogRecord) })) })),
})

const sampleLines = (name: string): unknown[] =>
  readFileSync(new URL(name, otelSamples), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line))

const variants = sampleLines('logs.tool_decision.variants.jsonl').map((line) => Variant.parse(line))

const variantRecord = (name: string): LogRecord => {
  const log = variants.find((variant) => variant._case === name)?.logRecord
  if (log === undefined) {
    throw new Error(`no log record for ${name}`)
  }
  return log
}

const attribute = (log: LogRecord, key: string): string => {
  const value = log.attributes.find((entry) => entry.key === key)?.value.stringValue
  if (value === undefined) {
    throw new Error(`no attribute ${key}`)
  }
  return value
}

const otelRecord = (
  payload: string,
  stream: StreamKey | null,
  position: CollectedPosition = { kind: 'otel' },
): CollectedRecord =>
  CollectedRecord.parse({
    channel: 'otel',
    runtime: 'codex',
    stream,
    position,
    hook: null,
    observed_at: receivedAt,
    payload,
  })

const parseLog = (log: unknown, stream: StreamKey | null) => codexAdapter.parse(otelRecord(JSON.stringify(log), stream))

const keyOf = (log: unknown, stream: StreamKey | null = null) =>
  codexAdapter.rawKey(otelRecord(JSON.stringify(log), stream))

const withAttributes = (log: LogRecord, changes: Record<string, string | undefined>): LogRecord => ({
  ...log,
  attributes: [
    ...log.attributes.filter((entry) => !(entry.key in changes)),
    ...Object.entries(changes).flatMap(([key, value]) =>
      value === undefined ? [] : [{ key, value: { stringValue: value } }],
    ),
  ],
})

interface Decision {
  readonly decision: PermissionDecision
  readonly source: DecisionSource
  readonly speaker: Speaker
  readonly tool: string
  readonly originator: string
  readonly root?: string
}

const human = (decision: PermissionDecision, originator: string, tool = 'exec_command'): Decision => ({
  decision,
  source: 'user',
  speaker: 'human',
  tool,
  originator,
})

const policy = (originator: string): Decision => ({
  decision: 'approved',
  source: 'config',
  speaker: 'runtime',
  tool: 'exec_command',
  originator,
})

const probe = 'aang_otel_probe'
const execSubagentRoot = '01a0f7a9-0000-7000-8000-0000000000a1'

const decisions: Readonly<Record<string, Decision>> = {
  'app-server accept': human('approved', probe),
  'app-server decline': human('denied', probe),
  'app-server acceptForSession': human('approved_for_session', probe),
  'app-server echo hi under on-request (safe command, no prompt)': policy(probe),
  'app-server apply_patch accept': human('approved', probe, 'apply_patch'),
  'app-server untrusted policy, echo hi accept': human('approved', probe),
  'TUI --no-daemon key y': human('approved', 'codex-tui'),
  'TUI --no-daemon key p (prefix rule)': human('approved_with_amendment', 'codex-tui'),
  'TUI --no-daemon after prefix rule saved': policy('codex-tui'),
  'TUI --no-daemon apply_patch key y': human('approved', 'codex-tui', 'apply_patch'),
  'TUI on managed daemon key y': human('approved', 'codex-tui'),
  'codex exec (approval never) echo hi': policy('codex_exec'),
  'codex exec --approve-for-me (guardian)': {
    decision: 'denied',
    source: 'automated_reviewer',
    speaker: 'runtime',
    tool: 'exec_command',
    originator: 'codex_exec',
  },
  'Codex SDK 0.159.3 (approval never) echo hi': policy('codex_sdk_ts'),
  'codex exec subagent thread': { ...policy('codex_exec'), root: execSubagentRoot },
}

describe('every recorded codex.tool_decision variant', () => {
  test('has an expectation, and the cases without a log record are the documented silent ones', () => {
    expect(
      variants
        .filter((variant) => variant.logRecord !== undefined)
        .map((variant) => variant._case)
        .sort(),
    ).toEqual(Object.keys(decisions).sort())
    expect(variants.filter((variant) => variant.logRecord === undefined)).toHaveLength(3)
  })

  test.each(Object.entries(decisions))('%s', (name, expected) => {
    const log = variantRecord(name)
    const conversation = attribute(log, 'conversation.id')
    const call = attribute(log, 'call_id')
    const root = expected.root ?? conversation
    const at = EpochNs.parse(log.observedTimeUnixNano)
    const result = parseLog(log, threadStream(root, conversation))

    expect(result).toMatchObject({ parse_state: 'parsed', source_ts: at })
    expect(factsOf(result)).toEqual([
      {
        kind: 'permission_decision',
        entity_key: { kind: 'action', runtime: 'codex', session: root, call },
        speaker: expected.speaker,
        urgent: false,
        at,
        runtime_ids: {
          session_id: root,
          agent_id: null,
          thread_id: conversation,
          turn_id: null,
          prompt_id: null,
          record_uuid: null,
          parent_uuid: null,
          message_id: null,
          call_id: call,
          ordinal: null,
        },
        runtime_env: {
          cwd: null,
          version: attribute(log, 'app.version'),
          entrypoint: null,
          originator: expected.originator,
          git_branch: null,
        },
        format_verified: true,
        redelivery_key: null,
        payload: { decision: expected.decision, source: expected.source, tool: expected.tool },
      },
    ])
    expect(keyOf(log)).toBe(`codex:otel:${conversation}:${call}:${attribute(log, 'decision')}:0`)
  })

  test('yields one distinct raw key per decision', () => {
    const keys = Object.keys(decisions).map((name) => keyOf(variantRecord(name)))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

test('the log record inside a full OTLP request is the same decision as the recorded variant', () => {
  const envelope = Envelope.parse(
    JSON.parse(readFileSync(new URL('logs.envelope.tool_decision.approved-user.app-server.json', otelSamples), 'utf8')),
  )
  const [log] = envelope.resourceLogs.flatMap(({ scopeLogs }) => scopeLogs.flatMap(({ logRecords }) => logRecords))
  const accept = variantRecord('app-server accept')
  const stream = threadStream(attribute(accept, 'conversation.id'))

  expect(factsOf(parseLog(log, stream))).toEqual(factsOf(parseLog(accept, stream)))
  expect(keyOf(log)).toBe(keyOf(variantRecord('app-server accept')))
})

test('other Codex log events are not recognized as facts', () => {
  const events = sampleLines('logs.other-events.jsonl').map((line) => OtherEvent.parse(line))

  expect(events.length).toBeGreaterThan(0)
  for (const { logRecord } of events) {
    expect(parseLog(logRecord, null)).toEqual({
      parse_state: 'unknown',
      source_ts: EpochNs.parse(logRecord.observedTimeUnixNano),
    })
    expect(keyOf(logRecord)).toMatch(/^codex:otel:[0-9a-f]{64}$/)
  }
})

describe('decision values beyond the recorded ones', () => {
  const accept = variantRecord('app-server accept')
  const stream = threadStream(attribute(accept, 'conversation.id'))
  const decisionOf = (changes: Record<string, string | undefined>) =>
    factsOf(parseLog(withAttributes(accept, changes), stream))[0]

  test.each([
    ['approved_mcp_policy_amendment', 'approved_with_amendment'],
    ['approved_with_network_policy_allow', 'approved_with_amendment'],
    ['denied_with_network_policy_deny', 'denied'],
    ['abort', 'aborted'],
    ['escalated', 'unknown'],
    ['', 'unknown'],
  ])('%s is read as %s and marked unverified', (raw, decision) => {
    expect(decisionOf({ decision: raw })).toMatchObject({
      speaker: 'human',
      format_verified: false,
      payload: { decision, source: 'user' },
    })
  })

  test('an unrecognized or missing source is unknown, unverified and never a human decision', () => {
    for (const source of ['Policy', undefined]) {
      expect(decisionOf({ source })).toMatchObject({
        speaker: 'runtime',
        format_verified: false,
        payload: { decision: 'approved', source: 'unknown' },
      })
    }
  })

  test('the tool name keeps an explicit namespace and is absent without a name', () => {
    expect(decisionOf({ tool_namespace: 'mcp__docs', tool_name: 'search' })?.payload).toMatchObject({
      tool: 'mcp__docs/search',
    })
    expect(decisionOf({ tool_namespace: undefined })?.payload).toMatchObject({ tool: 'exec_command' })
    expect(decisionOf({ tool_name: '' })?.payload).toMatchObject({ tool: null })
    expect(decisionOf({ tool_name: undefined, 'app.version': undefined, originator: undefined })).toMatchObject({
      runtime_env: { version: null, originator: null },
      payload: { tool: null },
    })
  })

  test('a decision taken in an aang observer session carries the observer originator', () => {
    expect(decisionOf({ originator: 'aang_observer' })).toMatchObject({ runtime_env: { originator: 'aang_observer' } })
  })
})

describe('times and raw keys', () => {
  const accept = variantRecord('app-server accept')
  const stream = threadStream(attribute(accept, 'conversation.id'))
  const parseAccept = (log: unknown) => parseLog(log, stream)
  const eventTime = '1790860422500000000'

  test('the event time is preferred, the observed time follows, the receive time is the last resort', () => {
    const timed = { ...accept, timeUnixNano: eventTime }
    expect(parseAccept(timed)).toMatchObject({ source_ts: EpochNs.parse(eventTime) })
    expect(factsOf(parseAccept(timed))[0]?.at).toBe(EpochNs.parse(eventTime))

    const untimed = { ...accept, timeUnixNano: '0', observedTimeUnixNano: '0' }
    expect(parseAccept(untimed)).toMatchObject({ parse_state: 'parsed', source_ts: null })
    expect(factsOf(parseAccept(untimed))[0]?.at).toBe(receivedAt)

    const numeric = { ...accept, timeUnixNano: 1790860422500000000, observedTimeUnixNano: undefined }
    expect(parseAccept(numeric)).toMatchObject({ parse_state: 'parsed', source_ts: null })
  })

  test('the raw key is the conversation, call, decision and event time of the record', () => {
    const key = keyOf(accept)
    expect(keyOf({ ...accept, observedTimeUnixNano: '1790860499000000000', spanId: 'resent' })).toBe(key)
    expect(keyOf({ ...accept, timeUnixNano: undefined })).toBe(key)
    expect(keyOf({ ...accept, timeUnixNano: 1 })).toBe(key)
    expect(keyOf({ ...accept, timeUnixNano: eventTime })).toBe(
      `codex:otel:01a0f799-5daf-7d02-9e6c-116068f9ca2d:call_mock_3:approved:${eventTime}`,
    )
    expect(keyOf(withAttributes(accept, { decision: 'denied' }))).not.toBe(key)
    expect(keyOf(withAttributes(accept, { call_id: 'call_mock_4' }))).not.toBe(key)
  })

  test('a decision whose ids cannot form a raw key falls back to the content hash', () => {
    const colon = withAttributes(accept, { call_id: 'call:mock:3' })
    expect(factsOf(parseAccept(colon))[0]?.entity_key).toMatchObject({ call: 'call:mock:3' })
    expect(keyOf(colon)).toMatch(/^codex:otel:[0-9a-f]{64}$/)
    expect(keyOf(colon)).toBe(keyOf(colon))
    expect(keyOf(withAttributes(accept, { decision: 'not approved' }))).toMatch(/^codex:otel:[0-9a-f]{64}$/)
  })
})

describe('records that are not a readable decision', () => {
  const accept = variantRecord('app-server accept')

  test.each([
    ['another event name', withAttributes(accept, { 'event.name': 'codex.tool_result' })],
    ['no conversation', withAttributes(accept, { 'conversation.id': undefined })],
    ['a conversation id that is not a thread id', withAttributes(accept, { 'conversation.id': 'a:b' })],
    ['no call id', withAttributes(accept, { call_id: undefined })],
    ['no decision', withAttributes(accept, { decision: undefined })],
    ['attributes that are not a list', { ...accept, attributes: { decision: 'approved' } }],
    [
      'attribute values that are not strings',
      {
        ...accept,
        attributes: accept.attributes.map((entry) =>
          entry.key === 'call_id' ? { key: entry.key, value: { intValue: '3' } } : entry,
        ),
      },
    ],
  ])('%s is kept as an unknown record', (_name, log) => {
    expect(parseLog(log, threadStream(attribute(accept, 'conversation.id')))).toEqual({
      parse_state: 'unknown',
      source_ts: EpochNs.parse(accept.observedTimeUnixNano),
    })
  })

  test('a payload that is not a JSON object is invalid', () => {
    for (const payload of ['not json', '[]', '"codex.tool_decision"', 'null']) {
      expect(codexAdapter.parse(otelRecord(payload, null))).toEqual({
        parse_state: 'invalid',
        reason: 'otel payload is not a JSON object',
      })
    }
  })

  test('an OTel record outside the OTel position is not read as a decision', () => {
    const misplaced = otelRecord(JSON.stringify(accept), null, { kind: 'stream_lost', path: '/x' })
    expect(codexAdapter.parse(misplaced)).toEqual({ parse_state: 'unknown', source_ts: null })
    expect(codexAdapter.rawKey(misplaced)).toMatch(/^codex:otel:[0-9a-f]{64}$/)
  })
})

describe('a decision whose conversation has no known stream', () => {
  const subagent = variantRecord('codex exec subagent thread')
  const conversation = attribute(subagent, 'conversation.id')
  const call = attribute(subagent, 'call_id')
  const known = threadStream(execSubagentRoot, conversation)
  const rawKey = `codex:otel:${conversation}:${call}:approved:0`

  test.each([
    ['no stream', null],
    ['a stream key of another runtime', StreamKey.parse(`claude:${execSubagentRoot}:${conversation}`)],
    ['a stream key without a thread', StreamKey.parse(`codex:${conversation}`)],
    ['a stream key with extra parts', StreamKey.parse(`codex:${execSubagentRoot}:${conversation}:x`)],
    ['a stream key with a blank id', StreamKey.parse(`codex:${execSubagentRoot}: `)],
    ['the stream of another thread of the same root', threadStream(execSubagentRoot)],
    ['the stream of another subagent', threadStream(execSubagentRoot, '01a0f7a9-0000-7000-8000-0000000000a2')],
    ['the stream of a thread with the conversation as its root', threadStream(conversation, execSubagentRoot)],
  ])('with %s is kept as an unknown record under the same raw key', (_name, stream) => {
    expect(parseLog(subagent, stream)).toEqual({
      parse_state: 'unknown',
      source_ts: EpochNs.parse(subagent.observedTimeUnixNano),
    })
    expect(keyOf(subagent, stream)).toBe(rawKey)
  })

  test('with the known stream of its thread is a decision on the action of the root session', () => {
    expect(keyOf(subagent, known)).toBe(rawKey)
    expect(factsOf(parseLog(subagent, known))).toMatchObject([
      {
        entity_key: { kind: 'action', runtime: 'codex', session: execSubagentRoot, call },
        runtime_ids: { session_id: execSubagentRoot, thread_id: conversation, call_id: call },
      },
    ])
  })
})
