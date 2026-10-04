import { z } from 'zod'
import { Execution } from './axes.js'
import { ChatMessage } from './chat.js'
import { ActionOutcome, CostStatePayload, Fact, TokenUsage } from './facts.js'
import { ModelChange } from './journal.js'
import { AttentionItem, AttentionKind, Binding, Card, Criterion, Link, Run, Stage } from './model.js'
import {
  Action,
  Agent,
  ArtifactVersion,
  Freshness,
  Gap,
  GitSnapshot,
  Question,
  Session,
  SupportMode,
  UsageRecord,
} from './observation.js'
import { Admission, ObserverCall, ObserverRunState, ObserverState } from './observer-state.js'
import {
  AgentId,
  ArtifactVersionId,
  AttentionItemId,
  BindingId,
  ChangeSeq,
  EpochNs,
  FactId,
  ModelVersion,
  RawSeq,
  RunId,
  Runtime,
  SessionId,
  StageId,
  ViewRuleId,
} from './primitives.js'
import { RawRecord } from './raw.js'
import { SupportKey, SupportStatus } from './support.js'
import {
  AppliedViewRule,
  AttentionPlace,
  AttentionView,
  DetailLevel,
  ViewElement,
  ViewMark,
  ViewRule,
  ViewRuleSpec,
} from './view.js'

const text = z.string()
const name = z.string().min(1)
const count = z.int().nonnegative()
const empty = z.strictObject({})

const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/)

export const ModelVersionText = z.codec(decimal, ModelVersion, {
  decode: (value) => Number(value),
  encode: (value) => String(value),
})

export const ChangeSeqText = z.codec(decimal, ChangeSeq, {
  decode: (value) => Number(value),
  encode: (value) => String(value),
})

export const RawSeqText = z.codec(decimal, RawSeq, {
  decode: (value) => Number(value),
  encode: (value) => String(value),
})

