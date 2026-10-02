import { z } from 'zod'
import {
  ActionMaterial,
  ArtifactVersionMaterial,
  FactMaterial,
  InputArtifactVersion,
  InputFact,
  JournalEntityRef,
  JournalEntry,
  JournalMaterial,
  llmJsonSchema,
  LlmTime,
  ModelSnapshot,
  RawRecordMaterial,
  RunDescription,
  SnapshotAttentionItem,
  StageMaterial,
  unavailableMaterial,
  type LlmJsonSchema,
} from './llm.js'
import {
  ActionId,
  ArtifactVersionId,
  AttentionItemId,
  ChatMessageId,
  EpochNs,
  FactId,
  ModelVersion,
  RawSeq,
  RunId,
  StageId,
  ViewRuleId,
} from './primitives.js'
import { ViewRuleSpec } from './view.js'

const text = z.string()

export const ChatNeed = z.union([
  z.strictObject({ kind: z.literal('stage'), stage: StageId }),
  z.strictObject({ kind: z.literal('fact'), fact: FactId }),
  z.strictObject({ kind: z.literal('raw_record'), seq: RawSeq }),
  z.strictObject({ kind: z.literal('action'), action: ActionId }),
  z.strictObject({ kind: z.literal('journal'), entity: JournalEntityRef }),
  z.strictObject({ kind: z.literal('artifact_version'), version: ArtifactVersionId }),
])
export type ChatNeed = z.infer<typeof ChatNeed>

export const ChatCitation = z.union([
  z.strictObject({ kind: z.literal('stage'), id: StageId }),
  z.strictObject({ kind: z.literal('fact'), id: FactId }),
  z.strictObject({ kind: z.literal('action'), id: ActionId }),
  z.strictObject({ kind: z.literal('artifact_version'), id: ArtifactVersionId }),
  z.strictObject({ kind: z.literal('question'), id: AttentionItemId }),
])
export type ChatCitation = z.infer<typeof ChatCitation>

export const ChatOutput = z.strictObject({
  needs: z.array(ChatNeed),
  answer: text.nullable(),
  citations: z.array(ChatCitation),
  insufficient_data: z.boolean(),
  view_rule: ViewRuleSpec.nullable(),
})
export type ChatOutput = z.infer<typeof ChatOutput>

export const chatOutputJsonSchema = (): LlmJsonSchema => llmJsonSchema(ChatOutput)

export const ChatTurn = z.strictObject({
  question: text,
  answer: text.nullable(),
  version: ModelVersion,
  asked_at: LlmTime,
})
export type ChatTurn = z.infer<typeof ChatTurn>

export const ChatFocus = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stage'),
    stage: StageId,
    facts: z.array(InputFact),
    actions: z.array(ActionMaterial),
    artifact_versions: z.array(InputArtifactVersion),
  }),
  z.strictObject({
    kind: z.literal('run'),
    attention: z.array(SnapshotAttentionItem),
    recent_changes: z.array(JournalEntry),
  }),
])
export type ChatFocus = z.infer<typeof ChatFocus>

export const ChatMaterial = z.discriminatedUnion('kind', [
  StageMaterial,
  FactMaterial,
  RawRecordMaterial,
  ActionMaterial,
  JournalMaterial,
  ArtifactVersionMaterial,
  unavailableMaterial(ChatNeed),
])
export type ChatMaterial = z.infer<typeof ChatMaterial>

export const ChatInput = z.strictObject({
  question: text,
  history: z.array(ChatTurn),
  run: RunDescription,
  model: ModelSnapshot,
  focus: ChatFocus,
  materials: z.array(ChatMaterial),
})
export type ChatInput = z.infer<typeof ChatInput>

export const ChatMessageStatus = z.enum(['pending', 'answered', 'failed'])
export type ChatMessageStatus = z.infer<typeof ChatMessageStatus>

export const ChatMessage = z.strictObject({
  id: ChatMessageId,
  run: RunId,
  stage: StageId.nullable(),
  question: z.string().min(1),
  status: ChatMessageStatus,
  version: ModelVersion,
  answer: text.nullable(),
  citations: z.array(ChatCitation),
  unconfirmed_citations: z.boolean(),
  insufficient_data: z.boolean(),
  view_rule: ViewRuleId.nullable(),
  error: text.nullable(),
  asked_at: EpochNs,
  answered_at: EpochNs.nullable(),
})
export type ChatMessage = z.infer<typeof ChatMessage>
