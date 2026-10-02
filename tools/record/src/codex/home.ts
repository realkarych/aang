import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const codexHookEvents: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
]

export interface CodexHomeOptions {
  readonly provider: string
  readonly otlp: string
  readonly hook: string
  readonly spool: string
}

const posixQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

const hookCommand = (hook: string, spool: string): string => {
  const words = [hook, 'codex', 'user', spool]
  return process.platform === 'win32' ? `& ${words.map(powershellQuote).join(' ')}` : words.map(posixQuote).join(' ')
}

const tomlString = (value: string): string => JSON.stringify(value.replaceAll('\\', '/'))

export const writeCodexHome = async (codexHome: string, options: CodexHomeOptions): Promise<void> => {
  await writeFile(join(codexHome, 'config.toml'), [
    'model_provider = "aang_stub"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'check_for_update_on_startup = false',
    '',
    '[features]',
    'plugins = false',
    '',
    '[model_providers.aang_stub]',
    'name = "aang stub"',
    `base_url = ${tomlString(options.provider)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[otel]',
    'log_user_prompt = false',
    `exporter = { otlp-http = { endpoint = ${tomlString(options.otlp)}, protocol = "json" } }`,
    '',
  ].join('\n'))
  const command = hookCommand(options.hook, options.spool)
  const hooks = Object.fromEntries(codexHookEvents.map((event) => [event, [{ hooks: [{ type: 'command', command, timeout: 2 }] }]]))
  await writeFile(join(codexHome, 'hooks.json'), `${JSON.stringify({ hooks }, null, 2)}\n`)
}
