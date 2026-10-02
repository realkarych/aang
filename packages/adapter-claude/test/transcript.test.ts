import { claudeAdapter } from '@aang/adapter-claude'
import { CollectedRecord, EpochNs, FactDraft, type ParseResult } from '@aang/contract'
import { describe, test } from 'vitest'
import {
  factsOf,
  type JsonObject,
  lineRecord,
  observedAt,
  readJsonSample,
  sampleFiles,
  sampleLines,
  transcriptRecords,
} from './samples.js'

const mainSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const forkSession = 'cdfb3544-67c1-4590-a4d9-280593b6ed55'
const subagent = 'aad616394e806288d'

const transcriptFiles = [
  'claude-code-transcripts/session-86f93ed5-main-full.jsonl',
  'claude-code-transcripts/session-cdfb3544-fork-full.jsonl',
  'claude-code-transcripts/subagent-agent-aad616394e806288d.jsonl',
]

const recordSamples = async (): Promise<CollectedRecord[]> => {
  const singles = await Promise.all(
    (await sampleFiles('claude-code-transcripts/', /^rec-.*\.json$/)).map(async (name) =>
      lineRecord({ payload: JSON.stringify(await readJsonSample(name)), line: 1, path: name }),
    ),
  )
  const series = await Promise.all(
    (await sampleFiles('claude-code-transcripts/', /^rec-.*\.jsonl$/)).map(transcriptRecords),
  )
  return [...singles, ...series.flat()]
}

const parseSample = async (name: string): Promise<ParseResult> =>
  claudeAdapter.parse(
    lineRecord({ payload: JSON.stringify(await readJsonSample(`claude-code-transcripts/${name}`)), line: 1 }),
  )

const parseLine = (payload: JsonObject | string): ParseResult =>
  claudeAdapter.parse(lineRecord({ payload: typeof payload === 'string' ? payload : JSON.stringify(payload), line: 1 }))

const typeOf = (record: CollectedRecord): string => {
  const line = JSON.parse(record.payload) as JsonObject
  return [line.type, line.subtype, (line.attachment as JsonObject | undefined)?.type]
    .filter((part) => typeof part === 'string')
    .join('/')
}

const epochOf = (iso: string): EpochNs => EpochNs.parse(BigInt(Date.parse(iso)) * 1_000_000n)

const atLine = (record: CollectedRecord, line: number): CollectedRecord => {
  if (record.position.kind !== 'line') {
    throw new Error('a transcript record is expected')
  }
  return { ...record, position: { ...record.position, line } }
}

describe.concurrent('Claude transcript: acceptance on samples', () => {
  test('the main session, the rec samples, the fork and the subagent parse without invalid records', async ({
    expect,
  }) => {
    const records = [...(await Promise.all(transcriptFiles.map(transcriptRecords))).flat(), ...(await recordSamples())]

    expect(records.length).toBeGreaterThanOrEqual(190)
    for (const record of records) {
      const result = claudeAdapter.parse(record)
      expect(result.parse_state, `${record.position.kind === 'line' ? record.position.path : ''}: ${typeOf(record)}`).not.toBe(
        'invalid',
      )
      if (result.parse_state === 'parsed') {
        for (const fact of result.facts) {
          expect(FactDraft.parse(fact)).toEqual(fact)
        }
      }
    }
  })

  test('in the main session only cost-state lines remain unknown', async ({ expect }) => {
    const records = await transcriptRecords('claude-code-transcripts/session-86f93ed5-main-full.jsonl')
    const unknownTypes = new Set(
      records.filter((record) => claudeAdapter.parse(record).parse_state === 'unknown').map(typeOf),
    )

    expect([...unknownTypes]).toEqual(['cost-state'])
  })

  test('the main session yields its prompts, actions, messages, queue operations and compaction', async ({
    expect,
  }) => {
    const records = await transcriptRecords('claude-code-transcripts/session-86f93ed5-main-full.jsonl')
    const facts = records.flatMap((record) => {
      const result = claudeAdapter.parse(record)
      return result.parse_state === 'parsed' ? result.facts : []
    })
    const counts = Object.fromEntries(
      [...new Set(facts.map((fact) => fact.kind))].map((kind) => [
        kind,
        facts.filter((fact) => fact.kind === kind).length,
      ]),
    )

    expect(counts).toEqual({
      queue_operation: 10,
      prompt: 7,
      action_start: 3,
      action_end: 3,
      agent_start: 1,
      message: 4,
      compaction: 2,
    })
    expect(facts.every((fact) => fact.runtime_ids.session_id === mainSession)).toBe(true)
    const versions = (queued: boolean) =>
      new Set(facts.filter((fact) => (fact.kind === 'queue_operation') === queued).map((fact) => fact.runtime_env.version))
    expect(versions(false)).toEqual(new Set(['2.1.286']))
    expect(versions(true)).toEqual(new Set([null]))
  })
})

