import { readFileSync } from 'node:fs'
import { codexAdapter } from '@aang/adapter-codex'
import { CollectedRecord, EpochNs, type FactDraft, type StreamKey } from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { factsOf, parseFacts, streamFrom, withPayload } from './rollout-records.js'

const samplesRoot = new URL('../../../docs/research/samples/', import.meta.url)
const observedAt = EpochNs.parse(1_790_861_489_400_000_000n)
const call = 'call_mock_5'
const root = '01a0f765-22c7-7983-8ccf-ebf2f227582f'
const child = '01a0f765-7021-7800-bbdb-148d356ba89a'

const readSample = (path: string): unknown => JSON.parse(readFileSync(new URL(path, samplesRoot), 'utf8'))

const SessionMeta = z.looseObject({ payload: z.looseObject({ id: z.string() }) })

const Attribute = z.looseObject({ key: z.string(), value: z.looseObject({ stringValue: z.string().optional() }) })
const Variant = z.looseObject({
  _case: z.string(),
  logRecord: z.looseObject({ attributes: z.array(Attribute) }).optional(),
})

const HookSample = z.looseObject({ stdin: z.record(z.string(), z.unknown()) })

const subagentDecision = (): z.infer<typeof Variant>['logRecord'] =>
  readFileSync(new URL('codex-otel/logs.tool_decision.variants.jsonl', samplesRoot), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => Variant.parse(JSON.parse(line)))
    .find((variant) => variant._case === 'codex exec subagent thread')?.logRecord

interface Thread {
  readonly name: string
  readonly meta: string
  readonly thread: string
  readonly agent: string | undefined
}

const threads: readonly Thread[] = [
  { name: 'a subagent thread', meta: 'codex-sdk/rollout-session-meta.sdk-subagent.json', thread: child, agent: child },
  { name: 'the root thread', meta: 'codex-sdk/rollout-session-meta.sdk-parent.json', thread: root, agent: undefined },
]

const rolloutStart = (stream: StreamKey): FactDraft[] =>
  parseFacts(withPayload('response_item.function_call.exec_command.mock.json', { call_id: call }), stream)

const hookStart = (agent: string | undefined): FactDraft[] => {
  const { stdin } = HookSample.parse(readSample('codex-cli/hooks/PreToolUse.Bash.subagent.json'))
  const payload = { ...stdin, session_id: root, agent_id: agent, tool_use_id: call }
  return factsOf(
    codexAdapter.parse(
      CollectedRecord.parse({
        channel: 'hook',
        runtime: 'codex',
        stream: null,
        position: { kind: 'spool', file: `codex-PreToolUse-${call}.spool` },
        hook: { registration: 'user', env: {} },
        observed_at: observedAt,
        payload: JSON.stringify(payload),
      }),
    ),
  )
}

const otelDecision = (stream: StreamKey, thread: string): FactDraft[] => {
  const log = subagentDecision()
  if (log === undefined) {
    throw new Error('no subagent decision sample')
  }
  const attributes = log.attributes.map((entry) =>
    entry.key === 'conversation.id' ? { key: entry.key, value: { stringValue: thread } } : entry,
  )
  return factsOf(
    codexAdapter.parse(
      CollectedRecord.parse({
        channel: 'otel',
        runtime: 'codex',
        stream,
        position: { kind: 'otel' },
        hook: null,
        observed_at: observedAt,
        payload: JSON.stringify({ ...log, attributes }),
      }),
    ),
  )
}

describe('one action seen through the rollout, a hook and OTel', () => {
  test.each(threads)('in $name has one canonical key and object', ({ meta, thread, agent }) => {
    const metaLine = JSON.stringify(readSample(meta))
    expect(SessionMeta.parse(JSON.parse(metaLine)).payload.id).toBe(thread)
    const stream = streamFrom(metaLine)
    const action = { kind: 'action', runtime: 'codex', session: root, call } as const

    const facts = [...rolloutStart(stream), ...hookStart(agent), ...otelDecision(stream, thread)]

    expect(facts.map(({ kind }) => kind)).toEqual(['action_start', 'action_start', 'permission_decision'])
    for (const fact of facts) {
      expect(fact.entity_key).toEqual(action)
      expect(objectId(fact.entity_key)).toBe(objectId(action))
      expect(fact.runtime_ids).toMatchObject({ session_id: root, thread_id: thread, call_id: call })
    }
  })
})
