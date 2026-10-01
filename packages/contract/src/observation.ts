import { z } from 'zod'
import { assessed, Basis, Execution, HumanDecision } from './axes.js'
import {
  ActionKind,
  ActionOutcome,
  AgentRole,
  CostStatePayload,
  QuestionSource,
  SessionLaunch,
  SnapshotTrigger,
  SurfaceClaim,
  TokenUsage,
} from './facts.js'
import {
  ActionKey,
  AgentKey,
  ArtifactRef,
  ArtifactVersionKey,
  GapKey,
  GapKind,
  GitSnapshotKey,
  QuestionKey,
  ServiceAgent,
  SessionKey,
  UsageKey,
} from './keys.js'
import {
  ActionId,
  AgentId,
  ArtifactId,
  ArtifactVersionId,
  ChangeSeq,
  ContentHash,
  EpochNs,
  FactId,
  GapId,
  GitSnapshotId,
  QuestionId,
  RunId,
  SessionId,
  StreamKey,
  UsageRecordId,
} from './primitives.js'

const text = z.string()
const name = z.string().min(1)

export const SupportMode = z.enum(['full', 'files_only', 'hooks_only'])
export type SupportMode = z.infer<typeof SupportMode>

export const Freshness = z.enum(['ok', 'quiet', 'lost', 'hooks_inactive'])
export type Freshness = z.infer<typeof Freshness>

export const SessionState = z.enum(['turn_running', 'turn_done', 'ended', 'unknown'])
export type SessionState = z.infer<typeof SessionState>

export const SessionLaunchRecord = z.strictObject({
  launch: SessionLaunch,
  at: EpochNs,
  fact: FactId,
})
export type SessionLaunchRecord = z.infer<typeof SessionLaunchRecord>

export const Session = z.strictObject({
  id: SessionId,
  key: SessionKey,
  run: RunId.nullable(),
  surface: SurfaceClaim.nullable(),
  version: text.nullable(),
  cwd: text.nullable(),
  git_branch: text.nullable(),
  git_common_dir: text.nullable(),
  launches: z.array(SessionLaunchRecord),
  state: SessionState,
  execution: Execution,
  freshness: Freshness,
  support_mode: SupportMode,
  double_registration: z.boolean(),
  unknown_records: z.int().nonnegative(),
  cost_state: CostStatePayload.nullable(),
  started_at: EpochNs,
  last_event_at: EpochNs,
  change_seq: ChangeSeq,
})
export type Session = z.infer<typeof Session>

export const Agent = z.strictObject({
  id: AgentId,
  key: AgentKey,
  session: SessionId,
  run: RunId.nullable(),
  role: AgentRole,
  service: ServiceAgent.nullable(),
  agent_type: text.nullable(),
  agent_role: text.nullable(),
  name: text.nullable(),
  description: text.nullable(),
  parent: AgentId.nullable(),
  spawned_by: ActionId.nullable(),
  execution: Execution,
  thread_total: TokenUsage.nullable(),
  started_at: EpochNs.nullable(),
  ended_at: EpochNs.nullable(),
  change_seq: ChangeSeq,
})
export type Agent = z.infer<typeof Agent>

export const Action = z.strictObject({
  id: ActionId,
  key: ActionKey,
  session: SessionId,
  agent: AgentId.nullable(),
  run: RunId.nullable(),
  tool: name,
  action_kind: ActionKind,
  container: ActionId.nullable(),
  is_container: z.boolean(),
  started_at: EpochNs.nullable(),
  ended_at: EpochNs.nullable(),
  outcome: assessed(ActionOutcome).nullable(),
  execution: Execution,
  input_fact: FactId.nullable(),
  output_fact: FactId.nullable(),
  inherited: z.boolean(),
  change_seq: ChangeSeq,
})
export type Action = z.infer<typeof Action>

export const QuestionKind = z.enum(['permission', ...QuestionSource.options])
export type QuestionKind = z.infer<typeof QuestionKind>

export const QuestionActionLink = z.strictObject({
  action: ActionId,
  ambiguous: z.boolean(),
  basis: Basis,
})
export type QuestionActionLink = z.infer<typeof QuestionActionLink>

export const Question = z.strictObject({
  id: QuestionId,
  key: QuestionKey,
  session: SessionId,
  agent: AgentId.nullable(),
  run: RunId.nullable(),
  kind: QuestionKind,
  blocking: z.boolean(),
  text: text.nullable(),
  asked_at: EpochNs,
  answered_at: EpochNs.nullable(),
  action: QuestionActionLink.nullable(),
  decision: assessed(HumanDecision),
  redelivery_group: QuestionId.nullable(),
  change_seq: ChangeSeq,
})
export type Question = z.infer<typeof Question>

export const VersionRetention = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('action_payload'), blob: ContentHash, action: ActionId }),
  z.strictObject({ kind: z.literal('file_read'), blob: ContentHash, read_at: EpochNs }),
  z.strictObject({ kind: z.literal('commit'), repository: name, sha: name }),
  z.strictObject({ kind: z.literal('hash_only'), content_hash: ContentHash, size_bytes: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal('reference') }),
])
export type VersionRetention = z.infer<typeof VersionRetention>

export const ArtifactVersion = z.strictObject({
  id: ArtifactVersionId,
  key: ArtifactVersionKey,
  run: RunId,
  artifact: ArtifactId,
  ref: ArtifactRef,
  retention: VersionRetention,
  produced_by: ActionId.nullable(),
  observed_at: EpochNs,
  change_seq: ChangeSeq,
})
export type ArtifactVersion = z.infer<typeof ArtifactVersion>

export const GitSnapshot = z.strictObject({
  id: GitSnapshotId,
  key: GitSnapshotKey,
  run: RunId,
  worktree: name,
  trigger: SnapshotTrigger,
  masks: z.array(name),
  head: text.nullable(),
  clean: z.boolean(),
  taken_at: EpochNs,
  fact: FactId,
  change_seq: ChangeSeq,
})
export type GitSnapshot = z.infer<typeof GitSnapshot>

export const UsageRecord = z.strictObject({
  id: UsageRecordId,
  key: UsageKey,
  session: SessionId,
  agent: AgentId.nullable(),
  run: RunId.nullable(),
  model: text.nullable(),
  tokens: TokenUsage,
  output_lower_bound: z.boolean(),
  synthetic: z.boolean(),
  inherited: z.boolean(),
  at: EpochNs,
  change_seq: ChangeSeq,
})
export type UsageRecord = z.infer<typeof UsageRecord>

export const Gap = z.strictObject({
  id: GapId,
  key: GapKey,
  kind: GapKind,
  run: RunId.nullable(),
  session: SessionId.nullable(),
  stream: StreamKey.nullable(),
  details: text.nullable(),
  detected_at: EpochNs,
  closed_at: EpochNs.nullable(),
  change_seq: ChangeSeq,
})
export type Gap = z.infer<typeof Gap>