describe.concurrent('Claude transcript: records', () => {
  test('a prompt typed through the SDK is the human speaking', async ({ expect }) => {
    const result = await parseSample('rec-user-prompt.json')

    expect(result).toMatchObject({ parse_state: 'parsed', source_ts: epochOf('2026-10-01T11:49:31.904Z') })
    expect(factsOf(result)).toEqual([
      {
        kind: 'prompt',
        entity_key: { kind: 'message', runtime: 'claude', session: mainSession, message: 'e86fb492-94be-494b-b626-838a04fd355f' },
        speaker: 'human',
        urgent: false,
        at: epochOf('2026-10-01T11:49:31.904Z'),
        runtime_ids: {
          session_id: mainSession,
          agent_id: null,
          thread_id: null,
          turn_id: null,
          prompt_id: '3c20c624-976b-4ecb-b538-dbe1c00a5ef0',
          record_uuid: 'e86fb492-94be-494b-b626-838a04fd355f',
          parent_uuid: null,
          message_id: null,
          call_id: null,
          ordinal: null,
        },
        runtime_env: {
          cwd: '/tmp/aang-spike/cc-transcripts/run',
          version: '2.1.286',
          entrypoint: 'sdk-cli',
          originator: null,
          git_branch: 'HEAD',
        },
        format_verified: true,
        redelivery_key: null,
        payload: {
          text: 'Step 1: run `echo hi` with the Bash tool. Step 2: use the Agent tool with subagent_type "pinger" and prompt "ping". Step 3: reply with exactly: OK',
          origin: 'human',
          origin_raw: 'sdk',
        },
      },
    ])
  })

  test('a tool_use block starts an action of the solver inside its API message', async ({ expect }) => {
    const [start] = factsOf(await parseSample('rec-assistant-tool-use-bash.json'))

    expect(start).toMatchObject({
      kind: 'action_start',
      entity_key: { kind: 'action', runtime: 'claude', session: mainSession, call: 'toolu_017B7FeHZ4yDzFdvKQMwDJB8' },
      speaker: 'solver',
      urgent: false,
      payload: { tool: 'Bash', action_kind: 'command', input: { command: 'echo hi' }, description: 'Print hi' },
      runtime_ids: {
        call_id: 'toolu_017B7FeHZ4yDzFdvKQMwDJB8',
        message_id: 'msg_011CfbTzJhEoJe1pZ3Wdd3xK',
        record_uuid: '2cdb601b-dc99-4c71-be33-57f4b39d4791',
      },
    })
  })

  test('a tool_result ends the action with the output the model saw and the toolUseResult', async ({ expect }) => {
    const [end] = factsOf(await parseSample('rec-user-tool-result-bash.json'))

    expect(end).toMatchObject({
      kind: 'action_end',
      entity_key: { kind: 'action', call: 'toolu_017B7FeHZ4yDzFdvKQMwDJB8' },
      speaker: 'tool',
      urgent: false,
      payload: {
        outcome: 'ok',
        output: 'hi',
        persisted_output_path: null,
        exit_code: null,
        result: { stdout: 'hi', stderr: '', interrupted: false },
      },
      runtime_ids: { call_id: 'toolu_017B7FeHZ4yDzFdvKQMwDJB8' },
    })
  })

  test('a synchronous Agent call starts an agent action and ends with the subagent id in its result', async ({
    expect,
  }) => {
    const [start] = factsOf(await parseSample('rec-assistant-tool-use-agent.json'))
    const [end] = factsOf(await parseSample('rec-user-tool-result-agent-sync.json'))

    expect(start?.payload).toMatchObject({ tool: 'Agent', action_kind: 'agent', input: { subagent_type: 'pinger' } })
    expect(end).toMatchObject({
      entity_key: { call: 'toolu_01D254DDPoZEYPvJBjampKox' },
      payload: { outcome: 'ok', result: { status: 'completed', agentId: subagent } },
    })
    expect(end?.payload).toHaveProperty('output', expect.stringContaining('[Subagent hand-back]'))
  })

  test('the end_turn text is the urgent final message to the user', async ({ expect }) => {
    const [message] = factsOf(await parseSample('rec-assistant-text-end-turn.json'))

    expect(message).toMatchObject({
      kind: 'message',
      entity_key: { kind: 'message', message: '930a4d8d-1b25-4759-ba1d-2d30f319bd5c' },
      speaker: 'solver',
      urgent: true,
      payload: { text: 'OK', final: true, audience: 'user', model: 'claude-opus-5-5' },
      runtime_ids: { message_id: 'msg_011CfbTzh58ynVFVJQXmTEN8' },
    })
  })

  test('text before a tool call is an ordinary message', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-assistant-text-end-turn.json')
    const message = { ...(sample.message as JsonObject), stop_reason: 'tool_use' }
    const [fact] = factsOf(parseLine({ ...sample, message }))

    expect(fact).toMatchObject({ urgent: false, payload: { final: false } })
  })

  test('thinking never becomes content', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-assistant-text-end-turn.json')
    const withContent = (content: JsonObject[]) => ({ ...sample, message: { ...(sample.message as JsonObject), content } })
    const thinking = { type: 'thinking', thinking: 'secret chain of thought', signature: 'sig' }
    const redacted = { type: 'redacted_thinking', data: 'opaque' }

    expect(parseLine(withContent([thinking]))).toMatchObject({ parse_state: 'parsed', facts: [] })
    expect(parseLine(withContent([redacted]))).toMatchObject({ parse_state: 'parsed', facts: [] })
    const facts = factsOf(parseLine(withContent([thinking, { type: 'text', text: 'Done' }])))
    expect(facts.map((fact) => fact.payload)).toEqual([
      { text: 'Done', final: true, audience: 'user', model: 'claude-opus-5-5' },
    ])
    expect(JSON.stringify(facts.map((fact) => fact.payload))).not.toContain('secret chain of thought')
  })

  test('an API error record is an urgent runtime error, not the solver speaking', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-assistant-text-end-turn.json')
    const message = {
      ...(sample.message as JsonObject),
      model: '<synthetic>',
      content: [{ type: 'text', text: 'API Error: 529 overloaded' }],
    }
    const [error] = factsOf(parseLine({ ...sample, message, isApiErrorMessage: true }))

    expect(error).toMatchObject({
      kind: 'runtime_error',
      entity_key: { kind: 'session', session: mainSession },
      speaker: 'runtime',
      urgent: true,
      format_verified: false,
      payload: { message: 'API Error: 529 overloaded', code: null },
    })
  })

  test('the compact boundary and the compact summary are urgent compaction facts', async ({ expect }) => {
    const [boundary] = factsOf(await parseSample('rec-compact-boundary.json'))
    const [summary] = factsOf(await parseSample('rec-compact-summary-user.json'))

    expect(boundary).toMatchObject({
      kind: 'compaction',
      entity_key: { kind: 'session', runtime: 'claude', session: mainSession },
      speaker: 'runtime',
      urgent: true,
      payload: { phase: 'boundary', trigger: 'manual', summary: null, tokens_before: 18404 },
      runtime_ids: { record_uuid: 'bc70ae11-c596-42bb-8e3e-75bec028d925', parent_uuid: null },
    })
    expect(summary).toMatchObject({
      kind: 'compaction',
      urgent: true,
      payload: { phase: 'completed', trigger: 'unknown', tokens_before: null },
    })
    expect(summary?.payload).toHaveProperty('summary', expect.stringMatching(/^This session is being continued/))
  })

  test('an automatic or unfamiliar compaction trigger is kept or reported as unknown', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-compact-boundary.json')
    const withTrigger = (trigger: string | null) =>
      factsOf(parseLine({ ...sample, compactMetadata: { trigger } }))[0]?.payload

    expect(withTrigger('auto')).toMatchObject({ trigger: 'auto', tokens_before: null })
    expect(withTrigger('scheduled')).toMatchObject({ trigger: 'unknown' })
    expect(withTrigger(null)).toMatchObject({ trigger: 'unknown' })
  })

  test('local command lines: the caveat is synthetic, the command is the human, its output is the runtime', async ({
    expect,
  }) => {
    const records = await transcriptRecords('claude-code-transcripts/rec-compact-local-command-users.jsonl')
    const prompts = records.map((record) => factsOf(claudeAdapter.parse(record))[0])

    expect(prompts.map((prompt) => [prompt?.speaker, prompt?.payload])).toEqual([
      ['runtime', expect.objectContaining({ origin: 'synthetic', origin_raw: 'isMeta' })],
      ['human', expect.objectContaining({ origin: 'command', origin_raw: null })],
      ['runtime', expect.objectContaining({ origin: 'command', text: '<local-command-stdout>Compacted </local-command-stdout>' })],
    ])
  })

  test('prompt origin follows origin.kind first, then promptSource, and both outweigh isMeta and command markup', async ({
    expect,
  }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-prompt.json')
    const originOf = (fields: JsonObject) => {
      const [prompt] = factsOf(parseLine({ ...sample, promptSource: null, ...fields }))
      return [prompt?.speaker, prompt?.payload]
    }
    const quotedOutput = '<local-command-stdout>analyse this example</local-command-stdout>'

    expect(originOf({ origin: { kind: 'task-notification' }, promptSource: 'sdk' })).toEqual([
      'runtime',
      expect.objectContaining({ origin: 'task_notification', origin_raw: 'task-notification' }),
    ])
    expect(originOf({ origin: { kind: 'task-notification' }, promptSource: 'system', isMeta: true })).toEqual([
      'runtime',
      expect.objectContaining({ origin: 'task_notification', origin_raw: 'task-notification' }),
    ])
    expect(
      originOf({ origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: quotedOutput } }),
    ).toEqual(['human', { text: quotedOutput, origin: 'human', origin_raw: 'human' }])
    expect(originOf({ origin: { kind: 'peer' }, promptSource: 'system', isMeta: true })).toEqual([
      'runtime',
      expect.objectContaining({ origin: 'synthetic', origin_raw: 'peer' }),
    ])
    expect(originOf({ promptSource: 'typed' })).toEqual(['human', expect.objectContaining({ origin: 'human' })])
    expect(originOf({ promptSource: 'system' })).toEqual(['runtime', expect.objectContaining({ origin: 'synthetic' })])
    expect(originOf({ promptSource: 'voice' })).toEqual([
      'human',
      expect.objectContaining({ origin: 'unknown', origin_raw: 'voice' }),
    ])
    expect(originOf({})).toEqual(['human', expect.objectContaining({ origin: 'unknown', origin_raw: null })])
  })

  test('queue operations keep the queued text', async ({ expect }) => {
    const records = await transcriptRecords('claude-code-transcripts/rec-queue-operation.jsonl')
    const [enqueue, dequeue] = records.map((record) => factsOf(claudeAdapter.parse(record))[0])

    expect(enqueue).toMatchObject({
      kind: 'queue_operation',
      entity_key: { kind: 'session', session: mainSession },
      speaker: 'runtime',
      urgent: false,
      at: epochOf('2026-10-01T11:49:30.942Z'),
    })
    expect(enqueue?.payload).toHaveProperty('operation', 'enqueue')
    expect(enqueue?.payload).toHaveProperty('content', expect.stringMatching(/^Step 1/))
    expect(dequeue?.payload).toEqual({ operation: 'dequeue', content: null })
  })

  test('session metadata lines and context attachments are parsed without facts', async ({ expect }) => {
    const records = [
      ...(await transcriptRecords('claude-code-transcripts/rec-session-metadata-lines.jsonl')),
      ...(await transcriptRecords('claude-code-transcripts/rec-attachment-one-per-type.jsonl')),
    ]
    const results = records
      .filter((record) => typeOf(record) !== 'cost-state')
      .map((record) => [typeOf(record), claudeAdapter.parse(record)] as const)

    expect(results.length).toBe(17)
    for (const [type, result] of results) {
      expect(result, type).toMatchObject({ parse_state: 'parsed', facts: [] })
    }
  })

  test('the subagent prompt comes from the parent agent and its answer goes back to it', async ({ expect }) => {
    const records = await transcriptRecords('claude-code-transcripts/subagent-agent-aad616394e806288d.jsonl')
    const facts = records.flatMap((record) => factsOf(claudeAdapter.parse(record)))

    expect(facts.map((fact) => [fact.kind, fact.speaker, fact.runtime_ids.agent_id])).toEqual([
      ['prompt', 'solver', subagent],
      ['message', 'solver', subagent],
    ])
    expect(facts[0]?.payload).toEqual({ text: 'ping', origin: 'unknown', origin_raw: null })
    expect(facts[1]?.payload).toMatchObject({ text: 'pong', final: true, audience: 'agent' })
  })
})

