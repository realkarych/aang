import { z } from 'zod'
import { AgentRef, FactEntityKey, ServiceAgent } from './keys.js'
import { ContentHash, EpochNs, FactId, JsonValue, NormalizerVersion, RawSeq, Speaker, StreamKey } from './primitives.js'

const text = z.string()
const name = z.string().min(1)
const tokenCount = z.int().nonnegative()

export const Surface = z.enum([
  'claude_cli',
  'claude_desktop',
  'claude_sdk',
  'codex_tui',
  'codex_exec',
  'codex_desktop',
  'codex_sdk',
])
export type Surface = z.infer<typeof Surface>

export const SurfaceBasis = z.enum(['observed', 'assumed'])
export type SurfaceBasis = z.infer<typeof SurfaceBasis>

export const SurfaceClaim = z.strictObject({ surface: Surface, basis: SurfaceBasis })
export type SurfaceClaim = z.infer<typeof SurfaceClaim>

export const SessionLaunch = z.enum(['startup', 'resume', 'clear', 'fork', 'unknown'])
export type SessionLaunch = z.infer<typeof SessionLaunch>

export const TurnOutcome = z.enum(['completed', 'interrupted', 'failed', 'unknown'])
export type TurnOutcome = z.infer<typeof TurnOutcome>

export const PromptOrigin = z.enum(['human', 'task_notification', 'command', 'synthetic', 'unknown'])
export type PromptOrigin = z.infer<typeof PromptOrigin>

export const MessageAudience = z.enum(['user', 'agent'])
export type MessageAudience = z.infer<typeof MessageAudience>

export const AgentRole = z.enum(['main', 'subagent', 'teammate', 'service'])
export type AgentRole = z.infer<typeof AgentRole>

export const AgentOutcome = z.enum(['completed', 'failed', 'cancelled', 'unknown'])
export type AgentOutcome = z.infer<typeof AgentOutcome>

export const ActionKind = z.enum([
  'command',
  'file_read',
  'file_write',
  'search',
  'web',
  'mcp',
  'agent',
  'question',
  'plan',
  'code_cell',
  'other',
])
export type ActionKind = z.infer<typeof ActionKind>

export const ActionOutcome = z.enum(['ok', 'error', 'denied', 'interrupted', 'unknown'])
export type ActionOutcome = z.infer<typeof ActionOutcome>

export const PermissionDecision = z.enum([
  'approved',
  'approved_for_session',
  'approved_with_amendment',
  'denied',
  'aborted',
  'unknown',
])
export type PermissionDecision = z.infer<typeof PermissionDecision>

export const DecisionSource = z.enum(['user', 'config', 'automated_reviewer', 'unknown'])
export type DecisionSource = z.infer<typeof DecisionSource>

export const QuestionSource = z.enum([
  'ask_user_question',
  'exit_plan_mode',
  'elicitation',
  'notification',
  'agent_message',
])
export type QuestionSource = z.infer<typeof QuestionSource>

export const AnswerOutcome = z.enum(['answered', 'declined', 'cancelled'])
export type AnswerOutcome = z.infer<typeof AnswerOutcome>

export const PlanSource = z.enum(['task_tool', 'task_hook', 'exit_plan_mode', 'thread_goal', 'rollout_plan'])
export type PlanSource = z.infer<typeof PlanSource>

export const PlanItemStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled', 'unknown'])
export type PlanItemStatus = z.infer<typeof PlanItemStatus>

export const CompactionPhase = z.enum(['started', 'completed', 'boundary'])
export type CompactionPhase = z.infer<typeof CompactionPhase>

export const CompactionTrigger = z.enum(['manual', 'auto', 'unknown'])
export type CompactionTrigger = z.infer<typeof CompactionTrigger>

export const UsageTotalSource = z.enum(['token_count', 'thread_token_usage'])
export type UsageTotalSource = z.infer<typeof UsageTotalSource>

export const SnapshotTrigger = z.enum(['fs_watch', 'turn_end', 'restart', 'check'])
export type SnapshotTrigger = z.infer<typeof SnapshotTrigger>

