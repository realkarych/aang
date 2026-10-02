export const probedEnvNames = [
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_AGENT_SDK_VERSION',
  'AI_AGENT',
] as const

export interface EnvProbeRecord {
  readonly received_at: string
  readonly session_id: string | null
  readonly hook_event_name: string | null
  readonly source: string | null
  readonly env: Readonly<Record<string, string>>
}
