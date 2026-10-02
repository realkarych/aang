import type {
  ActionOutcome,
  CollectedRecord,
  CompactionTrigger,
  EpochNs,
  FactDraft,
  JsonValue,
  ParseResult,
  PromptOrigin,
  Speaker,
} from '@aang/contract'
import { z } from 'zod'
import { fact, type FactOrigin, invalid, noRuntimeIds, parsed, schemaViolation, unknown } from './facts.js'
import { isJsonObject, type JsonObject, parseJson } from './json.js'
import { actionKey, messageKey, ownerKey, sessionKey } from './keys.js'
import { epochFromIso } from './time.js'
import { actionKind, exitCode, inputDescription, outputText, persistedOutputPath } from './tools.js'

const name = z.string().min(1)
const optionalText = z.string().nullish()

const Line = z.object({
  type: name,
  sessionId: name,
  uuid: name.nullish(),
  parentUuid: optionalText,
  timestamp: z.iso.datetime({ offset: true }).nullish(),
  agentId: name.nullish(),
  promptId: optionalText,
  cwd: optionalText,
  version: optionalText,
  entrypoint: optionalText,
  gitBranch: optionalText,
})
type Line = z.infer<typeof Line>

const Block = z.looseObject({ type: z.string() })
type Block = z.infer<typeof Block>

const TextBlock = z.object({ type: z.literal('text'), text: z.string() })

const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: name,
  content: z.json().optional(),
  is_error: z.boolean().nullish(),
})

const ImageBlock = z.object({ type: z.literal('image') })

const ToolUseBlock = z.object({ type: z.literal('tool_use'), id: name, name, input: z.json() })

const ThinkingBlock = z.object({ type: z.literal('thinking') })

const RedactedThinkingBlock = z.object({ type: z.literal('redacted_thinking') })

const UserBlock = z.discriminatedUnion('type', [TextBlock, ToolResultBlock, ImageBlock])

const AssistantBlock = z.discriminatedUnion('type', [TextBlock, ToolUseBlock, ThinkingBlock, RedactedThinkingBlock])

const UserLine = Line.extend({
  uuid: name,
  message: z.object({ content: z.union([z.string(), z.array(Block)]) }),
  isMeta: z.boolean().nullish(),
  isCompactSummary: z.boolean().nullish(),
  toolUseResult: z.json().optional(),
  toolDenialKind: optionalText,
  promptSource: optionalText,
  origin: z.object({ kind: name }).nullish(),
})
type UserLine = z.infer<typeof UserLine>

const AssistantLine = Line.extend({
  uuid: name,
  message: z.object({
    id: name,
    model: optionalText,
    content: z.array(Block),
    stop_reason: optionalText,
  }),
  isApiErrorMessage: z.boolean().nullish(),
})

const CompactBoundaryLine = Line.extend({
  uuid: name,
  compactMetadata: z.object({
    trigger: optionalText,
    preTokens: z.int().nonnegative().nullish(),
  }),
})

const QueueOperationLine = Line.extend({ operation: name, content: optionalText })

interface LineContext {
  readonly origin: FactOrigin
  readonly sourceTs: EpochNs | null
}

type LineParser = (payload: JsonObject, record: CollectedRecord, sourceTs: EpochNs | null) => ParseResult

interface BlockUnion {
  readonly options: readonly { readonly shape: { readonly type: z.ZodLiteral<string> } }[]
}

const blockTypes = (union: BlockUnion): ReadonlySet<string> =>
  new Set(union.options.map((option) => option.shape.type.value))

const userBlockTypes: ReadonlySet<string> = blockTypes(UserBlock)

const assistantBlockTypes: ReadonlySet<string> = blockTypes(AssistantBlock)

const metadataLineTypes: ReadonlySet<string> = new Set(['last-prompt', 'atis-latch', 'mode'])

const contextAttachmentTypes: ReadonlySet<string> = new Set([
  'environment',
  'model',
  'deferred_tools_delta',
  'deferred_tools_record',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'skill_listing',
  'total_tokens_reminder',
  'budget_usd',
  'session_context',
  'date',
  'credential_org',
  'remote_session_change',
  'prompt_snapshot',
])

const finalStopReason = 'end_turn'

const compactionTriggers: ReadonlyMap<string, CompactionTrigger> = new Map([
  ['manual', 'manual'],
  ['auto', 'auto'],
])

const lineOrigin = (line: Line, record: CollectedRecord, sourceTs: EpochNs | null): FactOrigin => ({
  at: sourceTs ?? record.observed_at,
  ids: {
    ...noRuntimeIds,
    session_id: line.sessionId,
    agent_id: line.agentId ?? null,
    prompt_id: line.promptId ?? null,
    record_uuid: line.uuid ?? null,
    parent_uuid: line.parentUuid ?? null,
  },
  env: {
    cwd: line.cwd ?? null,
    version: line.version ?? null,
    entrypoint: line.entrypoint ?? null,
    originator: null,
    git_branch: line.gitBranch ?? null,
  },
  redeliveryKey: null,
})