export const HookOutcome = z.enum(['success', 'error', 'unknown'])
export type HookOutcome = z.infer<typeof HookOutcome>

export const HookOutputKind = z.enum(['stdout', 'stderr', 'additional_context', 'system_message'])
export type HookOutputKind = z.infer<typeof HookOutputKind>

export const DefinitionCatalog = z.enum(['agents', 'skills'])
export type DefinitionCatalog = z.infer<typeof DefinitionCatalog>

export const ContextSourceKind = z.enum([
  'task',
  'instructions',
  'agent_definition',
  'skill',
  'mcp_server',
  'hook',
  'git',
])
export type ContextSourceKind = z.infer<typeof ContextSourceKind>

export const TokenUsage = z.strictObject({
  uncached_input_tokens: tokenCount,
  cache_read_input_tokens: tokenCount,
  cache_write_input_tokens: tokenCount,
  output_tokens: tokenCount,
  reasoning_output_tokens: tokenCount.nullable(),
})
export type TokenUsage = z.infer<typeof TokenUsage>

export const BackgroundTask = z.strictObject({
  id: name,
  task_type: name,
  status: name,
  description: text.nullable(),
  agent_type: text.nullable(),
})
export type BackgroundTask = z.infer<typeof BackgroundTask>

export const RegistryEntry = z.strictObject({
  pid: z.int().positive(),
  session_id: name,
  kind: text.nullable(),
  entrypoint: text.nullable(),
  status: text.nullable(),
  waiting_for: text.nullable(),
  cwd: text.nullable(),
  version: text.nullable(),
  status_updated_at: EpochNs.nullable(),
})
export type RegistryEntry = z.infer<typeof RegistryEntry>

export const AgentMeta = z.strictObject({
  agent_type: text.nullable(),
  description: text.nullable(),
  tool_use_id: text.nullable(),
  spawn_depth: z.int().nonnegative().nullable(),
})
export type AgentMeta = z.infer<typeof AgentMeta>

export const TeamConfig = z.strictObject({
  team: name,
  members: z.array(
    z.strictObject({
      name,
      agent_id: text.nullable(),
      session_id: text.nullable(),
    }),
  ),
})
export type TeamConfig = z.infer<typeof TeamConfig>

export const SessionStartPayload = z.strictObject({
  launch: SessionLaunch,
  surface: SurfaceClaim.nullable(),
  cwd: text.nullable(),
  forked_from: z
    .strictObject({
      session: name,
      ordinal: z.int().nonnegative().nullable(),
    })
    .nullable(),
  observer_marker: z.boolean(),
})
export type SessionStartPayload = z.infer<typeof SessionStartPayload>

export const SessionEndPayload = z.strictObject({
  reason: text.nullable(),
})
export type SessionEndPayload = z.infer<typeof SessionEndPayload>

export const TurnStartPayload = z.strictObject({})
export type TurnStartPayload = z.infer<typeof TurnStartPayload>

export const TurnSettingsPayload = z.strictObject({
  model: text.nullable(),
  effort: text.nullable(),
  approval_policy: text.nullable(),
  sandbox: text.nullable(),
})
export type TurnSettingsPayload = z.infer<typeof TurnSettingsPayload>

export const TurnEndPayload = z.strictObject({
  outcome: TurnOutcome,
  reason: text.nullable(),
  final_message: text.nullable(),
  background_tasks: z.array(BackgroundTask),
})
export type TurnEndPayload = z.infer<typeof TurnEndPayload>

export const PromptPayload = z.strictObject({
  text,
  origin: PromptOrigin,
  origin_raw: text.nullable(),
})
export type PromptPayload = z.infer<typeof PromptPayload>

export const MessagePayload = z.strictObject({
  text,
  final: z.boolean(),
  audience: MessageAudience,
  model: text.nullable(),
})
export type MessagePayload = z.infer<typeof MessagePayload>

