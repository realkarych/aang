import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { hookBinaryName } from '@aang/hook'
import { cleanup } from './cleanup.js'
import { collect } from './collect.js'
import type { RootOverrides } from './files.js'
import { defaultChecklistDir } from './layout.js'
import { prepare } from './prepare.js'
import { ClaudeRegistration } from './state.js'

const usage = [
  'usage: node tools/owner-checklist/dist/main.js <prepare|collect|cleanup> [options]',
  '  common:  --dir <path>                 checklist directory (default: <os tmpdir>/aang-d7)',
  '  prepare: --hook <path>                aang-hook to copy (default: packages/hook/bin/aang-hook)',
  '           --hours <n>                  spool lease length in hours (default: 24)',
  '           --claude <marketplace|plugin-dir>  (default: marketplace on macOS and Linux, plugin-dir on Windows)',
  '           --claude-command <path>      claude executable for marketplace mode (default: claude)',
  '           --codex-hooks                append aang entries to $CODEX_HOME/hooks.json (Codex Desktop on macOS)',
  '           --codex-home <path>          Codex home (default: $CODEX_HOME or ~/.codex)',
  '  collect: --claude-config-dir <path>   Claude root (default: $CLAUDE_CONFIG_DIR or ~/.claude)',
  '           --codex-home <path>          Codex root (default: $CODEX_HOME or ~/.codex)',
  '           --claude-desktop-dir <path>  Claude Desktop claude-code-sessions directory (default on macOS)',
  '           --all-sessions               keep sessions whose cwd is outside the checklist directory',
  '  cleanup: --keep-results               keep <dir>/results; accepts the collect root options',
].join('\n')

const commands: readonly string[] = ['prepare', 'collect', 'cleanup']

const repositoryHook = fileURLToPath(new URL(`../../../packages/hook/bin/${hookBinaryName}`, import.meta.url))

const parse = () =>
  parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      hook: { type: 'string' },
      hours: { type: 'string' },
      claude: { type: 'string' },
      'claude-command': { type: 'string' },
      'codex-hooks': { type: 'boolean', default: false },
      'codex-home': { type: 'string' },
      'claude-config-dir': { type: 'string' },
      'claude-desktop-dir': { type: 'string' },
      'keep-results': { type: 'boolean', default: false },
      'all-sessions': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

type Values = ReturnType<typeof parse>['values']

const absolute = (path: string | undefined): string | undefined => (path === undefined ? undefined : resolve(path))

const environmentPath = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

const leaseHours = (text: string | undefined): number => {
  const hours = Number(text ?? '24')
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`--hours: ожидается положительное число, получено ${text ?? ''}`)
  }
  return hours
}

const claudeRegistration = (text: string | undefined): ClaudeRegistration => {
  const parsed = ClaudeRegistration.safeParse(text ?? (process.platform === 'win32' ? 'plugin-dir' : 'marketplace'))
  if (!parsed.success) {
    throw new Error(`--claude: ожидается marketplace или plugin-dir, получено ${text ?? ''}`)
  }
  return parsed.data
}

const run = (command: string, values: Values): Promise<string[]> => {
  const dir = resolve(values.dir ?? defaultChecklistDir())
  const roots: RootOverrides = {
    claudeConfigDir: absolute(values['claude-config-dir']),
    codexHome: absolute(values['codex-home']),
    claudeDesktopDir: absolute(values['claude-desktop-dir']),
  }
  if (command === 'prepare') {
    return prepare({
      dir,
      hookSource: resolve(values.hook ?? repositoryHook),
      hours: leaseHours(values.hours),
      claude: claudeRegistration(values.claude),
      claudeCommand: values['claude-command'] ?? 'claude',
      codexHooks: values['codex-hooks'],
      codexHome: roots.codexHome ?? environmentPath('CODEX_HOME') ?? join(homedir(), '.codex'),
    })
  }
  if (command === 'collect') {
    return collect({ dir, roots, allSessions: values['all-sessions'] })
  }
  return cleanup({ dir, keepResults: values['keep-results'], roots })
}

try {
  const { positionals, values } = parse()
  const [command, ...extra] = positionals
  if (values.help) {
    process.stdout.write(`${usage}\n`)
  } else if (command === undefined || !commands.includes(command) || extra.length > 0) {
    process.stderr.write(`${usage}\n`)
    process.exitCode = 2
  } else {
    process.stdout.write(`${(await run(command, values)).join('\n')}\n`)
  }
} catch (error) {
  process.stderr.write(`ошибка: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
