import { z } from 'zod'
import { FactId, ObserverCallId } from './primitives.js'

export const WaitReason = z.enum(['human', 'background', 'idle', 'unknown'])
export type WaitReason = z.infer<typeof WaitReason>

export const ExecutionState = z.enum(['planned', 'running', 'waiting', 'done', 'failed', 'cancelled', 'unknown'])
export type ExecutionState = z.infer<typeof ExecutionState>

export const Execution = z.union([
  z.strictObject({ state: ExecutionState.exclude(['waiting']) }),
  z.strictObject({ state: z.literal('waiting'), reason: WaitReason }),
])
export type Execution = z.infer<typeof Execution>

export const Interpreter = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rule'), rule: z.string().min(1) }),
  z.strictObject({ kind: z.literal('llm'), call: ObserverCallId }),
])
export type Interpreter = z.infer<typeof Interpreter>

export const BasisKind = z.enum(['observed', 'claimed', 'interpreted'])
export type BasisKind = z.infer<typeof BasisKind>

export const Basis = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observed') }),
  z.strictObject({ kind: z.literal('claimed') }),
  z.strictObject({ kind: z.literal('interpreted'), interpreter: Interpreter }),
])
export type Basis = z.infer<typeof Basis>

export const HumanDecision = z.enum(['none', 'requested', 'approved', 'rejected', 'answered', 'unknown'])
export type HumanDecision = z.infer<typeof HumanDecision>

export const Evidence = z.array(FactId)
export type Evidence = z.infer<typeof Evidence>

export const assessed = <T extends z.ZodType>(value: T) =>
  z.strictObject({
    value,
    basis: Basis,
    evidence: Evidence,
  })

export interface Assessed<T> {
  value: T
  basis: Basis
  evidence: Evidence
}