export const ApiErrorCode = z.enum([
  'unauthorized',
  'not_found',
  'invalid_request',
  'conflict',
  'unavailable',
  'internal',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCode>

export const ApiError = z.strictObject({
  error: z.strictObject({
    code: ApiErrorCode,
    message: text,
  }),
})
export type ApiError = z.infer<typeof ApiError>

export const Listener = z.strictObject({
  host: name,
  port: z.int().min(0).max(65_535),
})
export type Listener = z.infer<typeof Listener>

export const HookInstallation = z.enum(['not_installed', 'untrusted', 'active', 'unknown'])
export type HookInstallation = z.infer<typeof HookInstallation>

export const RuntimeStatus = z.strictObject({
  runtime: Runtime,
  root: name,
  root_exists: z.boolean(),
  hooks: HookInstallation,
  hooks_inactive_sessions: z.array(SessionId),
  double_registration_sessions: z.array(SessionId),
})
export type RuntimeStatus = z.infer<typeof RuntimeStatus>

export const SpoolStatus = z.strictObject({
  files: count,
  bytes: count,
  lease_expires_at: EpochNs.nullable(),
  stopped: z.boolean(),
  threshold_bytes: count,
  over_threshold: z.boolean(),
  growth_since_threshold_bytes: count.nullable(),
})
export type SpoolStatus = z.infer<typeof SpoolStatus>

export const ObserverBackendStatus = z.strictObject({
  vendor: Runtime,
  state: ObserverState,
  cli_path: name.nullable(),
  cli_version: name.nullable(),
  model: name,
  effort: name.nullable(),
  admission: Admission.nullable(),
})
export type ObserverBackendStatus = z.infer<typeof ObserverBackendStatus>

export const VersionStatus = z.strictObject({
  key: SupportKey,
  status: SupportStatus,
  sessions: count,
  last_seen_at: EpochNs,
})
export type VersionStatus = z.infer<typeof VersionStatus>

export const NotObservableSurface = z.enum(['claude_cowork', 'claude_cloud', 'codex_cloud', 'work_cloud'])
export type NotObservableSurface = z.infer<typeof NotObservableSurface>

export const WatchState = z.strictObject({
  all: z.boolean(),
  lookback_days: z.int().positive(),
  roots: z.array(name),
})
export type WatchState = z.infer<typeof WatchState>

export const StatusResponse = z.strictObject({
  daemon: z.strictObject({
    version: name,
    pid: z.int().positive(),
    started_at: EpochNs,
    api: Listener,
    otel: Listener,
  }),
  database: z.strictObject({
    path: name,
    size_bytes: count,
    schema_version: count,
    change_seq: ChangeSeq,
  }),
  runtimes: z.array(RuntimeStatus),
  watch: WatchState,
  spool: SpoolStatus,
  observer: z.strictObject({
    cross_vendor: z.boolean(),
    backends: z.array(ObserverBackendStatus),
  }),
  versions: z.array(VersionStatus),
  unknown_records: count,
  gaps: z.array(Gap),
  not_observable: z.array(NotObservableSurface),
})
export type StatusResponse = z.infer<typeof StatusResponse>

export const AttentionCounts = z.strictObject({
  open: count,
  waiting_for_human: count,
  by_kind: z.record(AttentionKind, count),
})
export type AttentionCounts = z.infer<typeof AttentionCounts>

export const RunSummary = z.strictObject({
  id: RunId,
  runtime: Runtime,
  root_session: SessionId,
  goal: text.nullable(),
  brief: text.nullable(),
  version: ModelVersion,
  execution: Execution,
  freshness: Freshness,
  support_modes: z.array(SupportMode),
  sessions: count,
  agents: count,
  attention: AttentionCounts,
  observer: ObserverRunState,
  forked_from: RunId.nullable(),
  start_pruned: z.boolean(),
  created_at: EpochNs,
  last_event_at: EpochNs,
  change_seq: ChangeSeq,
})
export type RunSummary = z.infer<typeof RunSummary>

export const RunsResponse = z.strictObject({
  runs: z.array(RunSummary),
  change_seq: ChangeSeq,
})
export type RunsResponse = z.infer<typeof RunsResponse>

export const ObservationObjects = z.strictObject({
  sessions: z.array(Session),
  agents: z.array(Agent),
  actions: z.array(Action),
  questions: z.array(Question),
  artifact_versions: z.array(ArtifactVersion),
  git_snapshots: z.array(GitSnapshot),
  usage_records: z.array(UsageRecord),
  gaps: z.array(Gap),
})
export type ObservationObjects = z.infer<typeof ObservationObjects>

export const SemanticModel = z.strictObject({
  stages: z.array(Stage),
  criteria: z.array(Criterion),
  cards: z.array(Card),
  links: z.array(Link),
})
export type SemanticModel = z.infer<typeof SemanticModel>

export const AttentionState = z.strictObject({
  items: z.array(AttentionItem),
  views: z.array(AttentionView),
})
export type AttentionState = z.infer<typeof AttentionState>

export const UsageTotals = z.strictObject({
  tokens: TokenUsage,
  records: count,
  output_lower_bound: z.boolean(),
  cost_usd: z.number().nonnegative().nullable(),
})
export type UsageTotals = z.infer<typeof UsageTotals>

export const ViewTotals = z.strictObject({
  agents: count,
  actions: count,
  running_actions: count,
  outcomes: z.record(ActionOutcome, count),
  usage: UsageTotals.nullable(),
  outputs: z.array(ArtifactVersionId),
})
export type ViewTotals = z.infer<typeof ViewTotals>

export const ViewVisibility = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('collapsed'), rule: ViewRuleId.nullable(), totals: ViewTotals }),
  z.strictObject({ state: z.literal('hidden'), rule: ViewRuleId.nullable() }),
])
export type ViewVisibility = z.infer<typeof ViewVisibility>

export const ViewPlacement = z.strictObject({
  element: ViewElement,
  visibility: ViewVisibility.nullable(),
  group: z.strictObject({ name, rule: ViewRuleId }).nullable(),
  detail: z.strictObject({ level: DetailLevel, rule: ViewRuleId }).nullable(),
  attention: z.array(AttentionItemId),
})
export type ViewPlacement = z.infer<typeof ViewPlacement>

export const RunView = z.strictObject({
  rules: z.array(AppliedViewRule),
  placements: z.array(ViewPlacement),
  mark: ViewMark.nullable(),
  zone: z.array(AttentionPlace),
})
export type RunView = z.infer<typeof RunView>