const lineParser =
  <T extends Line>(
    subject: string,
    schema: z.ZodType<T>,
    build: (line: T, context: LineContext) => ParseResult,
  ): LineParser =>
  (payload, record, sourceTs) => {
    const line = schema.safeParse(payload)
    return line.success
      ? build(line.data, { origin: lineOrigin(line.data, record, sourceTs), sourceTs })
      : schemaViolation(`transcript ${subject}`, line.error)
  }

const hasUnknownBlock = (blocks: readonly Block[], known: ReadonlySet<string>): boolean =>
  blocks.some((block) => !known.has(block.type))

const promptOrigins: ReadonlyMap<string, readonly [PromptOrigin, Speaker]> = new Map([
  ['human', ['human', 'human']],
  ['typed', ['human', 'human']],
  ['sdk', ['human', 'human']],
  ['suggestion_accepted', ['human', 'human']],
  ['task-notification', ['task_notification', 'runtime']],
  ['system', ['synthetic', 'runtime']],
])

const commandInvocation = /^\s*<command-name>/
const commandOutput = /^\s*<local-command-(?:stdout|stderr)>/

interface PromptSource {
  readonly origin: PromptOrigin
  readonly raw: string | null
  readonly speaker: Speaker
}

const promptSource = (line: UserLine, text: string): PromptSource => {
  if (line.isMeta === true) {
    return { origin: 'synthetic', raw: 'isMeta', speaker: 'runtime' }
  }
  if (commandInvocation.test(text)) {
    return { origin: 'command', raw: null, speaker: 'human' }
  }
  if (commandOutput.test(text)) {
    return { origin: 'command', raw: null, speaker: 'runtime' }
  }
  const raw = line.origin?.kind ?? line.promptSource ?? null
  const known = raw === null ? undefined : promptOrigins.get(raw)
  if (known !== undefined) {
    const [origin, speaker] = known
    return { origin, raw, speaker }
  }
  return { origin: 'unknown', raw, speaker: (line.agentId ?? null) === null ? 'human' : 'solver' }
}

const toolOutcome = (line: UserLine, isError: boolean, toolResult: JsonValue | undefined): ActionOutcome => {
  if (isJsonObject(toolResult) && toolResult.interrupted === true) {
    return 'interrupted'
  }
  if ((line.toolDenialKind ?? null) !== null) {
    return 'denied'
  }
  return isError ? 'error' : 'ok'
}

const parseUser = lineParser('user line', UserLine, (line, { origin, sourceTs }) => {
  const { content } = line.message
  const blocks: readonly Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  if (hasUnknownBlock(blocks, userBlockTypes)) {
    return unknown(sourceTs)
  }
  const userBlocks = z.array(UserBlock).safeParse(blocks)
  if (!userBlocks.success) {
    return schemaViolation('transcript user content', userBlocks.error)
  }
  const texts = userBlocks.data.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  const text = texts.join('\n')
  if (line.isCompactSummary === true) {
    return parsed(sourceTs, [
      fact(origin, {
        kind: 'compaction',
        entity_key: ownerKey(line.sessionId, line.agentId ?? null),
        speaker: 'runtime',
        urgent: true,
        payload: { phase: 'completed', trigger: 'unknown', summary: text, tokens_before: null },
      }),
    ])
  }
  const results = userBlocks.data.flatMap((block) => (block.type === 'tool_result' ? [block] : []))
  const toolResult = results.length === 1 ? line.toolUseResult : undefined
  const actionEnds = results.map((block): FactDraft => {
    const outcome = toolOutcome(line, block.is_error === true, toolResult)
    const output = block.content === undefined ? null : outputText(block.content)
    return fact(
      origin,
      {
        kind: 'action_end',
        entity_key: actionKey(line.sessionId, block.tool_use_id),
        speaker: 'tool',
        urgent: outcome === 'error',
        payload: {
          outcome,
          output,
          persisted_output_path: toolResult === undefined ? null : persistedOutputPath(toolResult),
          exit_code: outcome === 'error' && output !== null ? exitCode(output) : null,
          duration_ms: null,
          result: toolResult ?? null,
        },
      },
      { ids: { call_id: block.tool_use_id }, verified: outcome !== 'denied' },
    )
  })
  if (results.length > 0 && texts.length === 0) {
    return parsed(sourceTs, actionEnds)
  }
  const source = promptSource(line, text)
  return parsed(sourceTs, [
    ...actionEnds,
    fact(origin, {
      kind: 'prompt',
      entity_key: messageKey(line.sessionId, line.uuid),
      speaker: source.speaker,
      urgent: false,
      payload: { text, origin: source.origin, origin_raw: source.raw },
    }),
  ])
})

