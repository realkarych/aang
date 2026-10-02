import { z } from 'zod'
import { ObservationObjects, RunSummary, RunView, StatusResponse } from './api.js'
import { ChatMessage } from './chat.js'
import { Fact } from './facts.js'
import { ModelChange, ModelVersionRecord } from './journal.js'
import { AttentionItem, Binding } from './model.js'
import { ObservationRemoval } from './observation.js'
import { ChangeSeq, RunId } from './primitives.js'
import { AttentionView } from './view.js'

export const streamPath = '/api/stream'

export const StreamQuery = z.strictObject({
  run: RunId.optional(),
})
export type StreamQuery = z.infer<typeof StreamQuery>

export const RunDelta = z.strictObject({
  summary: RunSummary,
  view: RunView,
  bindings: z.array(Binding),
})
export type RunDelta = z.infer<typeof RunDelta>

export const FactsDelta = z.strictObject({
  run: RunId,
  facts: z.array(Fact),
  objects: ObservationObjects,
  removed: z.array(ObservationRemoval),
})
export type FactsDelta = z.infer<typeof FactsDelta>

export const ModelDelta = z.strictObject({
  run: RunId,
  version: ModelVersionRecord,
  changes: z.array(ModelChange),
})
export type ModelDelta = z.infer<typeof ModelDelta>

export const AttentionDelta = z.strictObject({
  run: RunId,
  items: z.array(AttentionItem),
  views: z.array(AttentionView),
})
export type AttentionDelta = z.infer<typeof AttentionDelta>

export const ChatDelta = z.strictObject({
  message: ChatMessage,
})
export type ChatDelta = z.infer<typeof ChatDelta>

export const ResetReason = z.enum(['stale_position', 'pruned', 'reparsed'])
export type ResetReason = z.infer<typeof ResetReason>

export const ResetSignal = z.strictObject({
  reason: ResetReason,
})
export type ResetSignal = z.infer<typeof ResetSignal>

export const SseEvent = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('run'), id: ChangeSeq, data: RunDelta }),
  z.strictObject({ event: z.literal('facts'), id: ChangeSeq, data: FactsDelta }),
  z.strictObject({ event: z.literal('model'), id: ChangeSeq, data: ModelDelta }),
  z.strictObject({ event: z.literal('attention'), id: ChangeSeq, data: AttentionDelta }),
  z.strictObject({ event: z.literal('chat'), id: ChangeSeq, data: ChatDelta }),
  z.strictObject({ event: z.literal('status'), id: ChangeSeq, data: StatusResponse }),
  z.strictObject({ event: z.literal('reset'), id: z.null(), data: ResetSignal }),
])
export type SseEvent = z.infer<typeof SseEvent>
export type SseEventName = SseEvent['event']