export const AgentStartPayload = z.strictObject({
  role: AgentRole,
  service: ServiceAgent.nullable(),
  agent_type: text.nullable(),
  agent_role: text.nullable(),
  description: text.nullable(),
  nickname: text.nullable(),
  parent: AgentRef.nullable(),
  spawned_by_call: text.nullable(),
  background: z.boolean().nullable(),
  depth: z.int().nonnegative().nullable(),
})
export type AgentStartPayload = z.infer<typeof AgentStartPayload>

export const AgentEndPayload = z.strictObject({
  outcome: AgentOutcome,
  final_message: text.nullable(),
  agent_type: text.nullable(),
  transcript_path: text.nullable(),
})
export type AgentEndPayload = z.infer<typeof AgentEndPayload>

export const ActionStartPayload = z.strictObject({
  tool: name,
  action_kind: ActionKind,
  input: JsonValue,
  description: text.nullable(),
  container_call: text.nullable(),
})
export type ActionStartPayload = z.infer<typeof ActionStartPayload>

export const ActionEndPayload = z.strictObject({
  outcome: ActionOutcome,
  output: text.nullable(),
  persisted_output_path: text.nullable(),
  exit_code: z.int().nullable(),
  duration_ms: z.int().nonnegative().nullable(),
  result: JsonValue.nullable(),
})
export type ActionEndPayload = z.infer<typeof ActionEndPayload>

export const ToolBatchEndPayload = z.strictObject({
  calls: z.array(
    z.strictObject({
      call_id: name,
      tool: name,
      response: text.nullable(),
    }),
  ),
})
export type ToolBatchEndPayload = z.infer<typeof ToolBatchEndPayload>

export const PermissionRequestPayload = z.strictObject({
  tool: name,
  input: JsonValue,
})
export type PermissionRequestPayload = z.infer<typeof PermissionRequestPayload>

export const PermissionDeniedPayload = z.strictObject({
  tool: name,
  reason: text.nullable(),
})
export type PermissionDeniedPayload = z.infer<typeof PermissionDeniedPayload>

export const PermissionDecisionPayload = z.strictObject({
  decision: PermissionDecision,
  source: DecisionSource,
  tool: text.nullable(),
})
export type PermissionDecisionPayload = z.infer<typeof PermissionDecisionPayload>

export const NotificationPayload = z.strictObject({
  notification_type: name,
  message: text.nullable(),
})
export type NotificationPayload = z.infer<typeof NotificationPayload>

export const QuestionAskedPayload = z.strictObject({
  source: QuestionSource,
  blocking: z.boolean(),
  questions: z.array(
    z.strictObject({
      header: text.nullable(),
      text,
      options: z.array(text),
    }),
  ),
})
export type QuestionAskedPayload = z.infer<typeof QuestionAskedPayload>

export const QuestionAnsweredPayload = z.strictObject({
  outcome: AnswerOutcome,
  answers: z.array(
    z.strictObject({
      question: text.nullable(),
      answer: text,
    }),
  ),
})
export type QuestionAnsweredPayload = z.infer<typeof QuestionAnsweredPayload>

export const PlanUpdatePayload = z.strictObject({
  source: PlanSource,
  text: text.nullable(),
  items: z.array(
    z.strictObject({
      id: text.nullable(),
      text,
      status: PlanItemStatus,
    }),
  ),
})
export type PlanUpdatePayload = z.infer<typeof PlanUpdatePayload>

export const CompactionPayload = z.strictObject({
  phase: CompactionPhase,
  trigger: CompactionTrigger,
  summary: text.nullable(),
  tokens_before: tokenCount.nullable(),
})
export type CompactionPayload = z.infer<typeof CompactionPayload>

export const UsagePayload = z.strictObject({
  model: text.nullable(),
  tokens: TokenUsage,
  stop_reason: text.nullable(),
  synthetic: z.boolean(),
})
export type UsagePayload = z.infer<typeof UsagePayload>

export const UsageTotalPayload = z.strictObject({
  source: UsageTotalSource,
  tokens: TokenUsage,
})
export type UsageTotalPayload = z.infer<typeof UsageTotalPayload>

