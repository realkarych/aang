import type { ActionOutcome, EpochNs, FactDraft } from '@aang/contract'
import { z } from 'zod'
import {
  actionEnded,
  actionStarted,
  agentEntity,
  agentRef,
  type CallTiming,
  fact,
  type FactSpec,
  joinText,
  type LineContext,
  type LineFacts,
  messageEntity,
  questionEntity,
  runtimeIds,
  threadEntity,
} from './facts.js'
import { BoundedJson } from './json.js'
import { instantFromMillis } from './line.js'
import { isRoot } from './stream.js'

const id = z.string().min(1)
const optionalText = z.string().nullish()
const millisPerSecond = 1000
const nanosPerMilli = 1_000_000
const finalPhase = 'final_answer'
const asyncDelivery = 'async'

const ItemCompleted = z.looseObject({
  turn_id: id.optional(),
  item: z.looseObject({ type: z.string(), id }),
  started_at_ms: z.number().optional(),
  completed_at_ms: z.number().optional(),
})

const TextPart = z.looseObject({ text: z.string().optional() })

const Duration = z.looseObject({ secs: z.number().nonnegative(), nanos: z.number().nonnegative() })

const CommandExecution = z.looseObject({
  id,
  command: z.array(z.string()),
  cwd: optionalText,
  status: optionalText,
  aggregated_output: optionalText,
  exit_code: z.int().nullish(),
  duration: Duration.nullish(),
})

const FileChange = z.looseObject({
  id,
  changes: z.record(z.string(), BoundedJson),
  status: optionalText,
  stdout: optionalText,
  stderr: optionalText,
})

const McpResult = z.looseObject({
  content: z.array(TextPart).optional(),
  isError: z.boolean().optional(),
})

const McpToolCall = z.looseObject({
  id,
  server: id,
  tool: id,
  arguments: BoundedJson.optional(),
  status: optionalText,
  result: BoundedJson.nullish(),
  duration: Duration.nullish(),
})

const Question = z.looseObject({
  title: z.string(),
  options: z.array(z.string()).optional(),
})

const AgentMessage = z.looseObject({
  id,
  content: z.array(TextPart),
  phase: optionalText,
  delivery: optionalText,
  questions: z.array(Question).nullish(),
})

const UserMessage = z.looseObject({
  id,
  content: z.array(TextPart),
})

const SubAgentActivity = z.looseObject({
  id,
  kind: z.string(),
  agent_thread_id: id,
  agent_path: optionalText,
})

const CollabAgentToolCall = z.looseObject({
  id,
  tool: id,
  status: optionalText,
  sender_thread_id: optionalText,
  receiver_thread_ids: z.array(z.string()).optional(),
  prompt: optionalText,
  agents_states: BoundedJson.optional(),
})

interface ItemContext extends LineContext {
  readonly item: unknown
  readonly turn: string | null
  readonly started: EpochNs | null
  readonly completed: EpochNs
}

type ItemParser = (context: ItemContext) => LineFacts

const statusOutcomes: ReadonlyMap<string, ActionOutcome> = new Map([
  ['completed', 'ok'],
  ['failed', 'error'],
  ['declined', 'denied'],
])

const statusOutcome = (status: string | null | undefined): ActionOutcome =>
  statusOutcomes.get(status ?? '') ?? 'unknown'

const durationMs = (duration: z.infer<typeof Duration> | null | undefined): number | null => {
  if (duration === null || duration === undefined) {
    return null
  }
  const millis = Math.round(duration.secs * millisPerSecond + duration.nanos / nanosPerMilli)
  return Number.isSafeInteger(millis) ? millis : null
}

const elapsedMs = ({ started, completed }: ItemContext): number | null =>
  started === null || completed < started ? null : Number((completed - started) / BigInt(nanosPerMilli))

const startTiming = (context: ItemContext, verified = true): CallTiming => ({
  at: context.started ?? context.completed,
  turn: context.turn,
  verified,
})

