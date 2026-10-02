import {
  type ActionKind,
  type CollectedRecord,
  type CompactionPhase,
  CompactionTrigger,
  type FactDraft,
  type FactEntityKey,
  JsonValue,
  type ParseResult,
  type RuntimeEnv,
  type RuntimeIds,
  SessionLaunch,
  type Speaker,
} from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import { z } from 'zod'
import { agentNamespaces, mcpNamespacePrefix } from './calls.js'
import {
  actionEntity,
  agentEntity,
  emptyEnv,
  emptyIds,
  type FactSpec,
  fact,
  namedMessageEntity,
  questionEntity,
  sessionEntity,
  threadEntity,
} from './facts.js'
import { readJson, withinNestingLimit } from './json.js'
import { observerOriginator } from './session.js'
import { isRoot, type ThreadStream } from './stream.js'
import { surfaceOf } from './surface.js'

const name = z.string().min(1)
const optionalText = z.string().nullish()
const compactSource = 'compact'

const JsonObject = z.record(z.string(), z.unknown())
const HookObject = z.record(z.string(), JsonValue)
type HookObject = z.infer<typeof HookObject>

const HookCommon = z.looseObject({
  hook_event_name: name,
  session_id: name,
  turn_id: name.nullish(),
  agent_id: name.nullish(),
  cwd: optionalText,
})
type HookCommon = z.infer<typeof HookCommon>

const SessionStart = z.looseObject({ source: optionalText })
const UserPromptSubmit = z.looseObject({ prompt: z.string() })
const PreToolUse = z.looseObject({ tool_name: name, tool_input: JsonValue, tool_use_id: name })
const PostToolUse = PreToolUse.extend({ tool_response: JsonValue })
const PermissionRequest = z.looseObject({ tool_name: name, tool_input: JsonValue })
const Compact = z.looseObject({ trigger: optionalText })
const SubagentStart = z.looseObject({ agent_type: optionalText })
const SubagentStop = SubagentStart.extend({ agent_transcript_path: optionalText, last_assistant_message: optionalText })
const Stop = z.looseObject({ last_assistant_message: optionalText })
const Interrupt = z.looseObject({})
const SessionEnd = z.looseObject({ reason: optionalText })
const Described = z.looseObject({ description: name })

interface HookContext {
  readonly stream: ThreadStream
  readonly file: string
  readonly env: RuntimeEnv
  readonly origin: Pick<FactSpec, 'at' | 'ids' | 'env' | 'redelivery'>
}

type HookFacts = readonly FactDraft[] | null

type HookParser = (payload: HookObject, context: HookContext) => HookFacts

const hookToolKinds: ReadonlyMap<string, ActionKind> = new Map([
  ['Bash', 'command'],
  ['apply_patch', 'file_write'],
  ['request_user_input', 'question'],
  ['request_user_input_async', 'question'],
])

const hookActionKind = (tool: string): ActionKind => {
  if (tool.startsWith(mcpNamespacePrefix)) {
    return 'mcp'
  }
  if (agentNamespaces.some((namespace) => tool.startsWith(namespace))) {
    return 'agent'
  }
  return hookToolKinds.get(tool) ?? 'other'
}

const spec = (
  context: HookContext,
  entity: FactEntityKey,
  speaker: Speaker,
  urgent: boolean,
  ids: Partial<RuntimeIds> = {},
): FactSpec => ({
  ...context.origin,
  entity,
  speaker,
  urgent,
  ids: { ...context.origin.ids, ...ids },
})

const hookParser =
  <T>(schema: z.ZodType<T>, build: (event: T, context: HookContext) => HookFacts): HookParser =>
  (payload, context) => {
    const event = schema.safeParse(payload)
    return event.success ? build(event.data, context) : null
  }

const rootOnly =
  <T>(build: (event: T, context: HookContext) => HookFacts) =>
  (event: T, context: HookContext): HookFacts =>
    isRoot(context.stream) ? build(event, context) : null

const agentOnly =
  <T>(build: (event: T, context: HookContext) => HookFacts) =>
  (event: T, context: HookContext): HookFacts =>
    isRoot(context.stream) ? null : build(event, context)

const sessionStart = hookParser(
  SessionStart,
  rootOnly(({ source }, context) => {
    const entity = sessionEntity(context.stream)
    if (source === compactSource) {
      return [
        fact('compaction', spec(context, entity, 'runtime', true), {
          phase: 'boundary',
          trigger: 'unknown',
          summary: null,
          tokens_before: null,
        }),
      ]
    }
    return [
      fact('session_start', spec(context, entity, 'runtime', false), {
        launch: SessionLaunch.safeParse(source).data ?? 'unknown',
        surface: surfaceOf(context.env.originator, null),
        cwd: context.env.cwd,
        forked_from: null,
        observer_marker: context.env.originator === observerOriginator,
      }),
    ]
  }),
)

const userPromptSubmit = hookParser(UserPromptSubmit, ({ prompt }, context) => {
  const root = isRoot(context.stream)
  return [
    fact(
      'prompt',
      spec(context, namedMessageEntity(context.stream.session, context.file), root ? 'human' : 'runtime', false),
      { text: prompt, origin: root ? 'human' : 'unknown', origin_raw: null },
    ),
  ]
})

