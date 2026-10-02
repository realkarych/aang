import { z } from 'zod'
import { Execution, HumanDecision } from './axes.js'
import { ActionKind, ActionOutcome, AgentRole, ContextSourceKind, FactKind, Surface } from './facts.js'
import { ChangeAuthor, ModelEntityRef, ModelOperation } from './journal.js'
import { ArtifactRef, ServiceAgent } from './keys.js'
import {
  AttentionAuthor,
  AttentionKind,
  AttentionResolution,
  CriterionSource,
  CriterionStatus,
  RuntimeWait,
  StageLifecycle,
  StageOrigin,
} from './model.js'
import {
  ActionId,
  AgentId,
  ArtifactVersionId,
  AttentionItemId,
  CardId,
  ContentHash,
  CriterionId,
  FactId,
  JsonValue,
  ModelVersion,
  RawSeq,
  RunId,
  Runtime,
  SessionId,
  Speaker,
  StageId,
} from './primitives.js'
import { RawChannel } from './raw.js'

const text = z.string()
const count = z.int().nonnegative()

const valueConstraints = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const

export type LlmJsonSchema = z.core.JSONSchema.BaseSchema

const alternatives = (member: z.core.JSONSchema.JSONSchema): z.core.JSONSchema.JSONSchema[] =>
  member.anyOf !== undefined && Object.keys(member).length === 1 ? member.anyOf.flatMap(alternatives) : [member]

export const llmJsonSchema = (schema: z.ZodType): LlmJsonSchema => {
  const document = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
    cycles: 'throw',
    reused: 'inline',
    override: ({ jsonSchema }) => {
      for (const keyword of valueConstraints) {
        Reflect.deleteProperty(jsonSchema, keyword)
      }
      if (jsonSchema.anyOf !== undefined) {
        jsonSchema.anyOf = jsonSchema.anyOf.flatMap(alternatives)
      }
    },
  })
  delete document.$schema
  return document
}

export const LlmTime = z.iso.datetime()
export type LlmTime = z.infer<typeof LlmTime>

export const Truncation = z.strictObject({
  path: text,
  length: count,
})
export type Truncation = z.infer<typeof Truncation>

export const RunSessionBrief = z.strictObject({
  id: SessionId,
  runtime: Runtime,
  surface: Surface.nullable(),
  cwd: text.nullable(),
  git_branch: text.nullable(),
  started_at: LlmTime,
})
export type RunSessionBrief = z.infer<typeof RunSessionBrief>

export const RunAgentBrief = z.strictObject({
  id: AgentId,
  session: SessionId,
  role: AgentRole,
  service: ServiceAgent.nullable(),
  agent_type: text.nullable(),
  name: text.nullable(),
  description: text.nullable(),
  parent: AgentId.nullable(),
})
export type RunAgentBrief = z.infer<typeof RunAgentBrief>

export const RunDescription = z.strictObject({
  id: RunId,
  runtime: Runtime,
  goal: text.nullable(),
  brief: text.nullable(),
  sessions: z.array(RunSessionBrief),
  agents: z.array(RunAgentBrief),
})
export type RunDescription = z.infer<typeof RunDescription>

export const RunContextEntry = z.strictObject({
  kind: ContextSourceKind,
  ref: text,
  text,
  truncated: Truncation.nullable(),
})
export type RunContextEntry = z.infer<typeof RunContextEntry>

export const RunContext = z.strictObject({
  seq: RawSeq,
  content_hash: ContentHash,
  entries: z.array(RunContextEntry),
})
export type RunContext = z.infer<typeof RunContext>

export const SnapshotStage = z.strictObject({
  id: StageId,
  title: text,
  expected_result: text.nullable(),
  summary: text.nullable(),
  parent: StageId.nullable(),
  origin: StageOrigin,
  execution: Execution,
  decision: HumanDecision,
})
export type SnapshotStage = z.infer<typeof SnapshotStage>

export const SnapshotCriterion = z.strictObject({
  id: CriterionId,
  stage: StageId.nullable(),
  text,
  source: CriterionSource,
  status: CriterionStatus,
})
export type SnapshotCriterion = z.infer<typeof SnapshotCriterion>

export const SnapshotAttentionItem = z.strictObject({
  id: AttentionItemId,
  kind: AttentionKind,
  author: AttentionAuthor,
  text,
  stage: StageId.nullable(),
  runtime_wait: RuntimeWait,
  resolution: AttentionResolution,
  likely_resolved: z.boolean(),
})
export type SnapshotAttentionItem = z.infer<typeof SnapshotAttentionItem>

