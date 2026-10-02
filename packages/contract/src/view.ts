import { z } from 'zod'
import { ActionKind } from './facts.js'
import { AttentionItemId, ChangeSeq, EpochNs, ModelVersion, RunId, StageId, ViewRuleId } from './primitives.js'

const text = z.string()

export const ViewMark = z.strictObject({
  run: RunId,
  version: ModelVersion,
  change_seq: ChangeSeq,
  marked_at: EpochNs,
})
export type ViewMark = z.infer<typeof ViewMark>

export const AttentionView = z.strictObject({
  item: AttentionItemId,
  viewed_at: EpochNs.nullable(),
  dismissed_at: EpochNs.nullable(),
  change_seq: ChangeSeq,
})
export type AttentionView = z.infer<typeof AttentionView>

export const ViewSelector = z.union([
  z.strictObject({ kind: z.literal('agent_type'), agent_type: text }),
  z.strictObject({ kind: z.literal('agent_name'), name: text }),
  z.strictObject({ kind: z.literal('agent_role'), role: text }),
  z.strictObject({ kind: z.literal('service_agents') }),
  z.strictObject({ kind: z.literal('stage_ids'), stages: z.array(StageId) }),
  z.strictObject({ kind: z.literal('stage_title'), contains: text }),
  z.strictObject({ kind: z.literal('action_tool'), tool: text }),
  z.strictObject({ kind: z.literal('action_kind'), action_kind: ActionKind }),
])
export type ViewSelector = z.infer<typeof ViewSelector>

export const ViewAction = z.enum(['collapse', 'hide', 'group', 'detail'])
export type ViewAction = z.infer<typeof ViewAction>

export const DetailLevel = z.enum(['stages', 'stages_and_agents', 'all_actions'])
export type DetailLevel = z.infer<typeof DetailLevel>

export const ViewRuleSource = z.enum(['chat', 'ui'])
export type ViewRuleSource = z.infer<typeof ViewRuleSource>

const ruleVariants = <S extends z.core.$ZodLooseShape>(shape: S) =>
  [
    z.strictObject({ ...shape, action: z.literal('collapse'), selector: ViewSelector, params: z.null() }),
    z.strictObject({ ...shape, action: z.literal('hide'), selector: ViewSelector, params: z.null() }),
    z.strictObject({
      ...shape,
      action: z.literal('group'),
      selector: ViewSelector,
      params: z.strictObject({ name: text }),
    }),
    z.strictObject({
      ...shape,
      action: z.literal('detail'),
      selector: ViewSelector,
      params: z.strictObject({ level: DetailLevel }),
    }),
  ] as const

export const ViewRuleSpec = z.union(ruleVariants({}))
export type ViewRuleSpec = z.infer<typeof ViewRuleSpec>

export const ViewRule = z.union(
  ruleVariants({
    id: ViewRuleId,
    run: RunId,
    source: ViewRuleSource,
    created_at: EpochNs,
    revoked_at: EpochNs.nullable(),
  }),
)
export type ViewRule = z.infer<typeof ViewRule>