const preToolUse = hookParser(PreToolUse, (event, context) => [
  fact(
    'action_start',
    spec(context, actionEntity(context.stream, event.tool_use_id), 'solver', false, { call_id: event.tool_use_id }),
    {
      tool: event.tool_name,
      action_kind: hookActionKind(event.tool_name),
      input: event.tool_input,
      description: Described.safeParse(event.tool_input).data?.description ?? null,
      container_call: null,
    },
  ),
])

const postToolUse = hookParser(PostToolUse, (event, context) => {
  const response = event.tool_response
  const text = typeof response === 'string' ? response : null
  return [
    fact(
      'action_end',
      spec(context, actionEntity(context.stream, event.tool_use_id), 'tool', false, { call_id: event.tool_use_id }),
      {
        outcome: 'unknown',
        output: text,
        persisted_output_path: null,
        exit_code: null,
        duration_ms: null,
        result: text === null ? response : null,
      },
    ),
  ]
})

const permissionRequest = hookParser(PermissionRequest, (event, context) => [
  fact('permission_request', spec(context, questionEntity(context.stream, context.file), 'runtime', true), {
    tool: event.tool_name,
    input: event.tool_input,
  }),
])

const compaction = (phase: CompactionPhase) =>
  hookParser(Compact, ({ trigger }, context) => [
    fact('compaction', spec(context, threadEntity(context.stream), 'runtime', true), {
      phase,
      trigger: CompactionTrigger.safeParse(trigger).data ?? 'unknown',
      summary: null,
      tokens_before: null,
    }),
  ])

const subagentStart = hookParser(
  SubagentStart,
  agentOnly((event, context) => [
    fact('agent_start', spec(context, agentEntity(context.stream), 'runtime', false), {
      role: 'subagent',
      service: null,
      agent_type: event.agent_type ?? null,
      agent_role: null,
      description: null,
      nickname: null,
      parent: null,
      spawned_by_call: null,
      background: null,
      depth: null,
    }),
  ]),
)

const subagentStop = hookParser(
  SubagentStop,
  agentOnly((event, context) => [
    fact('agent_end', spec(context, agentEntity(context.stream), 'runtime', true), {
      outcome: 'completed',
      final_message: event.last_assistant_message ?? null,
      agent_type: event.agent_type ?? null,
      transcript_path: event.agent_transcript_path ?? null,
    }),
  ]),
)

const stop = hookParser(Stop, (event, context) => [
  fact('turn_end', spec(context, threadEntity(context.stream), 'runtime', true), {
    outcome: 'completed',
    reason: null,
    final_message: event.last_assistant_message ?? null,
    background_tasks: [],
  }),
])

const interrupt = hookParser(Interrupt, (_event, context) => [
  fact('turn_end', spec(context, threadEntity(context.stream), 'runtime', true), {
    outcome: 'interrupted',
    reason: null,
    final_message: null,
    background_tasks: [],
  }),
])

const sessionEnd = hookParser(
  SessionEnd,
  rootOnly((event, context) => [
    fact('session_end', spec(context, sessionEntity(context.stream), 'runtime', false), {
      reason: event.reason ?? null,
    }),
  ]),
)

const hookParsers: ReadonlyMap<string, HookParser> = new Map([
  ['SessionStart', sessionStart],
  ['UserPromptSubmit', userPromptSubmit],
  ['PreToolUse', preToolUse],
  ['PermissionRequest', permissionRequest],
  ['PostToolUse', postToolUse],
  ['PreCompact', compaction('started')],
  ['PostCompact', compaction('completed')],
  ['SubagentStart', subagentStart],
  ['SubagentStop', subagentStop],
  ['Stop', stop],
  ['Interrupt', interrupt],
  ['SessionEnd', sessionEnd],
])

const hookIds = (common: HookCommon): RuntimeIds => ({
  ...emptyIds,
  session_id: common.session_id,
  agent_id: common.agent_id ?? null,
  thread_id: common.agent_id ?? common.session_id,
  turn_id: common.turn_id ?? null,
})

const hookContext = (record: CollectedRecord, file: string, payload: HookObject, common: HookCommon): HookContext => {
  const env: RuntimeEnv = {
    ...emptyEnv,
    cwd: common.cwd ?? null,
    originator: record.hook?.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? null,
  }
  return {
    stream: { session: common.session_id, thread: common.agent_id ?? common.session_id },
    file,
    env,
    origin: {
      at: record.observed_at,
      ids: hookIds(common),
      env,
      redelivery: contentHash(canonicalJson(payload)),
    },
  }
}

const eventFacts = (record: CollectedRecord, file: string, payload: HookObject): HookFacts => {
  const common = HookCommon.safeParse(payload)
  const parser = common.success ? hookParsers.get(common.data.hook_event_name) : undefined
  return common.success && parser !== undefined ? parser(payload, hookContext(record, file, payload, common.data)) : null
}

export const parseHook = (record: CollectedRecord, file: string): ParseResult => {
  const value = JsonObject.safeParse(readJson(record.payload)).data
  if (value === undefined) {
    return { parse_state: 'invalid', reason: 'hook payload is not a JSON object' }
  }
  const payload = withinNestingLimit(value) ? HookObject.safeParse(value).data : undefined
  const facts = payload === undefined ? null : eventFacts(record, file, payload)
  return facts === null
    ? { parse_state: 'unknown', source_ts: null }
    : { parse_state: 'parsed', source_ts: null, facts }
}
