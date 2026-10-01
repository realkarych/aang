import { z } from 'zod'
import type {
  ActionId,
  AgentId,
  ArtifactId,
  ArtifactVersionId,
  GapId,
  GitSnapshotId,
  MessageId,
  QuestionId,
  SessionId,
  UsageRecordId,
} from './primitives.js'
import { ContentHash, DedupeKey, FactId, RunId, Runtime } from './primitives.js'

const runtimeId = z.string().min(1)

export const ServiceAgent = z.enum(['guardian', 'compaction', 'desktop_summary'])
export type ServiceAgent = z.infer<typeof ServiceAgent>

export const AgentRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('main') }),
  z.strictObject({ kind: z.literal('subagent'), agent_id: runtimeId }),
  z.strictObject({ kind: z.literal('teammate'), name: runtimeId, team: runtimeId }),
  z.strictObject({ kind: z.literal('thread'), thread_id: runtimeId }),
  z.strictObject({ kind: z.literal('service'), service: ServiceAgent }),
])
export type AgentRef = z.infer<typeof AgentRef>

export const ArtifactRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal('url'), url: z.string().min(1) }),
  z.strictObject({ kind: z.literal('commit'), repository: z.string().min(1), sha: z.string().min(1) }),
  z.strictObject({ kind: z.literal('pull_request'), url: z.string().min(1) }),
])
export type ArtifactRef = z.infer<typeof ArtifactRef>

export const VersionIdentity = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('content'), hash: ContentHash }),
  z.strictObject({ kind: z.literal('commit'), sha: z.string().min(1) }),
  z.strictObject({ kind: z.literal('reference'), fact: FactId }),
])
export type VersionIdentity = z.infer<typeof VersionIdentity>

export const GapKind = z.enum([
  'source_lost',
  'unknown_records',
  'unknown_stream_layout',
  'hooks_inactive',
  'spool_expired',
  'spool_over_threshold',
  'read_failed',
  'stream_changed_after_prune',
  'not_interpreted',
  'summarized_backlog',
  'cross_vendor_excluded',
])
export type GapKind = z.infer<typeof GapKind>

export const RunKey = z.strictObject({ kind: z.literal('run'), runtime: Runtime, session: runtimeId })
export type RunKey = z.infer<typeof RunKey>

export const SessionKey = z.strictObject({ kind: z.literal('session'), runtime: Runtime, session: runtimeId })
export type SessionKey = z.infer<typeof SessionKey>

export const AgentKey = z.strictObject({
  kind: z.literal('agent'),
  runtime: Runtime,
  session: runtimeId,
  agent: AgentRef,
})
export type AgentKey = z.infer<typeof AgentKey>

export const ActionKey = z.strictObject({
  kind: z.literal('action'),
  runtime: Runtime,
  session: runtimeId,
  call: runtimeId,
})
export type ActionKey = z.infer<typeof ActionKey>

export const MessageKey = z.strictObject({
  kind: z.literal('message'),
  runtime: Runtime,
  session: runtimeId,
  message: runtimeId,
})
export type MessageKey = z.infer<typeof MessageKey>

export const QuestionKey = z.strictObject({
  kind: z.literal('question'),
  runtime: Runtime,
  session: runtimeId,
  question: runtimeId,
})
export type QuestionKey = z.infer<typeof QuestionKey>

export const UsageKey = z.strictObject({
  kind: z.literal('usage'),
  runtime: Runtime,
  session: runtimeId,
  usage: runtimeId,
})
export type UsageKey = z.infer<typeof UsageKey>

export const ArtifactKey = z.strictObject({
  kind: z.literal('artifact'),
  run: RunId,
  artifact: ArtifactRef,
})
export type ArtifactKey = z.infer<typeof ArtifactKey>

export const ArtifactVersionKey = z.strictObject({
  kind: z.literal('artifact_version'),
  run: RunId,
  artifact: ArtifactRef,
  identity: VersionIdentity,
})
export type ArtifactVersionKey = z.infer<typeof ArtifactVersionKey>

export const GitSnapshotKey = z.strictObject({
  kind: z.literal('git_snapshot'),
  record: DedupeKey,
})
export type GitSnapshotKey = z.infer<typeof GitSnapshotKey>

export const GapKey = z.strictObject({
  kind: z.literal('gap'),
  gap: GapKind,
  subject: z.string().min(1),
})
export type GapKey = z.infer<typeof GapKey>

export const FactEntityKey = z.discriminatedUnion('kind', [
  RunKey,
  SessionKey,
  AgentKey,
  ActionKey,
  MessageKey,
  QuestionKey,
  UsageKey,
])
export type FactEntityKey = z.infer<typeof FactEntityKey>

export const ObjectKey = z.discriminatedUnion('kind', [
  ...FactEntityKey.options,
  ArtifactKey,
  ArtifactVersionKey,
  GitSnapshotKey,
  GapKey,
])
export type ObjectKey = z.infer<typeof ObjectKey>

export interface ObjectIdByKind {
  run: RunId
  session: SessionId
  agent: AgentId
  action: ActionId
  message: MessageId
  question: QuestionId
  usage: UsageRecordId
  artifact: ArtifactId
  artifact_version: ArtifactVersionId
  git_snapshot: GitSnapshotId
  gap: GapId
}
