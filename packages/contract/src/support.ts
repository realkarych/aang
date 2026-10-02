import { z } from 'zod'
import { Surface } from './facts.js'
import { Runtime } from './primitives.js'

const name = z.string().min(1)

export const supportMatrixFormat = 'aang-support-matrix/1'

export const OperatingSystem = z.enum(['macos', 'linux', 'windows'])
export type OperatingSystem = z.infer<typeof OperatingSystem>

export const Placement = z.enum(['local', 'docker', 'vm', 'desktop_ssh'])
export type Placement = z.infer<typeof Placement>

export const SupportStatus = z.enum(['full', 'limited', 'unverified'])
export type SupportStatus = z.infer<typeof SupportStatus>

export const CheckResult = z.enum(['passed', 'failed', 'not_run'])
export type CheckResult = z.infer<typeof CheckResult>

export const SupportKey = z.strictObject({
  runtime: Runtime,
  surface: Surface,
  os: OperatingSystem,
  placement: Placement,
  engine_version: name,
})
export type SupportKey = z.infer<typeof SupportKey>

export const SupportScenarios = z.strictObject({
  during_work: CheckResult,
  after_iteration: CheckResult,
  resume: CheckResult,
  compaction: CheckResult,
  child_sessions: CheckResult,
  reconnect: CheckResult,
})
export type SupportScenarios = z.infer<typeof SupportScenarios>

export const ObserverIsolationResult = z.strictObject({
  admission: CheckResult,
  cross_session_inbound: CheckResult,
})
export type ObserverIsolationResult = z.infer<typeof ObserverIsolationResult>

export const SupportRow = z.strictObject({
  ...SupportKey.shape,
  app_version: name.nullable(),
  status: SupportStatus,
  gaps: z.array(name),
  scenarios: SupportScenarios,
  observer: ObserverIsolationResult,
  verified_on: z.iso.date().nullable(),
})
export type SupportRow = z.infer<typeof SupportRow>

const supportKeyText = (key: SupportKey): string =>
  JSON.stringify([key.runtime, key.surface, key.os, key.placement, key.engine_version])

export const SupportMatrix = z
  .strictObject({
    format: z.literal(supportMatrixFormat),
    rows: z.array(SupportRow),
  })
  .superRefine((matrix, context) => {
    const seen = new Set<string>()
    matrix.rows.forEach((row, index) => {
      const key = supportKeyText(row)
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', path: ['rows', index], message: `duplicate support key ${key}` })
      }
      seen.add(key)
    })
  })
export type SupportMatrix = z.infer<typeof SupportMatrix>