describe.concurrent('Claude transcript: tool results', () => {
  const toolResult = async (fields: JsonObject, content: JsonObject) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-tool-result-bash.json')
    return parseLine({ ...sample, ...fields, message: { role: 'user', content: [content] } })
  }
  const block = { type: 'tool_result', tool_use_id: 'toolu_x' }

  test('an error result is urgent and carries the exit code', async ({ expect }) => {
    const [end] = factsOf(
      await toolResult(
        { toolUseResult: 'Error: Exit code 2\nboom' },
        { ...block, content: 'Exit code 2\nboom', is_error: true },
      ),
    )

    expect(end).toMatchObject({ urgent: true, payload: { outcome: 'error', exit_code: 2, output: 'Exit code 2\nboom' } })
  })

  test('a denial by the human is a denied action, marked unverified', async ({ expect }) => {
    const [end] = factsOf(
      await toolResult(
        { toolDenialKind: 'user-rejected', toolUseResult: 'User rejected tool use' },
        { ...block, content: 'The user doesn\'t want to proceed', is_error: true },
      ),
    )

    expect(end).toMatchObject({ urgent: false, format_verified: false, payload: { outcome: 'denied', exit_code: null } })
  })

  test('an interrupted command is interrupted, not an error', async ({ expect }) => {
    const [end] = factsOf(
      await toolResult(
        { toolUseResult: { stdout: '', stderr: '', interrupted: true } },
        { ...block, content: [{ type: 'text', text: 'partial' }], is_error: false },
      ),
    )

    expect(end?.payload).toMatchObject({ outcome: 'interrupted', output: 'partial' })
  })

  test('a large output saved to a file keeps its path', async ({ expect }) => {
    const path = '/home/user/.claude/projects/-tmp-run/86f93ed5/tool-results/toolu_x.txt'
    const [end] = factsOf(
      await toolResult(
        { toolUseResult: { stdout: 'head', stderr: '', interrupted: false, persistedOutputPath: path } },
        { ...block, content: 'head' },
      ),
    )

    expect(end?.payload).toMatchObject({ persisted_output_path: path, output: 'head' })
  })

  test('a result without content has no output', async ({ expect }) => {
    const [end] = factsOf(await toolResult({}, block))

    expect(end?.payload).toMatchObject({ outcome: 'ok', output: null })
  })

  test('several results in one record end several actions without guessing whose toolUseResult it is', async ({
    expect,
  }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-tool-result-bash.json')
    const facts = factsOf(
      parseLine({
        ...sample,
        message: {
          role: 'user',
          content: [
            { ...block, tool_use_id: 'toolu_a', content: 'a' },
            { ...block, tool_use_id: 'toolu_b', content: 'b' },
            { type: 'text', text: 'and continue' },
          ],
        },
      }),
    )

    expect(facts.map((fact) => [fact.kind, fact.runtime_ids.call_id, fact.payload])).toEqual([
      ['action_end', 'toolu_a', expect.objectContaining({ output: 'a', result: null })],
      ['action_end', 'toolu_b', expect.objectContaining({ output: 'b', result: null })],
      ['prompt', null, expect.objectContaining({ text: 'and continue' })],
    ])
  })

  test('an image in a prompt is kept out of the text', async ({ expect }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-prompt.json')
    const [prompt] = factsOf(
      parseLine({
        ...sample,
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', data: 'AAAA' } },
            { type: 'text', text: 'what is on the screenshot?' },
          ],
        },
      }),
    )

    expect(prompt?.payload).toMatchObject({ text: 'what is on the screenshot?', origin: 'human' })
  })
})

