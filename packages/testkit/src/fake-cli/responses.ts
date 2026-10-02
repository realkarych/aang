import type { JsonValue } from '@aang/contract'
import { z } from 'zod'
import type { CodexUsage } from './scenario.js'

export interface ResponsesRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: { readonly [key: string]: JsonValue }
  readonly input: readonly JsonValue[]
}

export interface ResponsesOutcome {
  readonly text: string | null
  readonly attempts: readonly string[]
  readonly usage: CodexUsage
  readonly failure: string | null
}

const maxRounds = 16

const streamClosedEarly = 'stream disconnected before completion: stream closed before response.completed'

const tokens = z.int().nonnegative()

const StreamUsage = z.looseObject({
  input_tokens: tokens,
  input_tokens_details: z.looseObject({ cached_tokens: tokens }).nullish(),
  output_tokens: tokens,
  output_tokens_details: z.looseObject({ reasoning_tokens: tokens }).nullish(),
})

const StreamEvent = z.looseObject({
  type: z.string(),
  item: z.json().optional(),
  message: z.string().optional(),
  response: z
    .looseObject({
      usage: StreamUsage.nullish(),
      error: z.looseObject({ message: z.string() }).nullish(),
    })
    .optional(),
})
type StreamEvent = z.infer<typeof StreamEvent>

const ToolCall = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('function_call'),
    name: z.string(),
    namespace: z.string().nullish(),
    call_id: z.string(),
  }),
  z.looseObject({ type: z.literal('custom_tool_call'), name: z.string(), call_id: z.string() }),
])
type ToolCall = z.infer<typeof ToolCall>

const Message = z.looseObject({
  type: z.literal('message'),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
})

const noUsage: CodexUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
}

const parseEvents = (stream: string): StreamEvent[] =>
  stream.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
    return data === '' || data === '[DONE]' ? [] : [StreamEvent.parse(JSON.parse(data))]
  })

const addUsage = (total: CodexUsage, events: readonly StreamEvent[]): CodexUsage =>
  events.reduce((sum, event) => {
    const usage = event.type === 'response.completed' ? event.response?.usage : undefined
    return usage === undefined || usage === null
      ? sum
      : {
          inputTokens: sum.inputTokens + usage.input_tokens,
          cachedInputTokens: sum.cachedInputTokens + (usage.input_tokens_details?.cached_tokens ?? 0),
          cacheWriteInputTokens: sum.cacheWriteInputTokens,
          outputTokens: sum.outputTokens + usage.output_tokens,
          reasoningOutputTokens: sum.reasoningOutputTokens + (usage.output_tokens_details?.reasoning_tokens ?? 0),
        }
  }, total)

const failureOf = (events: readonly StreamEvent[]): string | undefined => {
  const failed = events.find((event) => event.type === 'response.failed' || event.type === 'error')
  return failed === undefined ? undefined : (failed.response?.error?.message ?? failed.message ?? failed.type)
}

export const unsupportedMessage = (call: ToolCall): string =>
  call.type === 'custom_tool_call'
    ? `unsupported custom tool call: ${call.name}`
    : `unsupported call: ${call.namespace === 'functions' ? '' : (call.namespace ?? '')}${call.name}`

const toolCallOutput = (call: ToolCall): JsonValue => ({
  type: call.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output',
  call_id: call.call_id,
  output: unsupportedMessage(call),
})

const messageText = (items: readonly JsonValue[]): string | null =>
  items
    .flatMap((item) => {
      const message = Message.safeParse(item)
      return message.success ? [message.data.content.map((part) => part.text ?? '').join('')] : []
    })
    .at(-1) ?? null

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const exchange = async (request: ResponsesRequest, input: readonly JsonValue[]): Promise<StreamEvent[]> => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ ...request.body, input }),
  })
  const stream = await response.text()
  if (!response.ok) {
    throw new Error(`unexpected status ${String(response.status)}: ${stream}`)
  }
  return parseEvents(stream)
}

export const converse = async (request: ResponsesRequest): Promise<ResponsesOutcome> => {
  let input = request.input
  let usage = noUsage
  const attempts: string[] = []
  const outcome = (text: string | null, failure: string | null): ResponsesOutcome => ({
    text,
    attempts,
    usage,
    failure,
  })
  for (let round = 0; round < maxRounds; round += 1) {
    let events: StreamEvent[]
    try {
      events = await exchange(request, input)
    } catch (error) {
      return outcome(null, describe(error))
    }
    usage = addUsage(usage, events)
    const failure = failureOf(events)
    if (failure !== undefined) {
      return outcome(null, failure)
    }
    if (!events.some((event) => event.type === 'response.completed')) {
      return outcome(null, streamClosedEarly)
    }
    const items = events.flatMap((event) =>
      event.type === 'response.output_item.done' && event.item !== undefined ? [event.item] : [],
    )
    const calls = items.flatMap((item) => {
      const call = ToolCall.safeParse(item)
      return call.success ? [call.data] : []
    })
    if (calls.length === 0) {
      return outcome(messageText(items), null)
    }
    attempts.push(...calls.map(unsupportedMessage))
    input = [...input, ...items, ...calls.map(toolCallOutput)]
  }
  return outcome(null, `the model kept calling tools for ${String(maxRounds)} rounds`)
}