const parseAssistant = lineParser('assistant line', AssistantLine, (line, { origin, sourceTs }) => {
  const { message } = line
  if (hasUnknownBlock(message.content, assistantBlockTypes)) {
    return unknown(sourceTs)
  }
  const blocks = z.array(AssistantBlock).safeParse(message.content)
  if (!blocks.success) {
    return schemaViolation('transcript assistant content', blocks.error)
  }
  const messageOrigin: FactOrigin = { ...origin, ids: { ...origin.ids, message_id: message.id } }
  const agent = line.agentId ?? null
  if (line.isApiErrorMessage === true) {
    const text = blocks.data.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    return parsed(sourceTs, [
      fact(
        messageOrigin,
        {
          kind: 'runtime_error',
          entity_key: ownerKey(line.sessionId, agent),
          speaker: 'runtime',
          urgent: true,
          payload: { message: text, code: null },
        },
        { verified: false },
      ),
    ])
  }
  const final = message.stop_reason === finalStopReason
  return parsed(
    sourceTs,
    blocks.data.flatMap((block): FactDraft[] => {
      switch (block.type) {
        case 'text':
          return [
            fact(messageOrigin, {
              kind: 'message',
              entity_key: messageKey(line.sessionId, line.uuid),
              speaker: 'solver',
              urgent: final,
              payload: {
                text: block.text,
                final,
                audience: agent === null ? 'user' : 'agent',
                model: message.model ?? null,
              },
            }),
          ]
        case 'tool_use':
          return [
            fact(
              messageOrigin,
              {
                kind: 'action_start',
                entity_key: actionKey(line.sessionId, block.id),
                speaker: 'solver',
                urgent: false,
                payload: {
                  tool: block.name,
                  action_kind: actionKind(block.name),
                  input: block.input,
                  description: inputDescription(block.input),
                  container_call: null,
                },
              },
              { ids: { call_id: block.id } },
            ),
          ]
        case 'thinking':
        case 'redacted_thinking':
          return []
      }
    }),
  )
})

const parseCompactBoundary = lineParser('compact boundary', CompactBoundaryLine, (line, { origin, sourceTs }) => {
  const trigger = line.compactMetadata.trigger ?? null
  return parsed(sourceTs, [
    fact(origin, {
      kind: 'compaction',
      entity_key: ownerKey(line.sessionId, line.agentId ?? null),
      speaker: 'runtime',
      urgent: true,
      payload: {
        phase: 'boundary',
        trigger: (trigger === null ? undefined : compactionTriggers.get(trigger)) ?? 'unknown',
        summary: null,
        tokens_before: line.compactMetadata.preTokens ?? null,
      },
    }),
  ])
})

const parseQueueOperation = lineParser('queue operation', QueueOperationLine, (line, { origin, sourceTs }) =>
  parsed(sourceTs, [
    fact(origin, {
      kind: 'queue_operation',
      entity_key: sessionKey(line.sessionId),
      speaker: 'runtime',
      urgent: false,
      payload: { operation: line.operation, content: line.content ?? null },
    }),
  ]),
)

const parseSystem: LineParser = (payload, record, sourceTs) =>
  payload.subtype === 'compact_boundary' ? parseCompactBoundary(payload, record, sourceTs) : unknown(sourceTs)

const parseAttachment: LineParser = (payload, _record, sourceTs) => {
  const { attachment } = payload
  return isJsonObject(attachment) &&
    typeof attachment.type === 'string' &&
    contextAttachmentTypes.has(attachment.type)
    ? parsed(sourceTs, [])
    : unknown(sourceTs)
}

const parseMetadata: LineParser = (_payload, _record, sourceTs) => parsed(sourceTs, [])

const lineParsers: ReadonlyMap<string, LineParser> = new Map([
  ['user', parseUser],
  ['assistant', parseAssistant],
  ['system', parseSystem],
  ['queue-operation', parseQueueOperation],
  ['attachment', parseAttachment],
  ...[...metadataLineTypes].map((type): [string, LineParser] => [type, parseMetadata]),
])

const timestampOf = (payload: JsonObject): EpochNs | null =>
  typeof payload.timestamp === 'string' ? epochFromIso(payload.timestamp) : null

export const parseTranscriptLine = (record: CollectedRecord): ParseResult => {
  const payload = parseJson(record.payload)
  if (!isJsonObject(payload)) {
    return invalid('transcript line is not a JSON object')
  }
  const sourceTs = timestampOf(payload)
  const parser = typeof payload.type === 'string' ? lineParsers.get(payload.type) : undefined
  return parser === undefined ? unknown(sourceTs) : parser(payload, record, sourceTs)
}