export const RunSnapshot = z.strictObject({
  run: Run,
  summary: RunSummary,
  model: SemanticModel,
  objects: ObservationObjects,
  plan_facts: z.array(Fact),
  attention: AttentionState,
  view: RunView,
  bindings: z.array(Binding),
  change_seq: ChangeSeq,
})
export type RunSnapshot = z.infer<typeof RunSnapshot>

export const StageArtifact = z.strictObject({
  link: Link,
  version: ArtifactVersion,
})
export type StageArtifact = z.infer<typeof StageArtifact>

export const CheckedCriterion = z.strictObject({
  criterion: Criterion,
  snapshots: z.array(GitSnapshot),
})
export type CheckedCriterion = z.infer<typeof CheckedCriterion>

export const StageInspector = z.strictObject({
  run: RunId,
  stage: Stage,
  children: z.array(StageId),
  predecessors: z.array(StageId),
  successors: z.array(StageId),
  agents: z.array(Agent),
  actions: z.array(Action),
  inputs: z.array(StageArtifact),
  outputs: z.array(StageArtifact),
  dependencies: z.array(Link),
  criteria: z.array(CheckedCriterion),
  attention: z.array(AttentionItem),
  time: z.strictObject({
    started_at: EpochNs.nullable(),
    ended_at: EpochNs.nullable(),
    active_ms: count.nullable(),
  }),
  usage: z.strictObject({
    stage: UsageTotals,
    unassigned_in_sessions: UsageTotals,
  }),
  evidence: z.array(Fact),
  history: z.array(ModelChange),
  observer_calls: z.array(ObserverCall),
  change_seq: ChangeSeq,
})
export type StageInspector = z.infer<typeof StageInspector>

export const ChangesQuery = z.strictObject({
  version: ModelVersionText,
  seq: ChangeSeqText,
})
export type ChangesQuery = z.infer<typeof ChangesQuery>

export const ModelChangeRef = z.strictObject({
  version: ModelVersion,
  index: count,
})
export type ModelChangeRef = z.infer<typeof ModelChangeRef>

const transition = <T extends z.ZodType>(entity: T) =>
  z.strictObject({
    before: entity.nullable(),
    after: entity,
    changes: z.array(ModelChangeRef),
  })

export const StageTransition = transition(Stage)
export type StageTransition = z.infer<typeof StageTransition>

export const CriterionTransition = transition(Criterion)
export type CriterionTransition = z.infer<typeof CriterionTransition>

export const ToolCount = z.strictObject({
  tool: name,
  count,
})
export type ToolCount = z.infer<typeof ToolCount>

export const AgentActivity = z.strictObject({
  agent: AgentId.nullable(),
  actions: count,
  tools: z.array(ToolCount),
})
export type AgentActivity = z.infer<typeof AgentActivity>

export const ViewPosition = z.strictObject({
  version: ModelVersion,
  change_seq: ChangeSeq,
})
export type ViewPosition = z.infer<typeof ViewPosition>

export const ChangesResponse = z.strictObject({
  run: RunId,
  from: ViewPosition,
  to: ViewPosition,
  stages: z.array(StageTransition),
  criteria: z.array(CriterionTransition),
  cards: z.array(Card),
  plan_facts: z.array(Fact),
  artifact_versions: z.array(ArtifactVersion),
  attention: z.strictObject({
    opened: z.array(AttentionItem),
    closed: z.array(AttentionItem),
  }),
  activity: z.array(AgentActivity),
})
export type ChangesResponse = z.infer<typeof ChangesResponse>

export const ObserverCallsResponse = z.strictObject({
  calls: z.array(ObserverCall),
})
export type ObserverCallsResponse = z.infer<typeof ObserverCallsResponse>

export const FactResponse = z.strictObject({
  fact: Fact,
})
export type FactResponse = z.infer<typeof FactResponse>

export const RawRecordResponse = z.strictObject({
  raw: RawRecord,
})
export type RawRecordResponse = z.infer<typeof RawRecordResponse>

export const MarkViewedRequest = ViewPosition
export type MarkViewedRequest = z.infer<typeof MarkViewedRequest>

export const MarkViewedResponse = z.strictObject({
  mark: ViewMark,
})
export type MarkViewedResponse = z.infer<typeof MarkViewedResponse>

