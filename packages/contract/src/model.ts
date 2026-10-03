import { z } from 'zod'
import { assessed, Basis, Evidence, Execution, HumanDecision } from './axes.js'
import {
  ActionId,
  AgentId,
  ArtifactVersionId,
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
  QuestionId,
  RunId,
  Runtime,
  SessionId,
  StageId,
} from './primitives.js'

const text = z.string()
const name = z.string().min(1)

export const RunGoal = z.strictObject({
  text,
  fact: FactId,
})
export type RunGoal = z.infer<typeof RunGoal>

export const RunBrief = z.strictObject({
  text,
  basis: Basis,
  evidence: Evidence,
})
export type RunBrief = z.infer<typeof RunBrief>

export const Run = z.strictObject({
  id: RunId,
  runtime: Runtime,
  root_session: SessionId,
  goal: RunGoal.nullable(),
  brief: RunBrief.nullable(),
  start_pruned: z.boolean(),
  version: ModelVersion,
  created_at: EpochNs,
})
export type Run = z.infer<typeof Run>

export const StageOrigin = z.enum(['plan', 'inferred'])
export type StageOrigin = z.infer<typeof StageOrigin>

export const StageLifecycle = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('active') }),
  z.strictObject({ state: z.literal('replaced'), by: z.array(StageId).min(1) }),
  z.strictObject({ state: z.literal('merged'), into: StageId }),
  z.strictObject({ state: z.literal('split'), into: z.array(StageId).min(2) }),
])
export type StageLifecycle = z.infer<typeof StageLifecycle>

export const Stage = z.strictObject({
  id: StageId,
  run: RunId,
  title: name,
  expected_result: text.nullable(),
  summary: text.nullable(),
  parent: StageId.nullable(),
  origin: StageOrigin,
  lifecycle: StageLifecycle,
  execution: assessed(Execution),
  execution_claim: assessed(Execution).nullable(),
  decision: assessed(HumanDecision),
  session_moved: z.boolean(),
  basis: Basis,
  evidence: Evidence,
  created_version: ModelVersion,
  updated_version: ModelVersion,
})
export type Stage = z.infer<typeof Stage>

export const CriterionSource = z.enum(['task', 'plan', 'contract'])
export type CriterionSource = z.infer<typeof CriterionSource>

export const CriterionStatus = z.enum([
  'not_checked',
  'confirmed',
  'passed_unversioned',
  'partial',
  'failed',
  'stale',
  'reported_done',
])
export type CriterionStatus = z.infer<typeof CriterionStatus>

export const Criterion = z.strictObject({
  id: CriterionId,
  run: RunId,
  stage: StageId.nullable(),
  text: name,
  source: CriterionSource,
  contract: text.nullable(),
  status: assessed(CriterionStatus),
  checked_commit: text.nullable(),
  clean_tree_commit: text.nullable(),
  carried_checks: z.array(ActionId),
})
export type Criterion = z.infer<typeof Criterion>

export const CardSource = z.strictObject({
  fact: FactId,
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
})
export type CardSource = z.infer<typeof CardSource>

export const Card = z.strictObject({
  id: CardId,
  run: RunId,
  stages: z.array(StageId),
  text: name,
  source: CardSource,
  basis: Basis,
  evidence: Evidence,
})
export type Card = z.infer<typeof Card>

export const AttentionKind = z.enum(['question', 'permission', 'review_request', 'blocker', 'failed_check'])
export type AttentionKind = z.infer<typeof AttentionKind>

export const AttentionAuthor = z.enum(['rule', 'observer'])
export type AttentionAuthor = z.infer<typeof AttentionAuthor>

export const RuntimeWait = z.enum(['active', 'ended', 'none'])
export type RuntimeWait = z.infer<typeof RuntimeWait>

export const AttentionResolution = z.enum(['open', 'answered', 'resolved', 'ended_without_answer'])
export type AttentionResolution = z.infer<typeof AttentionResolution>

export const AttentionPriority = z.enum(['high', 'medium', 'low'])
export type AttentionPriority = z.infer<typeof AttentionPriority>

export const AttentionItem = z.strictObject({
  id: AttentionItemId,
  run: RunId,
  kind: AttentionKind,
  author: AttentionAuthor,
  text: name,
  stage: StageId.nullable(),
  question: QuestionId.nullable(),
  action: ActionId.nullable(),
  basis: Basis,
  evidence: Evidence,
  runtime_wait: RuntimeWait,
  resolution: AttentionResolution,
  likely_resolved: z
    .strictObject({
      basis: Basis,
      evidence: Evidence,
    })
    .nullable(),
  priority: z
    .strictObject({
      value: AttentionPriority,
      call: ObserverCallId,
    })
    .nullable(),
  opened_at: EpochNs,
  closed_at: EpochNs.nullable(),
  change_seq: ChangeSeq,
})
export type AttentionItem = z.infer<typeof AttentionItem>

export const ArtifactDirection = z.enum(['input', 'output'])
export type ArtifactDirection = z.infer<typeof ArtifactDirection>

const linkShape = {
  id: LinkId,
  run: RunId,
  basis: Basis,
  evidence: Evidence,
}

export const Link = z.discriminatedUnion('kind', [
  z.strictObject({
    ...linkShape,
    kind: z.literal('spawn'),
    parent: AgentId,
    child: AgentId,
    via: ActionId.nullable(),
  }),
  z.strictObject({
    ...linkShape,
    kind: z.literal('forked_from'),
    parent: RunId,
  }),
  z.strictObject({
    ...linkShape,
    kind: z.literal('common_origin'),
    sessions: z.array(SessionId),
    parent_candidate: SessionId.nullable(),
  }),
  z.strictObject({
    ...linkShape,
    kind: z.literal('participation'),
    agent: AgentId,
    stage: StageId,
  }),
  z.strictObject({
    ...linkShape,
    kind: z.literal('assignment'),
    action: ActionId,
    stage: StageId,
  }),
  z.strictObject({
    ...linkShape,
    kind: z.literal('artifact'),
    stage: StageId,
    version: ArtifactVersionId,
    direction: ArtifactDirection,
  }),
  z.strictObject({
    ...linkShape,
    kind: z.literal('dependency'),
    stage: StageId,
    depends_on: StageId,
    via: ArtifactVersionId.nullable(),
  }),
])
export type Link = z.infer<typeof Link>

export const SessionMembership = z.strictObject({
  session: SessionId,
  run: RunId,
})
export type SessionMembership = z.infer<typeof SessionMembership>

export const BindingKind = z.enum(['attach', 'detach', 'fork_parent'])
export type BindingKind = z.infer<typeof BindingKind>

export const Binding = z.discriminatedUnion('kind', [
  z.strictObject({
    id: BindingId,
    kind: z.literal('attach'),
    session: SessionId,
    run: RunId,
    created_at: EpochNs,
    revoked_at: EpochNs.nullable(),
  }),
  z.strictObject({
    id: BindingId,
    kind: z.literal('detach'),
    session: SessionId,
    created_at: EpochNs,
    revoked_at: EpochNs.nullable(),
  }),
  z.strictObject({
    id: BindingId,
    kind: z.literal('fork_parent'),
    run: RunId,
    parent: SessionId,
    created_at: EpochNs,
    revoked_at: EpochNs.nullable(),
  }),
])
export type Binding = z.infer<typeof Binding>