const endTiming = (context: ItemContext, verified = true): CallTiming => ({
  at: context.completed,
  turn: context.turn,
  verified,
})

const outputOf = (...streams: readonly (string | null | undefined)[]): string | null => {
  const output = streams.filter((stream) => stream !== null && stream !== undefined).join('')
  return output === '' ? null : output
}

const commandExecution: ItemParser = (context) => {
  const parsed = CommandExecution.safeParse(context.item)
  if (!parsed.success) {
    return null
  }
  const command = parsed.data
  return [
    actionStarted(context, command.id, startTiming(context), {
      tool: 'CommandExecution',
      action_kind: 'command',
      input: { command: command.command, cwd: command.cwd ?? null },
    }),
    actionEnded(context, command.id, endTiming(context), {
      outcome: statusOutcome(command.status),
      output: command.aggregated_output ?? null,
      exit_code: command.exit_code ?? null,
      duration_ms: durationMs(command.duration) ?? elapsedMs(context),
    }),
  ]
}

const fileChange: ItemParser = (context) => {
  const parsed = FileChange.safeParse(context.item)
  if (!parsed.success) {
    return null
  }
  const change = parsed.data
  return [
    actionStarted(context, change.id, startTiming(context), {
      tool: 'FileChange',
      action_kind: 'file_write',
      input: { changes: change.changes },
    }),
    actionEnded(context, change.id, endTiming(context), {
      outcome: statusOutcome(change.status),
      output: outputOf(change.stdout, change.stderr),
      duration_ms: elapsedMs(context),
    }),
  ]
}

const mcpToolCall: ItemParser = (context) => {
  const parsed = McpToolCall.safeParse(context.item)
  if (!parsed.success) {
    return null
  }
  const call = parsed.data
  const result = McpResult.safeParse(call.result).data
  const failed = call.status === 'completed' && result?.isError === true
  return [
    actionStarted(context, call.id, startTiming(context, false), {
      tool: `${call.server}/${call.tool}`,
      action_kind: 'mcp',
      input: call.arguments ?? null,
    }),
    actionEnded(context, call.id, endTiming(context, false), {
      outcome: failed ? 'error' : statusOutcome(call.status),
      output: outputOf(joinText(result?.content ?? [])),
      duration_ms: durationMs(call.duration) ?? elapsedMs(context),
      result: call.result ?? null,
    }),
  ]
}

const messageSpec = (
  context: ItemContext,
  message: string,
  speaker: FactSpec['speaker'],
  urgent: boolean,
): FactSpec => ({
  entity: messageEntity(context.stream, context.line.ordinal),
  speaker,
  urgent,
  at: context.completed,
  ids: runtimeIds(context, { turn_id: context.turn, message_id: message }),
})

const agentMessage: ItemParser = (context) => {
  const parsed = AgentMessage.safeParse(context.item)
  if (!parsed.success) {
    return null
  }
  const message = parsed.data
  const final = message.phase === finalPhase
  const facts: FactDraft[] = [
    fact('message', messageSpec(context, message.id, 'solver', final), {
      text: joinText(message.content),
      final,
      audience: isRoot(context.stream) ? 'user' : 'agent',
      model: null,
    }),
  ]
  const questions = message.questions ?? []
  if (questions.length > 0) {
    facts.push(
      fact(
        'question_asked',
        {
          entity: questionEntity(context.stream, message.id),
          speaker: 'solver',
          urgent: true,
          at: context.completed,
          ids: runtimeIds(context, { turn_id: context.turn, message_id: message.id }),
        },
        {
          source: 'agent_message',
          blocking: message.delivery !== asyncDelivery,
          questions: questions.map((question) => ({
            header: null,
            text: question.title,
            options: question.options ?? [],
          })),
        },
      ),
    )
  }
  return facts
}