export const AttentionViewResponse = z.strictObject({
  view: AttentionView,
})
export type AttentionViewResponse = z.infer<typeof AttentionViewResponse>

export const ArtifactContent = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stored'),
    source: z.enum(['action_payload', 'file_read', 'commit']),
    encoding: z.enum(['utf8', 'base64']),
    data: text,
    size_bytes: count,
    read_at: EpochNs.nullable(),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.enum(['reference_only', 'hash_only', 'commit_missing', 'blob_missing']),
  }),
])
export type ArtifactContent = z.infer<typeof ArtifactContent>

export const ArtifactVersionResponse = z.strictObject({
  version: ArtifactVersion,
  content: ArtifactContent,
})
export type ArtifactVersionResponse = z.infer<typeof ArtifactVersionResponse>

export const ChatHistoryResponse = z.strictObject({
  messages: z.array(ChatMessage),
})
export type ChatHistoryResponse = z.infer<typeof ChatHistoryResponse>

export const ChatQuestionRequest = z.strictObject({
  question: name,
  stage: StageId.nullable(),
})
export type ChatQuestionRequest = z.infer<typeof ChatQuestionRequest>

export const ChatQuestionResponse = z.strictObject({
  message: ChatMessage,
})
export type ChatQuestionResponse = z.infer<typeof ChatQuestionResponse>

export const CreateViewRuleRequest = ViewRuleSpec
export type CreateViewRuleRequest = z.infer<typeof CreateViewRuleRequest>

export const CreateViewRuleResponse = z.strictObject({
  rule: AppliedViewRule,
})
export type CreateViewRuleResponse = z.infer<typeof CreateViewRuleResponse>

export const RevokeViewRuleResponse = z.strictObject({
  rule: ViewRule,
})
export type RevokeViewRuleResponse = z.infer<typeof RevokeViewRuleResponse>

export const CreateBindingRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attach'), session: SessionId, run: RunId }),
  z.strictObject({ kind: z.literal('detach'), session: SessionId }),
  z.strictObject({ kind: z.literal('fork_parent'), run: RunId, parent: SessionId }),
])
export type CreateBindingRequest = z.infer<typeof CreateBindingRequest>

export const BindingResponse = z.strictObject({
  binding: Binding,
})
export type BindingResponse = z.infer<typeof BindingResponse>

export const WatchRequest = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('path'), path: name, lookback_days: z.int().positive().nullable() }),
  z.strictObject({ scope: z.literal('all'), lookback_days: z.int().positive().nullable() }),
])
export type WatchRequest = z.infer<typeof WatchRequest>

export const WatchResponse = z.strictObject({
  watch: WatchState,
  rescanned_streams: count,
})
export type WatchResponse = z.infer<typeof WatchResponse>

export const UnwatchRequest = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('path'), path: name }),
  z.strictObject({ scope: z.literal('all') }),
])
export type UnwatchRequest = z.infer<typeof UnwatchRequest>

export const UnwatchResponse = z.strictObject({
  watch: WatchState,
})
export type UnwatchResponse = z.infer<typeof UnwatchResponse>

export const PruneRequest = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('run'), run: RunId }),
  z.strictObject({ scope: z.literal('before'), before: EpochNs }),
])
export type PruneRequest = z.infer<typeof PruneRequest>

export const PruneResponse = z.strictObject({
  runs: z.array(RunId),
  streams: count,
})
export type PruneResponse = z.infer<typeof PruneResponse>

export const ReparseResponse = z.strictObject({
  records: count,
  facts_added: count,
  facts_kept: count,
  facts_missing: count,
})
export type ReparseResponse = z.infer<typeof ReparseResponse>

export const UsageQuery = z.strictObject({
  run: RunId.optional(),
  from: EpochNs.optional(),
  to: EpochNs.optional(),
})
export type UsageQuery = z.infer<typeof UsageQuery>

export const CallsUsage = z.strictObject({
  calls: count,
  probes: count,
  totals: UsageTotals,
  latency_ms: z
    .strictObject({
      p50: count,
      p95: count,
      max: count,
    })
    .nullable(),
})
export type CallsUsage = z.infer<typeof CallsUsage>

