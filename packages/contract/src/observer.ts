import { z } from 'zod'
import { Evidence, Execution } from './axes.js'
import { ActionKind } from './facts.js'
import type { ObserverOperation } from './journal.js'
import {
  ActionMaterial,
  ArtifactVersionMaterial,
  ContextMaterial,
  InputArtifactVersion,
  InputFact,
  llmJsonSchema,
  LlmTime,
  ModelSnapshot,
  RawRecordMaterial,
  RunContext,
  RunDescription,
  unavailableMaterial,
  type LlmJsonSchema,
} from './llm.js'
import {
  ArtifactDirection,
  AttentionPriority,
  AttentionResolution,
  CardSource,
  CriterionSource,
  CriterionStatus,
  StageOrigin,
} from './model.js'
import {
  ActionId,
  AgentId,
  ArtifactVersionId,
  AttentionItemId,
  CriterionId,
  FactId,
  ModelVersion,
  RawSeq,
  StageId,
} from './primitives.js'

const text = z.string()
const count = z.int().nonnegative()

export const TempId = z.string().brand<'TempId'>()
export type TempId = z.infer<typeof TempId>

const reference = <T extends z.ZodType>(existing: T) =>
  z.union([
    z.strictObject({ kind: z.literal('existing'), id: existing }),
    z.strictObject({ kind: z.literal('new'), temp_id: TempId }),
  ])

export const StageRef = reference(StageId)
export type StageRef = z.infer<typeof StageRef>

export const CriterionRef = reference(CriterionId)
export type CriterionRef = z.infer<typeof CriterionRef>

export const AttentionRef = reference(AttentionItemId)
export type AttentionRef = z.infer<typeof AttentionRef>

export const ObserverCriterionSource = CriterionSource.exclude(['contract'])
export type ObserverCriterionSource = z.infer<typeof ObserverCriterionSource>

export const CriterionAssessment = CriterionStatus.extract(['not_checked', 'partial', 'failed', 'reported_done'])
export type CriterionAssessment = z.infer<typeof CriterionAssessment>

export const ObserverAttentionKind = z.enum(['review_request', 'blocker'])
export type ObserverAttentionKind = z.infer<typeof ObserverAttentionKind>

export const ObserverResolution = AttentionResolution.extract(['answered', 'resolved'])
export type ObserverResolution = z.infer<typeof ObserverResolution>

const operation = <O extends ObserverOperation, S extends z.core.$ZodLooseShape>(op: O, shape: S) =>
  z.strictObject({ op: z.literal(op), ...shape, evidence: Evidence, rationale: text })

export const ObserverOp = z.union([
  operation('stage.create', {
    temp_id: TempId,
    title: text,
    expected_result: text.nullable(),
    summary: text.nullable(),
    parent: StageRef.nullable(),
    origin: StageOrigin,
  }),
  operation('stage.update', {
    stage: StageRef,
    title: text.nullable(),
    expected_result: text.nullable(),
    summary: text.nullable(),
  }),
  operation('stage.state', { stage: StageRef, execution: Execution }),
  operation('stage.replace', { stage: StageRef, by: z.array(StageRef) }),
  operation('stage.merge', { stages: z.array(StageRef), into: StageRef }),
  operation('stage.split', { stage: StageRef, into: z.array(StageRef) }),
  operation('stage.nest', { stage: StageRef, parent: StageRef.nullable() }),
  operation('stage.depends', { stage: StageRef, depends_on: StageRef, via: ArtifactVersionId.nullable() }),
  operation('actions.assign', { actions: z.array(ActionId), stage: StageRef }),
  operation('agents.participate', { agents: z.array(AgentId), stage: StageRef }),
  operation('artifact.link', { stage: StageRef, version: ArtifactVersionId, direction: ArtifactDirection }),
  operation('criterion.add', {
    temp_id: TempId,
    stage: StageRef.nullable(),
    text,
    source: ObserverCriterionSource,
  }),
  operation('criterion.assess', { criterion: CriterionRef, status: CriterionAssessment }),
  operation('card.add', { stages: z.array(StageRef), text, source: CardSource }),
  operation('brief.update', { text }),
  operation('question.add', { temp_id: TempId, text, stage: StageRef.nullable() }),
  operation('attention.add', { temp_id: TempId, kind: ObserverAttentionKind, text, stage: StageRef.nullable() }),
  operation('attention.resolve', { item: AttentionRef, resolution: ObserverResolution }),
  operation('attention.likely_resolved', { item: AttentionItemId }),
  operation('attention.priority', { item: AttentionRef, priority: AttentionPriority }),
])
export type ObserverOp = z.infer<typeof ObserverOp>
export type ObserverOpOf<O extends ObserverOperation> = Extract<ObserverOp, { op: O }>

export const ObserverNeed = z.union([
  z.strictObject({ kind: z.literal('raw_record'), seq: RawSeq }),
  z.strictObject({ kind: z.literal('action'), action: ActionId }),
  z.strictObject({ kind: z.literal('artifact_version'), version: ArtifactVersionId }),
  z.strictObject({ kind: z.literal('context'), seq: RawSeq }),
])
export type ObserverNeed = z.infer<typeof ObserverNeed>

export const ObserverOutput = z.strictObject({
  base_version: ModelVersion,
  ops: z.array(ObserverOp),
  needs: z.array(ObserverNeed),
})
export type ObserverOutput = z.infer<typeof ObserverOutput>

export const observerOutputJsonSchema = (): LlmJsonSchema => llmJsonSchema(ObserverOutput)

export const CollapsedFacts = z.strictObject({
  tool: text,
  action_kind: ActionKind,
  agent: AgentId.nullable(),
  facts: z.array(FactId),
  from: LlmTime,
  to: LlmTime,
})
export type CollapsedFacts = z.infer<typeof CollapsedFacts>

export const BacklogSummary = z.strictObject({
  from: LlmTime,
  to: LlmTime,
  facts: count,
  agents: z.array(
    z.strictObject({
      agent: AgentId.nullable(),
      facts: count,
      tools: z.array(z.strictObject({ tool: text, count })),
    }),
  ),
})
export type BacklogSummary = z.infer<typeof BacklogSummary>

export const ObserverBatch = z.strictObject({
  facts: z.array(InputFact),
  collapsed: z.array(CollapsedFacts),
  backlog: BacklogSummary.nullable(),
  artifact_versions: z.array(InputArtifactVersion),
})
export type ObserverBatch = z.infer<typeof ObserverBatch>

export const ObserverMaterial = z.discriminatedUnion('kind', [
  RawRecordMaterial,
  ActionMaterial,
  ArtifactVersionMaterial,
  ContextMaterial,
  unavailableMaterial(ObserverNeed),
])
export type ObserverMaterial = z.infer<typeof ObserverMaterial>

export const ObserverInput = z.strictObject({
  run: RunDescription,
  context: RunContext.nullable(),
  model: ModelSnapshot,
  batch: ObserverBatch,
  materials: z.array(ObserverMaterial),
  previous_attempt: z
    .strictObject({
      reasons: z.array(text),
    })
    .nullable(),
})
export type ObserverInput = z.infer<typeof ObserverInput>