export const ModelSnapshot = z.strictObject({
  version: ModelVersion,
  stages: z.array(SnapshotStage),
  criteria: z.array(SnapshotCriterion),
  attention: z.array(SnapshotAttentionItem),
})
export type ModelSnapshot = z.infer<typeof ModelSnapshot>

export const InputFact = z.strictObject({
  id: FactId,
  seq: RawSeq,
  kind: FactKind,
  speaker: Speaker,
  at: LlmTime,
  urgent: z.boolean(),
  session: SessionId,
  agent: AgentId.nullable(),
  action: ActionId.nullable(),
  payload: JsonValue,
  truncated: z.array(Truncation),
})
export type InputFact = z.infer<typeof InputFact>

export const InputArtifactVersion = z.strictObject({
  id: ArtifactVersionId,
  ref: ArtifactRef,
  produced_by: ActionId.nullable(),
  retained: z.boolean(),
})
export type InputArtifactVersion = z.infer<typeof InputArtifactVersion>

export const JournalEntityRef = z.union([
  z.strictObject({ kind: z.literal('stage'), id: StageId }),
  z.strictObject({ kind: z.literal('criterion'), id: CriterionId }),
  z.strictObject({ kind: z.literal('card'), id: CardId }),
  z.strictObject({ kind: z.literal('attention_item'), id: AttentionItemId }),
])
export type JournalEntityRef = z.infer<typeof JournalEntityRef>

export const JournalEntry = z.strictObject({
  version: ModelVersion,
  op: ModelOperation,
  author: ChangeAuthor,
  target: ModelEntityRef,
  before: JsonValue,
  after: JsonValue,
  evidence: z.array(FactId),
})
export type JournalEntry = z.infer<typeof JournalEntry>

export const RawRecordMaterial = z.strictObject({
  kind: z.literal('raw_record'),
  seq: RawSeq,
  channel: RawChannel,
  observed_at: LlmTime,
  payload: text,
  truncated: Truncation.nullable(),
})
export type RawRecordMaterial = z.infer<typeof RawRecordMaterial>

export const ActionMaterial = z.strictObject({
  kind: z.literal('action'),
  action: ActionId,
  tool: text,
  action_kind: ActionKind,
  agent: AgentId.nullable(),
  started_at: LlmTime.nullable(),
  ended_at: LlmTime.nullable(),
  outcome: ActionOutcome.nullable(),
  input: JsonValue,
  output: text.nullable(),
  truncated: z.array(Truncation),
})
export type ActionMaterial = z.infer<typeof ActionMaterial>

export const ArtifactVersionMaterial = z.strictObject({
  kind: z.literal('artifact_version'),
  version: ArtifactVersionId,
  ref: ArtifactRef,
  retention: z.enum(['action_payload', 'file_read', 'commit']),
  read_at: LlmTime.nullable(),
  content: text,
  truncated: Truncation.nullable(),
})
export type ArtifactVersionMaterial = z.infer<typeof ArtifactVersionMaterial>

export const ContextMaterial = z.strictObject({
  kind: z.literal('context'),
  context: RunContext,
})
export type ContextMaterial = z.infer<typeof ContextMaterial>

export const StageMaterial = z.strictObject({
  kind: z.literal('stage'),
  stage: SnapshotStage,
  lifecycle: StageLifecycle,
})
export type StageMaterial = z.infer<typeof StageMaterial>

export const FactMaterial = z.strictObject({
  kind: z.literal('fact'),
  fact: InputFact,
})
export type FactMaterial = z.infer<typeof FactMaterial>

export const JournalMaterial = z.strictObject({
  kind: z.literal('journal'),
  entity: JournalEntityRef,
  entries: z.array(JournalEntry),
})
export type JournalMaterial = z.infer<typeof JournalMaterial>

export const MaterialUnavailableReason = z.enum(['out_of_scope', 'cross_vendor', 'not_found', 'not_retained'])
export type MaterialUnavailableReason = z.infer<typeof MaterialUnavailableReason>

export const unavailableMaterial = <R extends z.ZodType>(request: R) =>
  z.strictObject({
    kind: z.literal('unavailable'),
    request,
    reason: MaterialUnavailableReason,
  })