export const SessionUsage = z.strictObject({
  session: SessionId,
  totals: UsageTotals,
  cost_state: CostStatePayload.nullable(),
  cost_state_final: z.boolean(),
})
export type SessionUsage = z.infer<typeof SessionUsage>

export const RunUsage = z.strictObject({
  run: RunId,
  solver: z.strictObject({
    totals: UsageTotals,
    stages: z.array(z.strictObject({ stage: StageId, totals: UsageTotals })),
    unassigned: UsageTotals,
    sessions: z.array(SessionUsage),
  }),
  observer: CallsUsage,
  chat: CallsUsage,
  duration_ms: count,
  active_hours: count,
})
export type RunUsage = z.infer<typeof RunUsage>

export const JournalTotals = z.strictObject({
  solver: UsageTotals,
  observer: UsageTotals,
  chat: UsageTotals,
})
export type JournalTotals = z.infer<typeof JournalTotals>

const rate = z.number().nonnegative()

export const TokenUsageRate = z.strictObject({
  uncached_input_tokens: rate,
  cache_read_input_tokens: rate,
  cache_write_input_tokens: rate,
  output_tokens: rate,
  reasoning_output_tokens: rate.nullable(),
})
export type TokenUsageRate = z.infer<typeof TokenUsageRate>

export const UsageRate = z.strictObject({
  tokens: TokenUsageRate,
  records: rate,
  output_lower_bound: z.boolean(),
  cost_usd: rate.nullable(),
})
export type UsageRate = z.infer<typeof UsageRate>

export const JournalRates = z.strictObject({
  solver: UsageRate,
  observer: UsageRate,
  chat: UsageRate,
})
export type JournalRates = z.infer<typeof JournalRates>

export const UsageReport = z.strictObject({
  from: EpochNs.nullable(),
  to: EpochNs.nullable(),
  runs: z.array(RunUsage),
  totals: JournalTotals,
  active_hours: count,
  per_active_hour: JournalRates.nullable(),
})
export type UsageReport = z.infer<typeof UsageReport>

export const DoctorRequest = z.strictObject({
  admit: z.boolean(),
})
export type DoctorRequest = z.infer<typeof DoctorRequest>

export const DoctorCheck = z.strictObject({
  id: name,
  status: z.enum(['ok', 'warning', 'error']),
  message: text,
})
export type DoctorCheck = z.infer<typeof DoctorCheck>

export const DoctorReport = z.strictObject({
  runtimes: z.array(RuntimeStatus),
  versions: z.array(VersionStatus),
  observer: z.array(ObserverBackendStatus),
  otel_exporter_conflict: z.boolean(),
  checks: z.array(DoctorCheck),
})
export type DoctorReport = z.infer<typeof DoctorReport>

export const OtelConfigRequest = z.strictObject({
  rotate: z.boolean(),
})
export type OtelConfigRequest = z.infer<typeof OtelConfigRequest>

export const OtelConfigResponse = z.strictObject({
  endpoint: name,
})
export type OtelConfigResponse = z.infer<typeof OtelConfigResponse>

export const ShutdownResponse = z.strictObject({
  stopping: z.literal(true),
})
export type ShutdownResponse = z.infer<typeof ShutdownResponse>

const runParams = z.strictObject({ run: RunId })

export interface EndpointSpec {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: `/api/${string}`
  readonly params: z.ZodType | null
  readonly query: z.ZodType | null
  readonly body: z.ZodType | null
  readonly response: z.ZodType
}

