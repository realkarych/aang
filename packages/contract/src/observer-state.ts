import { z } from 'zod'
import { TokenUsage } from './facts.js'
import { EpochNs, FactId, JsonValue, ModelVersion, ObserverCallId, RunId, Runtime } from './primitives.js'

const text = z.string()
const count = z.int().nonnegative()

export const ObserverUnavailableReason = z.enum(['auth', 'auth_path_broken', 'limit', 'transient', 'process_stuck'])
export type ObserverUnavailableReason = z.infer<typeof ObserverUnavailableReason>

export const ObserverDisabledReason = z.enum([
  'isolation',
  'cli_missing',
  'version_not_admitted',
  'admission_failed',
  'self_check_failed',
  'unsafe_workdir',
  'launcher_unavailable',
])
export type ObserverDisabledReason = z.infer<typeof ObserverDisabledReason>

export const ObserverLagReason = z.enum(['budget', 'backlog'])
export type ObserverLagReason = z.infer<typeof ObserverLagReason>

export const ObserverState = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ok') }),
  z.strictObject({ state: z.literal('lagging'), reason: ObserverLagReason }),
  z.strictObject({ state: z.literal('backoff'), attempt: z.int().positive(), until: EpochNs }),
  z.strictObject({ state: z.literal('unavailable'), reason: ObserverUnavailableReason, retry_at: EpochNs.nullable() }),
  z.strictObject({ state: z.literal('disabled'), reason: ObserverDisabledReason }),
])
export type ObserverState = z.infer<typeof ObserverState>

export const AdmissionOutcome = z.enum(['admitted', 'failed', 'pending'])
export type AdmissionOutcome = z.infer<typeof AdmissionOutcome>

export const Admission = z.strictObject({
  vendor: Runtime,
  cli_version: z.string().min(1),
  outcome: AdmissionOutcome,
  failure: text.nullable(),
  cross_session_inbound_verified: z.boolean(),
  checked_at: EpochNs,
})
export type Admission = z.infer<typeof Admission>

export const ObserverRunState = z.strictObject({
  state: ObserverState,
  pending_facts: count,
  deferred_facts: count,
  not_interpreted_facts: count,
  oldest_pending_at: EpochNs.nullable(),
  last_success_at: EpochNs.nullable(),
  isolation_unverified: z.boolean(),
})
export type ObserverRunState = z.infer<typeof ObserverRunState>

export const ObserverCallKind = z.enum(['batch', 'chat', 'probe', 'admission', 'auth_status'])
export type ObserverCallKind = z.infer<typeof ObserverCallKind>

export const ObserverCallOutcome = z.enum(['running', 'accepted', 'rejected', 'failed'])
export type ObserverCallOutcome = z.infer<typeof ObserverCallOutcome>

export const ObserverErrorClass = z.enum([
  'auth',
  'limit',
  'timeout',
  'network',
  'invalid_output',
  'isolation',
  'cli_missing',
  'version_not_admitted',
  'process_stuck',
])
export type ObserverErrorClass = z.infer<typeof ObserverErrorClass>

export const ObserverRejectionCause = z.enum([
  'schema',
  'version',
  'conflict',
  'reference',
  'scope',
  'invariant',
  'limit',
])
export type ObserverRejectionCause = z.infer<typeof ObserverRejectionCause>

export const ObserverRejection = z.strictObject({
  op_index: count.nullable(),
  cause: ObserverRejectionCause,
  message: text,
})
export type ObserverRejection = z.infer<typeof ObserverRejection>

export const CallUsage = z.strictObject({
  model: text.nullable(),
  tokens: TokenUsage.nullable(),
  cost_usd: z.number().nonnegative().nullable(),
})
export type CallUsage = z.infer<typeof CallUsage>

export const ObserverCall = z.strictObject({
  id: ObserverCallId,
  run: RunId.nullable(),
  kind: ObserverCallKind,
  vendor: Runtime,
  cli_version: text.nullable(),
  model: text.nullable(),
  base_version: ModelVersion.nullable(),
  result_version: ModelVersion.nullable(),
  facts: z.array(FactId),
  attempt: z.int().positive(),
  outcome: ObserverCallOutcome,
  error: z
    .strictObject({
      class: ObserverErrorClass,
      message: text,
    })
    .nullable(),
  rejections: z.array(ObserverRejection),
  output: JsonValue.nullable(),
  usage: CallUsage.nullable(),
  started_at: EpochNs,
  ended_at: EpochNs.nullable(),
  latency_ms: count.nullable(),
  needs_latency_ms: count.nullable(),
})
export type ObserverCall = z.infer<typeof ObserverCall>