describe.concurrent('Claude transcript: unknown and invalid lines', () => {
  test('an unknown record type is unknown and keeps its time', ({ expect }) => {
    expect(parseLine({ type: 'future-record', sessionId: mainSession, timestamp: '2026-10-01T11:49:30.942Z' })).toEqual({
      parse_state: 'unknown',
      source_ts: epochOf('2026-10-01T11:49:30.942Z'),
    })
    expect(parseLine({ sessionId: mainSession, timestamp: 'not a time' })).toEqual({
      parse_state: 'unknown',
      source_ts: null,
    })
  })

  test('cost-state, unfamiliar system lines and attachments are unknown until their parsers land', async ({
    expect,
  }) => {
    const [costState] = await sampleLines('claude-code-transcripts/rec-cost-state-all.jsonl')

    expect(parseLine(costState ?? '')).toEqual({ parse_state: 'unknown', source_ts: null })
    expect(parseLine({ type: 'system', subtype: 'turn_duration', sessionId: mainSession, durationMs: 5 }).parse_state).toBe(
      'unknown',
    )
    expect(
      parseLine({ type: 'attachment', sessionId: mainSession, attachment: { type: 'edited_text_file' } }).parse_state,
    ).toBe('unknown')
    expect(parseLine({ type: 'attachment', sessionId: mainSession, attachment: 'flat' }).parse_state).toBe('unknown')
  })

  test('content blocks of an unknown type make the record unknown instead of dropping them', async ({ expect }) => {
    const assistant = await readJsonSample('claude-code-transcripts/rec-assistant-text-end-turn.json')
    const user = await readJsonSample('claude-code-transcripts/rec-user-prompt.json')

    expect(
      parseLine({
        ...assistant,
        message: { ...(assistant.message as JsonObject), content: [{ type: 'server_tool_use', id: 'srv' }] },
      }).parse_state,
    ).toBe('unknown')
    expect(
      parseLine({ ...user, message: { role: 'user', content: [{ type: 'document', source: {} }] } }).parse_state,
    ).toBe('unknown')
  })

  test('a time before the Unix epoch is not a source time, and the fact falls back to the observation time', async ({
    expect,
  }) => {
    const sample = await readJsonSample('claude-code-transcripts/rec-user-prompt.json')
    const result = parseLine({ ...sample, timestamp: '1969-12-31T23:59:59.000Z' })

    expect(result).toMatchObject({ parse_state: 'parsed', source_ts: null })
    expect(factsOf(result)[0]?.at).toBe(observedAt)
  })

  test('a line that is not a JSON object is invalid', ({ expect }) => {
    for (const payload of ['{"type": "user", "sessionId"', '"text"', '42']) {
      expect(parseLine(payload).parse_state, payload).toBe('invalid')
    }
  })

  test('a known record without the fields it is identified by is invalid', async ({ expect }) => {
    const prompt = await readJsonSample('claude-code-transcripts/rec-user-prompt.json')
    const assistant = await readJsonSample('claude-code-transcripts/rec-assistant-tool-use-bash.json')
    const without = (sample: JsonObject, key: string) =>
      Object.fromEntries(Object.entries(sample).filter(([name]) => name !== key))

    expect(parseLine(without(prompt, 'uuid'))).toMatchObject({ parse_state: 'invalid', reason: /transcript user line/ })
    expect(parseLine(without(assistant, 'sessionId'))).toMatchObject({
      parse_state: 'invalid',
      reason: /transcript assistant line/,
    })
    expect(parseLine({ ...prompt, timestamp: 'yesterday' })).toMatchObject({ parse_state: 'invalid' })
    expect(
      parseLine({ ...prompt, message: { role: 'user', content: [{ type: 'tool_result', content: 'no id' }] } }),
    ).toMatchObject({ parse_state: 'invalid', reason: /transcript user content/ })
    expect(
      parseLine({
        ...assistant,
        message: { ...(assistant.message as JsonObject), content: [{ type: 'tool_use', id: 'toolu_y' }] },
      }),
    ).toMatchObject({ parse_state: 'invalid', reason: /transcript assistant content/ })
    expect(parseLine({ type: 'queue-operation', sessionId: mainSession })).toMatchObject({
      parse_state: 'invalid',
      reason: /transcript queue operation/,
    })
    expect(
      parseLine({ type: 'system', subtype: 'compact_boundary', sessionId: mainSession, uuid: 'u' }),
    ).toMatchObject({ parse_state: 'invalid', reason: /transcript compact boundary/ })
  })

  test('records of other channels are not transcript lines and stay unknown', ({ expect }) => {
    const snapshot = CollectedRecord.parse({
      channel: 'registry',
      runtime: 'claude',
      stream: null,
      position: { kind: 'file', path: '/home/user/.claude/sessions/1.json', content_hash: 'a'.repeat(64) },
      hook: null,
      observed_at: observedAt,
      payload: '{"pid":1}',
    })

    expect(claudeAdapter.parse(snapshot)).toEqual({ parse_state: 'unknown', source_ts: null })
  })
})

