import { z } from 'zod'
import { Basis, Evidence } from './axes.js'
import { AttentionItem, Binding, Card, Criterion, Link, Run, SessionMembership, Stage } from './model.js'
import {
  AttentionItemId,
  BindingId,
  CardId,
  ChangeSeq,
  CriterionId,
  EpochNs,
  FactId,
  LinkId,
  ModelVersion,
  ObserverCallId,
  RunId,
  SessionId,
  StageId,
} from './primitives.js'

export const observerOperations = [
  'stage.create',
  'stage.update',
  'stage.state',
  'stage.replace',
  'stage.merge',
  'stage.split',
  'stage.nest',
  'stage.depends',
  'actions.assign',
  'agents.participate',
  'artifact.link',
  'criterion.add',
  'criterion.assess',
  'card.add',
  'brief.update',
  'question.add',
  'attention.add',
  'attention.resolve',
  'attention.likely_resolved',
  'attention.priority',
] as const

export const ruleOperations = [
  'run.create',
  'run.goal',
  'stage.execution',
  'criterion.status',
  'attention.open',
  'attention.wait',
  'attention.close',
  'link.add',
  'link.retarget',
  'link.remove',
  'session.move',
] as const

export const userOperations = ['binding.add', 'binding.revoke'] as const

export const ObserverOperation = z.enum(observerOperations)
export type ObserverOperation = z.infer<typeof ObserverOperation>

export const ModelOperation = z.enum([...observerOperations, ...ruleOperations, ...userOperations])
export type ModelOperation = z.infer<typeof ModelOperation>

export const ChangeAuthor = z.enum(['rule', 'observer', 'user'])
export type ChangeAuthor = z.infer<typeof ChangeAuthor>

export const ModelEntityRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run'), id: RunId }),
  z.strictObject({ kind: z.literal('stage'), id: StageId }),
  z.strictObject({ kind: z.literal('criterion'), id: CriterionId }),
  z.strictObject({ kind: z.literal('card'), id: CardId }),
  z.strictObject({ kind: z.literal('attention_item'), id: AttentionItemId }),
  z.strictObject({ kind: z.literal('link'), id: LinkId }),
  z.strictObject({ kind: z.literal('binding'), id: BindingId }),
  z.strictObject({ kind: z.literal('session_membership'), id: SessionId }),
])
export type ModelEntityRef = z.infer<typeof ModelEntityRef>

export const ModelEntity = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run'), value: Run }),
  z.strictObject({ kind: z.literal('stage'), value: Stage }),
  z.strictObject({ kind: z.literal('criterion'), value: Criterion }),
  z.strictObject({ kind: z.literal('card'), value: Card }),
  z.strictObject({ kind: z.literal('attention_item'), value: AttentionItem }),
  z.strictObject({ kind: z.literal('link'), value: Link }),
  z.strictObject({ kind: z.literal('binding'), value: Binding }),
  z.strictObject({ kind: z.literal('session_membership'), value: SessionMembership }),
])
export type ModelEntity = z.infer<typeof ModelEntity>

export const ModelChange = z.strictObject({
  run: RunId,
  version: ModelVersion,
  index: z.int().nonnegative(),
  op: ModelOperation,
  target: ModelEntityRef,
  before: ModelEntity.nullable(),
  after: ModelEntity.nullable(),
  author: ChangeAuthor,
  basis: Basis.nullable(),
  evidence: Evidence,
  observer_call: ObserverCallId.nullable(),
  change_seq: ChangeSeq,
})
export type ModelChange = z.infer<typeof ModelChange>

export const ModelVersionRecord = z.strictObject({
  run: RunId,
  version: ModelVersion,
  base_version: ModelVersion.nullable(),
  author: ChangeAuthor,
  observer_call: ObserverCallId.nullable(),
  created_at: EpochNs,
  change_seq: ChangeSeq,
})
export type ModelVersionRecord = z.infer<typeof ModelVersionRecord>

export const InterpretationStatus = z.enum(['pending', 'in_call', 'interpreted', 'deferred', 'not_interpreted'])
export type InterpretationStatus = z.infer<typeof InterpretationStatus>

export const FactInterpretation = z.strictObject({
  run: RunId,
  fact: FactId,
  status: InterpretationStatus,
  attempts: z.int().nonnegative(),
  observer_call: ObserverCallId.nullable(),
})
export type FactInterpretation = z.infer<typeof FactInterpretation>
