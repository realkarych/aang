import { claudeAdapter } from '@aang/adapter-claude'
import { type FactDraft, type ParseResult, type TokenUsage } from '@aang/contract'
import { describe, test } from 'vitest'
import { factsOf, type JsonObject, lineRecord, observedAt, readJsonSample, transcriptRecords } from './samples.js'

const mainSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const subagent = 'aad616394e806288d'
const opus = 'claude-opus-5-5'

const parseLine = (payload: JsonObject): ParseResult =>
  claudeAdapter.parse(lineRecord({ payload: JSON.stringify(payload), line: 1 }))

const factsOfFile = async (file: string): Promise<{ line: number; fact: FactDraft }[]> =>
  (await transcriptRecords(`claude-code-transcripts/${file}`)).flatMap((record) =>
    factsOf(claudeAdapter.parse(record)).map((fact) => ({
      line: record.position.kind === 'line' ? record.position.line : 0,
      fact,
    })),
  )

const usageOf = (fact: FactDraft | undefined) => {
  if (fact?.kind !== 'usage') {
    throw new Error(`a usage fact is expected, got ${String(fact?.kind)}`)
  }
  return fact
}

const costStateOf = (fact: FactDraft | undefined) => {
  if (fact?.kind !== 'cost_state') {
    throw new Error(`a cost state fact is expected, got ${String(fact?.kind)}`)
  }
  return fact
}

const tokens = (
  uncached: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  reasoning: number | null = 0,
): TokenUsage => ({
  uncached_input_tokens: uncached,
  cache_read_input_tokens: cacheRead,
  cache_write_input_tokens: cacheWrite,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
})

const sum = (usages: readonly TokenUsage[]): TokenUsage =>
  usages.reduce(
    (total, usage) =>
      tokens(
        total.uncached_input_tokens + usage.uncached_input_tokens,
        total.cache_read_input_tokens + usage.cache_read_input_tokens,
        total.cache_write_input_tokens + usage.cache_write_input_tokens,
        total.output_tokens + usage.output_tokens,
        (total.reasoning_output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0),
      ),
    tokens(0, 0, 0, 0),
  )

const assistantSample = async (message: JsonObject, fields: JsonObject = {}): Promise<JsonObject> => {
  const sample = await readJsonSample('claude-code-transcripts/rec-assistant-text-end-turn.json')
  return { ...sample, ...fields, message: { ...(sample.message as JsonObject), ...message } }
}

const costStateSample = async (fields: JsonObject): Promise<JsonObject> => {
  const [first] = await transcriptRecords('claude-code-transcripts/rec-cost-state-all.jsonl')
  return { ...(JSON.parse(first?.payload ?? '{}') as JsonObject), ...fields }
}

