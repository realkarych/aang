import { z } from 'zod'

export const runtimes = ['claude', 'codex'] as const
export const Runtime = z.enum(runtimes)
export type Runtime = z.infer<typeof Runtime>

export const EpochNs = z.codec(
  z.union([z.bigint(), z.string().regex(/^(?:0|[1-9][0-9]*)$/)]),
  z.bigint().nonnegative().brand<'EpochNs'>(),
  {
    decode: (value) => BigInt(value),
    encode: (value) => value.toString(),
  },
)
export type EpochNs = z.infer<typeof EpochNs>

export const JsonValue = z.json()
export type JsonValue = z.infer<typeof JsonValue>

export const Speaker = z.enum(['human', 'solver', 'tool', 'runtime'])
export type Speaker = z.infer<typeof Speaker>

const derivedIdPattern = /^[0-9a-f]{32}$/
const derivedId = z.string().regex(derivedIdPattern)
const assignedId = z.string()

export const ContentHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .brand<'ContentHash'>()
export type ContentHash = z.infer<typeof ContentHash>

export const RawSeq = z.int().positive().brand<'RawSeq'>()
export type RawSeq = z.infer<typeof RawSeq>

export const ChangeSeq = z.int().nonnegative().brand<'ChangeSeq'>()
export type ChangeSeq = z.infer<typeof ChangeSeq>

export const ModelVersion = z.int().nonnegative().brand<'ModelVersion'>()
export type ModelVersion = z.infer<typeof ModelVersion>

export const NormalizerVersion = z.int().positive().brand<'NormalizerVersion'>()
export type NormalizerVersion = z.infer<typeof NormalizerVersion>

export const DedupeKey = z.string().min(1).brand<'DedupeKey'>()
export type DedupeKey = z.infer<typeof DedupeKey>

export const StreamKey = z.string().min(1).brand<'StreamKey'>()
export type StreamKey = z.infer<typeof StreamKey>

export const SpoolFileName = z
  .string()
  .regex(/^[^/\\\0]+$/)
  .brand<'SpoolFileName'>()
export type SpoolFileName = z.infer<typeof SpoolFileName>

export const FactId = derivedId.brand<'FactId'>()
export type FactId = z.infer<typeof FactId>

export const RunId = derivedId.brand<'RunId'>()
export type RunId = z.infer<typeof RunId>

export const SessionId = derivedId.brand<'SessionId'>()
export type SessionId = z.infer<typeof SessionId>

export const AgentId = derivedId.brand<'AgentId'>()
export type AgentId = z.infer<typeof AgentId>

export const ActionId = derivedId.brand<'ActionId'>()
export type ActionId = z.infer<typeof ActionId>

export const MessageId = derivedId.brand<'MessageId'>()
export type MessageId = z.infer<typeof MessageId>

export const QuestionId = derivedId.brand<'QuestionId'>()
export type QuestionId = z.infer<typeof QuestionId>

export const UsageRecordId = derivedId.brand<'UsageRecordId'>()
export type UsageRecordId = z.infer<typeof UsageRecordId>

export const ArtifactId = derivedId.brand<'ArtifactId'>()
export type ArtifactId = z.infer<typeof ArtifactId>

export const ArtifactVersionId = derivedId.brand<'ArtifactVersionId'>()
export type ArtifactVersionId = z.infer<typeof ArtifactVersionId>

export const GitSnapshotId = derivedId.brand<'GitSnapshotId'>()
export type GitSnapshotId = z.infer<typeof GitSnapshotId>

export const GapId = derivedId.brand<'GapId'>()
export type GapId = z.infer<typeof GapId>

export const StageId = assignedId.brand<'StageId'>()
export type StageId = z.infer<typeof StageId>

export const CriterionId = assignedId.brand<'CriterionId'>()
export type CriterionId = z.infer<typeof CriterionId>

export const CardId = assignedId.brand<'CardId'>()
export type CardId = z.infer<typeof CardId>

export const AttentionItemId = assignedId.brand<'AttentionItemId'>()
export type AttentionItemId = z.infer<typeof AttentionItemId>

export const LinkId = assignedId.brand<'LinkId'>()
export type LinkId = z.infer<typeof LinkId>

export const BindingId = assignedId.brand<'BindingId'>()
export type BindingId = z.infer<typeof BindingId>

export const ViewRuleId = assignedId.brand<'ViewRuleId'>()
export type ViewRuleId = z.infer<typeof ViewRuleId>

export const ObserverCallId = assignedId.brand<'ObserverCallId'>()
export type ObserverCallId = z.infer<typeof ObserverCallId>

export const ChatMessageId = assignedId.brand<'ChatMessageId'>()
export type ChatMessageId = z.infer<typeof ChatMessageId>