export const CostStatePayload = z.strictObject({
  total_cost_usd: z.number().nonnegative().nullable(),
  total_duration_ms: z.int().nonnegative().nullable(),
  models: z.array(
    z.strictObject({
      model: name,
      tokens: TokenUsage,
      cost_usd: z.number().nonnegative().nullable(),
    }),
  ),
})
export type CostStatePayload = z.infer<typeof CostStatePayload>

export const InstructionsLoadedPayload = z.strictObject({
  path: name,
  memory_type: text.nullable(),
  load_reason: text.nullable(),
})
export type InstructionsLoadedPayload = z.infer<typeof InstructionsLoadedPayload>

export const HookRunPayload = z.strictObject({
  name: name.nullable(),
  event: name,
  trigger: text.nullable(),
  outcome: HookOutcome,
  output: z
    .strictObject({
      kind: HookOutputKind,
      text,
    })
    .nullable(),
})
export type HookRunPayload = z.infer<typeof HookRunPayload>

export const DefinitionListingPayload = z.strictObject({
  catalog: DefinitionCatalog,
  definitions: z.array(
    z.strictObject({
      name,
      description: text,
    }),
  ),
})
export type DefinitionListingPayload = z.infer<typeof DefinitionListingPayload>

export const QueueOperationPayload = z.strictObject({
  operation: name,
  content: text.nullable(),
})
export type QueueOperationPayload = z.infer<typeof QueueOperationPayload>

export const RuntimeErrorPayload = z.strictObject({
  message: text,
  code: text.nullable(),
})
export type RuntimeErrorPayload = z.infer<typeof RuntimeErrorPayload>

export const RuntimeEventPayload = z.strictObject({
  event: name,
  data: JsonValue,
})
export type RuntimeEventPayload = z.infer<typeof RuntimeEventPayload>

export const JsonSnapshotPayload = z.discriminatedUnion('file', [
  z.strictObject({ file: z.literal('registry'), path: name, removed: z.boolean(), content: RegistryEntry.nullable() }),
  z.strictObject({ file: z.literal('agent_meta'), path: name, removed: z.boolean(), content: AgentMeta.nullable() }),
  z.strictObject({ file: z.literal('team'), path: name, removed: z.boolean(), content: TeamConfig.nullable() }),
  z.strictObject({ file: z.literal('workflow'), path: name, removed: z.boolean(), content: JsonValue.nullable() }),
])
export type JsonSnapshotPayload = z.infer<typeof JsonSnapshotPayload>

export const GitSnapshotPayload = z.strictObject({
  worktree: name,
  trigger: SnapshotTrigger,
  masks: z.array(name),
  head: text.nullable(),
  entries: z.array(
    z.strictObject({
      status: name,
      path: name,
    }),
  ),
  clean: z.boolean(),
  error: text.nullable(),
})
export type GitSnapshotPayload = z.infer<typeof GitSnapshotPayload>

export const ContextPayload = z.strictObject({
  content_hash: ContentHash,
  sources: z.array(
    z.strictObject({
      kind: ContextSourceKind,
      ref: name,
    }),
  ),
})
export type ContextPayload = z.infer<typeof ContextPayload>

export const SourceLostPayload = z.strictObject({
  path: name,
  stream: StreamKey,
})
export type SourceLostPayload = z.infer<typeof SourceLostPayload>

export const factPayloads = {
  session_start: SessionStartPayload,
  session_end: SessionEndPayload,
  turn_start: TurnStartPayload,
  turn_settings: TurnSettingsPayload,
  turn_end: TurnEndPayload,
  prompt: PromptPayload,
  message: MessagePayload,
  agent_start: AgentStartPayload,
  agent_end: AgentEndPayload,
  action_start: ActionStartPayload,
  action_end: ActionEndPayload,
  tool_batch_end: ToolBatchEndPayload,
  permission_request: PermissionRequestPayload,
  permission_denied: PermissionDeniedPayload,
  permission_decision: PermissionDecisionPayload,
  notification: NotificationPayload,
  question_asked: QuestionAskedPayload,
  question_answered: QuestionAnsweredPayload,
  plan_update: PlanUpdatePayload,
  compaction: CompactionPayload,
  usage: UsagePayload,
  usage_total: UsageTotalPayload,
  cost_state: CostStatePayload,
  instructions_loaded: InstructionsLoadedPayload,
  hook_run: HookRunPayload,
  definition_listing: DefinitionListingPayload,
  queue_operation: QueueOperationPayload,
  runtime_error: RuntimeErrorPayload,
  runtime_event: RuntimeEventPayload,
  json_snapshot: JsonSnapshotPayload,
  git_snapshot: GitSnapshotPayload,
  context: ContextPayload,
  source_lost: SourceLostPayload,
} as const

