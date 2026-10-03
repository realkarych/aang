import { EpochNs, ModelVersion, type ObserverErrorClass, type ObserverInput, type ObserverState, RunId, type Runtime } from '@aang/contract'
import type { ObserverCallError } from '@aang/store'
import { z } from 'zod'
import type { LaunchErrorClass, LaunchFailure } from './backend.js'

export interface RecoveryLimits {
  readonly backoffMs: number
  readonly backoffMaxMs: number
  readonly backoffAttempts: number
  readonly authCheckMs: number
  readonly probeMs: number
  readonly probeMaxMs: number
}

export type Health =
  | { readonly kind: 'ok' }
  | { readonly kind: 'backoff'; readonly attempt: number; readonly until: number }
  | { readonly kind: 'auth'; readonly retryAt: number }
  | { readonly kind: 'limit' | 'transient'; readonly retryAt: number; readonly intervalMs: number }

export type Unavailable = Extract<Health, { readonly retryAt: number }>

export const healthy: Health = { kind: 'ok' }

const StoredHealth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('backoff'), attempt: z.int().positive(), until: z.int() }),
  z.strictObject({ kind: z.literal('auth'), retryAt: z.int() }),
  z.strictObject({ kind: z.enum(['limit', 'transient']), retryAt: z.int(), intervalMs: z.int().positive() }),
])

export const recoverySetting = (runtime: Runtime): string => `observer_recovery_${runtime}`

export const storedHealth = (value: unknown): Health => (value === undefined ? healthy : StoredHealth.parse(value))

const unavailable = (
  health: Health,
  kind: 'limit' | 'transient',
  now: number,
  limits: RecoveryLimits,
  resetsAt?: number,
): Health => {
  if (health.kind !== 'limit' && health.kind !== 'transient') {
    return { kind, retryAt: resetsAt ?? now + limits.probeMs, intervalMs: limits.probeMs }
  }
  const intervalMs = Math.min(health.intervalMs * 2, limits.probeMaxMs)
  return { kind, retryAt: Math.max(now + intervalMs, resetsAt ?? 0), intervalMs }
}

export const afterFailure = (health: Health, failure: LaunchFailure, now: number, limits: RecoveryLimits): Health => {
  switch (failure.class) {
    case 'timeout':
    case 'network': {
      const attempt = health.kind === 'backoff' ? health.attempt + 1 : 1
      return health.kind === 'limit' || health.kind === 'transient' || attempt > limits.backoffAttempts
        ? unavailable(health, 'transient', now, limits)
        : { kind: 'backoff', attempt, until: now + Math.min(limits.backoffMs * 2 ** (attempt - 1), limits.backoffMaxMs) }
    }
    case 'limit':
      return unavailable(health, 'limit', now, limits, failure.resetsAt)
    case 'auth':
      return { kind: 'auth', retryAt: now + limits.authCheckMs }
    case 'invalid_output':
      return healthy
    default:
      return health
  }
}

export const afterAuthCheck = (failure: LaunchFailure | null, now: number, limits: RecoveryLimits): Health =>
  failure === null ? healthy : { kind: 'auth', retryAt: now + limits.authCheckMs }

export const waiting = (health: Health): health is Unavailable =>
  health.kind === 'auth' || health.kind === 'limit' || health.kind === 'transient'

const epochOf = (milliseconds: number): EpochNs => EpochNs.parse(BigInt(Math.trunc(milliseconds)) * 1_000_000n)

export const healthState = (health: Health): ObserverState | null => {
  switch (health.kind) {
    case 'ok':
      return null
    case 'backoff':
      return { state: 'backoff', attempt: health.attempt, until: epochOf(health.until) }
    default:
      return { state: 'unavailable', reason: health.kind, retry_at: epochOf(health.retryAt) }
  }
}

const storedClasses: Readonly<Record<LaunchErrorClass, ObserverErrorClass | null>> = {
  auth: 'auth',
  limit: 'limit',
  timeout: 'timeout',
  network: 'network',
  invalid_output: 'invalid_output',
  isolation: 'isolation',
  cli_missing: 'cli_missing',
  version_not_admitted: 'version_not_admitted',
  process_stuck: 'process_stuck',
  cancelled: null,
  unsafe_workdir: 'isolation',
  launcher_unavailable: 'cli_missing',
  admission_busy: 'version_not_admitted',
}

export const storedError = ({ class: kind, message }: LaunchFailure): ObserverCallError | null => {
  const stored = storedClasses[kind]
  return stored === null ? null : { class: stored, message }
}

const probeRun = RunId.parse('0'.repeat(32))

export const probeInput = (runtime: Runtime): ObserverInput => ({
  run: { id: probeRun, runtime, goal: null, brief: null, sessions: [], agents: [] },
  context: null,
  model: { version: ModelVersion.parse(0), stages: [], criteria: [], attention: [] },
  batch: { facts: [], collapsed: [], backlog: null, artifact_versions: [] },
  materials: [],
  previous_attempt: null,
})
