import type { FactDraft, JsonValue, PlanItemStatus } from '@aang/contract'
import { z } from 'zod'
import { actionEntity, type CallTiming, fact, type LineContext, type LineFacts, runtimeIds, threadEntity } from './facts.js'

export const planTool = 'update_plan'

const itemStatuses: ReadonlyMap<string, PlanItemStatus> = new Map([
  ['pending', 'pending'],
  ['in_progress', 'in_progress'],
  ['completed', 'completed'],
])

const UpdatePlan = z.looseObject({
  explanation: z.string().nullish(),
  plan: z.array(z.looseObject({ step: z.string(), status: z.string().nullish() })),
})

const ThreadGoalUpdated = z.looseObject({
  goal: z.looseObject({ objective: z.string() }),
})

export const planUpdated = (context: LineContext, call: string, timing: CallTiming, input: JsonValue): FactDraft[] => {
  const parsed = UpdatePlan.safeParse(input)
  if (!parsed.success) {
    return []
  }
  const { explanation, plan } = parsed.data
  const text = explanation ?? ''
  return [
    fact(
      'plan_update',
      {
        entity: actionEntity(context.stream, call),
        speaker: 'solver',
        urgent: true,
        at: timing.at,
        ids: runtimeIds(context, { turn_id: timing.turn, call_id: call }),
        verified: timing.verified,
      },
      {
        source: 'rollout_plan',
        text: text === '' ? null : text,
        items: plan.map(({ step, status }) => ({
          id: null,
          text: step,
          status: itemStatuses.get(status ?? '') ?? 'unknown',
        })),
      },
    ),
  ]
}

export const threadGoalUpdated = (context: LineContext): LineFacts => {
  const parsed = ThreadGoalUpdated.safeParse(context.line.payload)
  return parsed.success
    ? [
        fact(
          'plan_update',
          {
            entity: threadEntity(context.stream),
            speaker: 'runtime',
            urgent: true,
            at: context.line.at,
            ids: runtimeIds(context),
            verified: false,
          },
          { source: 'thread_goal', text: parsed.data.goal.objective, items: [] },
        ),
      ]
    : null
}