describe.concurrent('Claude transcript: stream and record keys', () => {
  const firstLines = async (path: string) => (await sampleLines(`claude-code-transcripts/${path}`)).slice(0, 10)

  test('the main file, the fork and the subagent are three different streams', async ({ expect }) => {
    const main = claudeAdapter.streamKey(await firstLines('session-86f93ed5-main-full.jsonl'))
    const fork = claudeAdapter.streamKey(await firstLines('session-cdfb3544-fork-full.jsonl'))
    const agent = claudeAdapter.streamKey(await firstLines('subagent-agent-aad616394e806288d.jsonl'))

    expect(main).toBe(JSON.stringify(['claude', mainSession, 'main']))
    expect(fork).toBe(JSON.stringify(['claude', forkSession, 'main']))
    expect(agent).toBe(JSON.stringify(['claude', mainSession, 'agent', subagent]))
  })

  test('a stream is found again from the first lines of a moved file', async ({ expect }) => {
    const lines = await sampleLines('claude-code-transcripts/session-86f93ed5-main-full.jsonl')

    expect(claudeAdapter.streamKey(['', 'garbage', ...lines.slice(0, 3)])).toBe(claudeAdapter.streamKey(lines.slice(0, 1)))
  })

  test('first lines without a session give no stream', ({ expect }) => {
    expect(claudeAdapter.streamKey([])).toBeNull()
    expect(claudeAdapter.streamKey(['not json', '{"type":"summary"}', '[]'])).toBeNull()
  })

  test('a record with a uuid is keyed by session and uuid, so a fork copy is a record of its own stream', async ({
    expect,
  }) => {
    const main = await transcriptRecords('claude-code-transcripts/session-86f93ed5-main-full.jsonl')
    const fork = await transcriptRecords('claude-code-transcripts/session-cdfb3544-fork-full.jsonl')
    const promptLine = (records: CollectedRecord[]) =>
      records.find((record) => record.payload.includes('"uuid": "e86fb492-94be-494b-b626-838a04fd355f"'))
    const original = promptLine(main)
    const copy = promptLine(fork)
    if (original === undefined || copy === undefined) {
      throw new Error('the first prompt is expected in both the original and the fork')
    }

    expect(claudeAdapter.rawKey(original)).toBe(
      JSON.stringify(['claude', 'record', mainSession, 'e86fb492-94be-494b-b626-838a04fd355f']),
    )
    expect(claudeAdapter.rawKey(copy)).not.toBe(claudeAdapter.rawKey(original))
    expect(claudeAdapter.rawKey(atLine(original, 99))).toBe(claudeAdapter.rawKey(original))
  })

  test('a line without a uuid is keyed by stream, line number and content', async ({ expect }) => {
    const records = await transcriptRecords('claude-code-transcripts/session-86f93ed5-main-full.jsonl')
    const [enqueue] = records
    if (enqueue === undefined) {
      throw new Error('the session starts with a queue operation line')
    }
    const key = claudeAdapter.rawKey(enqueue)

    expect(claudeAdapter.rawKey({ ...enqueue, observed_at: EpochNs.parse(1n) })).toBe(key)
    expect(claudeAdapter.rawKey(atLine(enqueue, 2))).not.toBe(key)
    expect(claudeAdapter.rawKey({ ...enqueue, payload: `${enqueue.payload} ` })).not.toBe(key)
    expect(claudeAdapter.rawKey({ ...enqueue, stream: null })).not.toBe(key)
    expect(new Set(records.map((record) => claudeAdapter.rawKey(record))).size).toBe(records.length)
  })

  test('a whole-file record is keyed by its channel, position and content', ({ expect }) => {
    const snapshot = (path: string) =>
      CollectedRecord.parse({
        channel: 'registry',
        runtime: 'claude',
        stream: null,
        position: { kind: 'file', path, content_hash: 'b'.repeat(64) },
        hook: null,
        observed_at: observedAt,
        payload: '{"pid":1}',
      })

    expect(claudeAdapter.rawKey(snapshot('/a.json'))).toBe(claudeAdapter.rawKey(snapshot('/a.json')))
    expect(claudeAdapter.rawKey(snapshot('/a.json'))).not.toBe(claudeAdapter.rawKey(snapshot('/b.json')))
  })

})