const userMessage: ItemParser = (context) => {
  const parsed = UserMessage.safeParse(context.item)
  if (!parsed.success) {
    return null
  }
  const root = isRoot(context.stream)
  return [
    fact('prompt', messageSpec(context, parsed.data.id, root ? 'human' : 'runtime', false), {
      text: joinText(parsed.data.content),
      origin: root ? 'human' : 'unknown',
      origin_raw: null,
    }),
  ]
}

const contextCompaction: ItemParser = (context) => {
  const spec = (at: EpochNs): FactSpec => ({
    entity: threadEntity(context.stream),
    speaker: 'runtime',
    urgent: true,
    at,
    ids: runtimeIds(context, { turn_id: context.turn }),
  })
  const payload = { trigger: 'unknown', summary: null, tokens_before: null } as const
  return [
    ...(context.started === null ? [] : [fact('compaction', spec(context.started), { ...payload, phase: 'started' })]),
    fact('compaction', spec(context.completed), { ...payload, phase: 'completed' }),
  ]
}

const subAgentActivity: ItemParser = (context) => {
  const parsed = SubAgentActivity.safeParse(context.item)
  const { session, thread } = context.stream
  if (!parsed.success || parsed.data.agent_thread_id === session || parsed.data.agent_thread_id === thread) {
    return null
  }
  const activity = parsed.data
  const spec = (urgent: boolean): FactSpec => ({
    entity: agentEntity(context.stream, activity.agent_thread_id),
    speaker: 'runtime',
    urgent,
    at: context.completed,
    ids: runtimeIds(context, { turn_id: context.turn, agent_id: activity.agent_thread_id }),
  })
  switch (activity.kind) {
    case 'started':
      return [
        fact('agent_start', spec(false), {
          role: 'subagent',
          service: null,
          agent_type: null,
          agent_role: null,
          description: activity.agent_path ?? null,
          nickname: null,
          parent: agentRef(context.stream, context.stream.thread),
          spawned_by_call: activity.id,
          background: null,
          depth: null,
        }),
      ]
    case 'completed':
      return [
        fact('agent_end', spec(true), {
          outcome: 'completed',
          final_message: null,
          agent_type: null,
          transcript_path: null,
        }),
      ]
    default:
      return null
  }
}

const collabAgentToolCall: ItemParser = (context) => {
  const parsed = CollabAgentToolCall.safeParse(context.item)
  if (!parsed.success) {
    return null
  }
  const call = parsed.data
  return [
    actionStarted(context, call.id, startTiming(context), {
      tool: 'CollabAgentToolCall',
      action_kind: 'agent',
      input: {
        tool: call.tool,
        sender_thread_id: call.sender_thread_id ?? null,
        receiver_thread_ids: call.receiver_thread_ids ?? [],
        prompt: call.prompt ?? null,
      },
    }),
    actionEnded(context, call.id, endTiming(context), {
      outcome: statusOutcome(call.status),
      output: null,
      duration_ms: elapsedMs(context),
      result: call.agents_states ?? null,
    }),
  ]
}

const itemParsers: ReadonlyMap<string, ItemParser> = new Map([
  ['CommandExecution', commandExecution],
  ['FileChange', fileChange],
  ['McpToolCall', mcpToolCall],
  ['AgentMessage', agentMessage],
  ['UserMessage', userMessage],
  ['ContextCompaction', contextCompaction],
  ['SubAgentActivity', subAgentActivity],
  ['CollabAgentToolCall', collabAgentToolCall],
  ['Reasoning', () => []],
])

const instantOrNull = (millis: number | undefined): EpochNs | null =>
  millis === undefined ? null : instantFromMillis(millis)

export const itemCompleted = (context: LineContext): LineFacts => {
  const parsed = ItemCompleted.safeParse(context.line.payload)
  if (!parsed.success) {
    return null
  }
  const { item, turn_id: turn, started_at_ms: started, completed_at_ms: completed } = parsed.data
  return (
    itemParsers.get(item.type)?.({
      ...context,
      item,
      turn: turn ?? null,
      started: instantOrNull(started),
      completed: instantOrNull(completed) ?? context.line.at,
    }) ?? null
  )
}
