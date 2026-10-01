import { z } from 'zod'
import { Runtime } from './primitives.js'

export const spoolFormat = {
  magic: 'aang-spool/1',
  headerFieldSeparator: ' ',
  headerLineTerminator: '\n',
  envAssignment: '=',
  envEntryTerminator: '\0',
} as const

export const spoolLayout = {
  temporaryDirectory: 'tmp',
  readyDirectory: 'new',
  stoppedMarker: 'stopped',
  leasePrefix: 'lease-',
} as const

export const RegistrationTag = z.enum(['plugin', 'user'])
export type RegistrationTag = z.infer<typeof RegistrationTag>

export const spoolEnvKeys = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT',
  'AI_AGENT',
  'CODEX_HOME',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
] as const
export const SpoolEnvKey = z.enum(spoolEnvKeys)
export type SpoolEnvKey = z.infer<typeof SpoolEnvKey>

export const SpoolEnv = z.partialRecord(SpoolEnvKey, z.string())
export type SpoolEnv = z.infer<typeof SpoolEnv>

export const SpoolHeader = z.strictObject({
  runtime: Runtime,
  registration: RegistrationTag,
  env: SpoolEnv,
})
export type SpoolHeader = z.infer<typeof SpoolHeader>