export const endpoints = {
  status: {
    method: 'GET',
    path: '/api/status',
    params: null,
    query: null,
    body: null,
    response: StatusResponse,
  },
  runs: {
    method: 'GET',
    path: '/api/runs',
    params: null,
    query: null,
    body: null,
    response: RunsResponse,
  },
  run: {
    method: 'GET',
    path: '/api/runs/:run',
    params: runParams,
    query: null,
    body: null,
    response: RunSnapshot,
  },
  stage: {
    method: 'GET',
    path: '/api/runs/:run/stages/:stage',
    params: z.strictObject({ run: RunId, stage: StageId }),
    query: null,
    body: null,
    response: StageInspector,
  },
  changes: {
    method: 'GET',
    path: '/api/runs/:run/changes',
    params: runParams,
    query: ChangesQuery,
    body: null,
    response: ChangesResponse,
  },
  observerCalls: {
    method: 'GET',
    path: '/api/runs/:run/observer-calls',
    params: runParams,
    query: null,
    body: null,
    response: ObserverCallsResponse,
  },
  fact: {
    method: 'GET',
    path: '/api/facts/:id',
    params: z.strictObject({ id: FactId }),
    query: null,
    body: null,
    response: FactResponse,
  },
  raw: {
    method: 'GET',
    path: '/api/raw/:seq',
    params: z.strictObject({ seq: RawSeqText }),
    query: null,
    body: null,
    response: RawRecordResponse,
  },
  markViewed: {
    method: 'POST',
    path: '/api/runs/:run/viewed',
    params: runParams,
    query: null,
    body: MarkViewedRequest,
    response: MarkViewedResponse,
  },
  attentionViewed: {
    method: 'POST',
    path: '/api/runs/:run/attention/:item/viewed',
    params: z.strictObject({ run: RunId, item: AttentionItemId }),
    query: null,
    body: empty,
    response: AttentionViewResponse,
  },
  attentionDismiss: {
    method: 'POST',
    path: '/api/runs/:run/attention/:item/dismiss',
    params: z.strictObject({ run: RunId, item: AttentionItemId }),
    query: null,
    body: empty,
    response: AttentionViewResponse,
  },
  artifactVersion: {
    method: 'GET',
    path: '/api/artifact-versions/:id',
    params: z.strictObject({ id: ArtifactVersionId }),
    query: null,
    body: null,
    response: ArtifactVersionResponse,
  },
  chatHistory: {
    method: 'GET',
    path: '/api/runs/:run/chat',
    params: runParams,
    query: null,
    body: null,
    response: ChatHistoryResponse,
  },
  chatQuestion: {
    method: 'POST',
    path: '/api/runs/:run/chat',
    params: runParams,
    query: null,
    body: ChatQuestionRequest,
    response: ChatQuestionResponse,
  },
  createViewRule: {
    method: 'POST',
    path: '/api/runs/:run/view-rules',
    params: runParams,
    query: null,
    body: CreateViewRuleRequest,
    response: CreateViewRuleResponse,
  },
  revokeViewRule: {
    method: 'DELETE',
    path: '/api/runs/:run/view-rules/:id',
    params: z.strictObject({ run: RunId, id: ViewRuleId }),
    query: null,
    body: null,
    response: RevokeViewRuleResponse,
  },
  createBinding: {
    method: 'POST',
    path: '/api/bindings',
    params: null,
    query: null,
    body: CreateBindingRequest,
    response: BindingResponse,
  },
  revokeBinding: {
    method: 'DELETE',
    path: '/api/bindings/:id',
    params: z.strictObject({ id: BindingId }),
    query: null,
    body: null,
    response: BindingResponse,
  },
  watch: {
    method: 'POST',
    path: '/api/admin/watch',
    params: null,
    query: null,
    body: WatchRequest,
    response: WatchResponse,
  },
  unwatch: {
    method: 'POST',
    path: '/api/admin/unwatch',
    params: null,
    query: null,
    body: UnwatchRequest,
    response: UnwatchResponse,
  },
  prune: {
    method: 'POST',
    path: '/api/admin/prune',
    params: null,
    query: null,
    body: PruneRequest,
    response: PruneResponse,
  },
  reparse: {
    method: 'POST',
    path: '/api/admin/reparse',
    params: null,
    query: null,
    body: empty,
    response: ReparseResponse,
  },
  usage: {
    method: 'GET',
    path: '/api/admin/usage',
    params: null,
    query: UsageQuery,
    body: null,
    response: UsageReport,
  },
  doctor: {
    method: 'POST',
    path: '/api/admin/doctor',
    params: null,
    query: null,
    body: DoctorRequest,
    response: DoctorReport,
  },
  otelConfig: {
    method: 'POST',
    path: '/api/admin/otel-config',
    params: null,
    query: null,
    body: OtelConfigRequest,
    response: OtelConfigResponse,
  },
  shutdown: {
    method: 'POST',
    path: '/api/admin/shutdown',
    params: null,
    query: null,
    body: empty,
    response: ShutdownResponse,
  },
} as const satisfies Record<string, EndpointSpec>
export type EndpointName = keyof typeof endpoints