export const RuntimeIds = z.strictObject({
  session_id: text.nullable(),
  agent_id: text.nullable(),
  thread_id: text.nullable(),
  turn_id: text.nullable(),
  prompt_id: text.nullable(),
  record_uuid: text.nullable(),
  parent_uuid: text.nullable(),
  message_id: text.nullable(),
  call_id: text.nullable(),
  ordinal: z.int().nonnegative().nullable(),
})
export type RuntimeIds = z.infer<typeof RuntimeIds>

export const RuntimeEnv = z.strictObject({
  cwd: text.nullable(),
  version: text.nullable(),
  entrypoint: text.nullable(),
  originator: text.nullable(),
  git_branch: text.nullable(),
})
export type RuntimeEnv = z.infer<typeof RuntimeEnv>

const draftShape = {
  entity_key: FactEntityKey,
  speaker: Speaker,
  urgent: z.boolean(),
  at: EpochNs,
  runtime_ids: RuntimeIds,
  runtime_env: RuntimeEnv,
  format_verified: z.boolean(),
  redelivery_key: name.nullable(),
}

const storedShape = {
  id: FactId,
  seq: RawSeq,
  normalizer_version: NormalizerVersion,
  ...draftShape,
}

const variant = <K extends keyof typeof factPayloads, S extends z.core.$ZodLooseShape>(kind: K, shape: S) =>
  z.strictObject({ ...shape, kind: z.literal(kind), payload: factPayloads[kind] })

const variantsWith = <S extends z.core.$ZodLooseShape>(shape: S) =>
  [
    variant('session_start', shape),
    variant('session_end', shape),
    variant('turn_start', shape),
    variant('turn_settings', shape),
    variant('turn_end', shape),
    variant('prompt', shape),
    variant('message', shape),
    variant('agent_start', shape),
    variant('agent_end', shape),
    variant('action_start', shape),
    variant('action_end', shape),
    variant('tool_batch_end', shape),
    variant('permission_request', shape),
    variant('permission_denied', shape),
    variant('permission_decision', shape),
    variant('notification', shape),
    variant('question_asked', shape),
    variant('question_answered', shape),
    variant('plan_update', shape),
    variant('compaction', shape),
    variant('usage', shape),
    variant('usage_total', shape),
    variant('cost_state', shape),
    variant('instructions_loaded', shape),
    variant('hook_run', shape),
    variant('definition_listing', shape),
    variant('queue_operation', shape),
    variant('runtime_error', shape),
    variant('runtime_event', shape),
    variant('json_snapshot', shape),
    variant('git_snapshot', shape),
    variant('context', shape),
    variant('source_lost', shape),
  ] as const

export const FactDraft = z.discriminatedUnion('kind', variantsWith(draftShape))
export type FactDraft = z.infer<typeof FactDraft>

export const Fact = z.discriminatedUnion('kind', variantsWith(storedShape))
export type Fact = z.infer<typeof Fact>

export const FactKind = z.enum(FactDraft.options.map((option) => option.shape.kind.value))
export type FactKind = z.infer<typeof FactKind>

export type FactPayload<K extends FactKind> = z.infer<(typeof factPayloads)[K]>

export type FactOf<K extends FactKind> = Extract<Fact, { kind: K }>
export type FactDraftOf<K extends FactKind> = Extract<FactDraft, { kind: K }>