describe.concurrent('Claude usage: records of the main stream and the subagent', () => {
  test('every API message is a usage record keyed by its message id, with its model, tokens and stop reason', async ({
    expect,
  }) => {
    const main = await factsOfFile('session-86f93ed5-main-full.jsonl')
    const agent = await factsOfFile('subagent-agent-aad616394e806288d.jsonl')
    const usages = [...main, ...agent].filter(({ fact }) => fact.kind === 'usage').map(({ line, fact }) => {
      const usage = usageOf(fact)
      return [line, usage.entity_key, usage.runtime_ids.agent_id, usage.payload] as const
    })
    const key = (message: string) => ({ kind: 'usage', runtime: 'claude', session: mainSession, usage: message })
    const payload = (stopReason: string, usage: TokenUsage) => ({
      model: opus,
      tokens: usage,
      stop_reason: stopReason,
      synthetic: false,
    })

    expect(usages).toEqual([
      [21, key('msg_011CfbTzJhEoJe1pZ3Wdd3xK'), null, payload('tool_use', tokens(2, 10341, 7337, 74))],
      [28, key('msg_011CfbTzTVpDLDBw4hapzNeq'), null, payload('tool_use', tokens(2, 17678, 131, 131))],
      [32, key('msg_011CfbTzh58ynVFVJQXmTEN8'), null, payload('end_turn', tokens(2, 17809, 417, 4))],
      [41, key('msg_011CfbU4zWVVUFTgtFWX4nfx'), null, payload('end_turn', tokens(2, 18226, 111, 5))],
      [50, key('msg_011CfbUBFGvUGjvWUw8ALhRs'), null, payload('end_turn', tokens(2, 18230, 167, 5))],
      [83, key('msg_011CfbUbXqVTyydKYrwuTqsd'), null, payload('tool_use', tokens(2, 12205, 5794, 74))],
      [94, key('msg_011CfbUdDcRavFkumK4sDfkb'), null, payload('end_turn', tokens(2, 17999, 1868, 5))],
      [8, key('msg_011CfbTzahfR5Uv9kD1Z1Zot'), subagent, payload('end_turn', tokens(2, 0, 1825, 4))],
    ])
  })

  test('a usage record is the runtime speaking about the record it came from', async ({ expect }) => {
    const [usage] = (await factsOfFile('session-86f93ed5-main-full.jsonl')).filter(({ fact }) => fact.kind === 'usage')

    expect(usage?.fact).toMatchObject({
      speaker: 'runtime',
      urgent: false,
      format_verified: true,
      runtime_ids: {
        session_id: mainSession,
        message_id: 'msg_011CfbTzJhEoJe1pZ3Wdd3xK',
        record_uuid: '2cdb601b-dc99-4c71-be33-57f4b39d4791',
      },
      runtime_env: { version: '2.1.286', entrypoint: 'sdk-cli' },
    })
  })

  test('the records of the first three runs add up to the cost state written at the end of each run', async ({
    expect,
  }) => {
    const main = await factsOfFile('session-86f93ed5-main-full.jsonl')
    const agent = (await factsOfFile('subagent-agent-aad616394e806288d.jsonl')).map(({ fact }) => fact)
    const costStates = main.filter(({ fact }) => fact.kind === 'cost_state')
    const recordsBefore = (line: number) =>
      sum(
        [...main.filter((entry) => entry.line < line).map(({ fact }) => fact), ...agent]
          .filter((fact) => fact.kind === 'usage')
          .map((fact) => usageOf(fact).payload.tokens),
      )
    const reported = (line: number) => {
      const state = costStates.find((entry) => entry.line === line)
      return costStateOf(state?.fact).payload.models.map((model) => [model.model, model.tokens])
    }

    expect(costStates.map(({ line }) => line)).toEqual([34, 44, 52, 68, 69, 96, 97])
    for (const line of [34, 44, 52]) {
      expect(reported(line), `cost state at line ${String(line)}`).toEqual([[opus, recordsBefore(line)]])
    }
  })

  test('the compaction call is seen only in the cost state', async ({ expect }) => {
    const main = await factsOfFile('session-86f93ed5-main-full.jsonl')
    const before = costStateOf(main.find(({ line }) => line === 52)?.fact).payload.models[0]?.tokens
    const after = costStateOf(main.find(({ line }) => line === 68)?.fact).payload.models[0]?.tokens
    const compactionRun = main.filter(({ line, fact }) => line > 52 && line < 68 && fact.kind === 'usage')

    expect(compactionRun).toEqual([])
    expect((after?.output_tokens ?? 0) - (before?.output_tokens ?? 0)).toBe(949)
  })

  test('a block of a subagent message written before its end has no stop reason', async ({ expect }) => {
    const [line] = await transcriptRecords('claude-code-transcripts/subagent-agent-aad616394e806288d.jsonl').then(
      (records) => records.filter((record) => record.payload.includes('"type": "assistant"')),
    )
    const sample = JSON.parse(line?.payload ?? '{}') as JsonObject
    const message = sample.message as JsonObject
    const block = (output: number, stopReason: string | null) =>
      usageOf(
        factsOf(
          parseLine({
            ...sample,
            message: { ...message, stop_reason: stopReason, usage: { ...(message.usage as JsonObject), output_tokens: output } },
          }),
        ).at(-1),
      )
    const early = block(3, null)
    const last = block(250, 'end_turn')

    expect(early.entity_key).toEqual(last.entity_key)
    expect(early.payload).toMatchObject({ stop_reason: null, tokens: { output_tokens: 3 } })
    expect(last.payload).toMatchObject({ stop_reason: 'end_turn', tokens: { output_tokens: 250 } })
    expect(early.runtime_ids.agent_id).toBe(subagent)
  })

  test('a record with only thinking keeps its message id through its usage record', async ({ expect }) => {
    const thinking = await assistantSample({ content: [{ type: 'thinking', thinking: 'secret', signature: 's' }] })
    const [usage, ...rest] = factsOf(parseLine(thinking))

    expect(rest).toEqual([])
    expect(usage).toMatchObject({
      kind: 'usage',
      entity_key: { kind: 'usage', usage: 'msg_011CfbTzh58ynVFVJQXmTEN8' },
      runtime_ids: { message_id: 'msg_011CfbTzh58ynVFVJQXmTEN8', record_uuid: '930a4d8d-1b25-4759-ba1d-2d30f319bd5c' },
    })
    expect(JSON.stringify(usage?.payload)).not.toContain('secret')
  })

  test('an API error record is a synthetic usage record, unverified', async ({ expect }) => {
    const error = await assistantSample(
      {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: 529 overloaded' }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      { isApiErrorMessage: true },
    )
    const facts = factsOf(parseLine(error))

    expect(facts.map((fact) => fact.kind)).toEqual(['runtime_error', 'usage'])
    expect(facts[1]).toMatchObject({
      format_verified: false,
      payload: { model: '<synthetic>', synthetic: true, tokens: tokens(0, 0, 0, 0, null) },
    })
  })

  test('absent cache counts are zero, absent thinking and model are unknown, a record without usage has no usage record', async ({
    expect,
  }) => {
    const bare = await assistantSample({ model: null, usage: { input_tokens: 5, output_tokens: 7 } })
    const without = await assistantSample({ usage: null })

    expect(usageOf(factsOf(parseLine(bare)).at(-1)).payload).toMatchObject({
      model: null,
      tokens: tokens(5, 0, 0, 7, null),
      synthetic: false,
    })
    expect(factsOf(parseLine(without)).map((fact) => fact.kind)).toEqual(['message'])
  })

  test('a usage record with counts that are not token counts makes the record invalid', async ({ expect }) => {
    for (const usage of [{ input_tokens: -1, output_tokens: 1 }, { input_tokens: 1 }, { input_tokens: 1, output_tokens: 1.5 }]) {
      expect(parseLine(await assistantSample({ usage })), JSON.stringify(usage)).toMatchObject({
        parse_state: 'invalid',
        reason: /transcript assistant line/,
      })
    }
  })
})

describe.concurrent('Claude usage: cost state', () => {
  test('every cost-state line is the session total by Claude Code with money, duration and tokens per model', async ({
    expect,
  }) => {
    const states = (await factsOfFile('rec-cost-state-all.jsonl')).map(({ fact }) => costStateOf(fact))

    expect(states.map((state) => [state.payload.total_cost_usd, state.payload.total_duration_ms])).toEqual([
      [0.0856626, 7865],
      [0.0903038, 16325],
      [0.0953938, 18957],
      [0.126246, 28381],
      [0.126246, 28386],
      [0.19517879999999999, 62191],
      [0.19517879999999999, 62195],
    ])
    expect(states[0]).toEqual({
      kind: 'cost_state',
      entity_key: { kind: 'session', runtime: 'claude', session: mainSession },
      speaker: 'runtime',
      urgent: false,
      at: observedAt,
      runtime_ids: {
        session_id: mainSession,
        agent_id: null,
        thread_id: null,
        turn_id: null,
        prompt_id: null,
        record_uuid: null,
        parent_uuid: null,
        message_id: null,
        call_id: null,
        ordinal: null,
      },
      runtime_env: { cwd: null, version: null, entrypoint: null, originator: null, git_branch: null },
      format_verified: true,
      redelivery_key: null,
      payload: {
        total_cost_usd: 0.0856626,
        total_duration_ms: 7865,
        models: [{ model: opus, tokens: tokens(8, 45828, 9710, 213), cost_usd: 0.0856626 }],
      },
    })
    expect(states[3]?.payload.models).toEqual([
      { model: opus, tokens: tokens(2063, 100625, 9988, 1172, 99), cost_usd: 0.126246 },
    ])
  })

  test('a cost-state line has no time of its own', async ({ expect }) => {
    const [line] = await transcriptRecords('claude-code-transcripts/rec-cost-state-all.jsonl')

    expect(claudeAdapter.parse(line ?? lineRecord({ payload: '', line: 1 }))).toMatchObject({
      parse_state: 'parsed',
      source_ts: null,
    })
  })

  test('the session total of an SDK session keeps every model, including the summary model', async ({ expect }) => {
    const [state] = factsOf(
      claudeAdapter.parse(
        (await transcriptRecords('claude-agent-sdk/transcript-sdk-specific-entries.jsonl')).find((record) =>
          record.payload.includes('"cost-state"'),
        ) ?? lineRecord({ payload: '', line: 1 }),
      ),
    )

    expect(costStateOf(state).payload.models.map((model) => [model.model, model.cost_usd])).toEqual([
      ['claude-haiku-4-5-20251001', 0.001001],
      [opus, 0.22467420000000002],
    ])
  })

  test('a total with a model of unknown price has no money, keeps its tokens and is unverified', async ({
    expect,
  }) => {
    const [state] = factsOf(parseLine(await costStateSample({ hasUnknownModelCost: true })))

    expect(state).toMatchObject({
      format_verified: false,
      payload: {
        total_cost_usd: null,
        total_duration_ms: 7865,
        models: [{ model: opus, tokens: tokens(8, 45828, 9710, 213), cost_usd: null }],
      },
    })
  })

  test('a total without money, duration or models keeps them empty', ({ expect }) => {
    const [state] = factsOf(
      parseLine({ type: 'cost-state', sessionId: mainSession, modelUsage: { [opus]: { inputTokens: 1, outputTokens: 2 } } }),
    )

    expect(state?.payload).toEqual({
      total_cost_usd: null,
      total_duration_ms: null,
      models: [{ model: opus, tokens: tokens(1, 0, 0, 2, null), cost_usd: null }],
    })
    expect(factsOf(parseLine({ type: 'cost-state', sessionId: mainSession }))[0]?.payload).toEqual({
      total_cost_usd: null,
      total_duration_ms: null,
      models: [],
    })
  })

  test('a cost state without its session or with counts that are not token counts is invalid', async ({ expect }) => {
    const withoutSession = Object.fromEntries(
      Object.entries(await costStateSample({})).filter(([field]) => field !== 'sessionId'),
    )

    for (const line of [
      withoutSession,
      await costStateSample({ modelUsage: { [opus]: { inputTokens: 'many', outputTokens: 1 } } }),
      await costStateSample({ totalCostUSD: -1 }),
      await costStateSample({ modelUsage: { '': { inputTokens: 1, outputTokens: 1 } } }),
    ]) {
      expect(parseLine(line), JSON.stringify(line)).toMatchObject({ parse_state: 'invalid', reason: /transcript cost state/ })
    }
  })
})
