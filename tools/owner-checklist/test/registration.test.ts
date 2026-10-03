import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudePluginId, claudePluginState } from '@aang/hook'
import { installFakeClaude } from '@aang/testkit'
import { describe, test } from 'vitest'
import {
  collect,
  createSandbox,
  prepare,
  readJson,
  resultFiles,
  runChecklist,
  runProcess,
  type Sandbox,
} from './checklist.js'

const codexEvents = [
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

type Groups = Record<string, unknown[]>

interface HooksDocument {
  readonly hooks: Groups
  readonly [key: string]: unknown
}

interface ChecklistState {
  readonly dir: string
  readonly codex: { readonly command: string; readonly backup: string | null } | null
  readonly claude: { readonly registered: boolean }
}

const foreignHooks: HooksDocument = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'python3 /opt/logger.py SessionStart', timeout: 5 }] },
      { hooks: [{ type: 'command', command: '~/src/aang/bin/aang hook', timeout: 2 }] },
    ],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    Stop: [],
    CustomFutureEvent: [{ hooks: [{ type: 'command', command: 'echo custom' }] }],
  },
  other: { keep: true },
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

const stateOf = (sandbox: Sandbox): Promise<ChecklistState> => readJson<ChecklistState>(join(sandbox.dir, 'state.json'))

const cleanup = (sandbox: Sandbox, args: readonly string[] = []) =>
  runChecklist(sandbox, [
    'cleanup',
    '--dir',
    sandbox.dir,
    '--claude-config-dir',
    sandbox.claudeConfigDir,
    '--codex-home',
    sandbox.codexHome,
    '--claude-desktop-dir',
    sandbox.desktopDir,
    ...args,
  ])

describe.skipIf(process.platform === 'win32')('owner checklist registration on macOS and Linux', () => {
  test('--codex-hooks appends aang entries after foreign ones with a backup and cleanup restores the file', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const hooksFile = join(sandbox.codexHome, 'hooks.json')
    const original = `${JSON.stringify(foreignHooks, null, 4)}\n`
    await writeFile(hooksFile, original, { mode: 0o640 })

    const prepared = await prepare(sandbox, ['--claude', 'plugin-dir', '--codex-hooks'])
    expect(prepared.stderr).toBe('')
    expect(prepared.status).toBe(0)
    const state = await stateOf(sandbox)
    const command = state.codex?.command ?? ''
    expect(command).toBe(
      `'${join(state.dir, 'aang-home', 'bin', 'aang-hook')}' codex user '${join(state.dir, 'aang-home', 'spool')}'`,
    )
    const installed = await readJson<HooksDocument>(hooksFile)
    const ours = { hooks: [{ type: 'command', command, timeout: 2 }] }
    for (const event of codexEvents) {
      expect(installed.hooks[event], event).toEqual([...(foreignHooks.hooks[event] ?? []), ours])
    }
    expect(installed.hooks.CustomFutureEvent).toEqual(foreignHooks.hooks.CustomFutureEvent)
    expect(installed.other).toEqual({ keep: true })
    expect(((await stat(hooksFile)).mode & 0o777).toString(8)).toBe('640')
    expect(state.codex?.backup).toMatch(/hooks\.json\.aang-d7-backup-/)
    expect(await readFile(state.codex?.backup ?? '', 'utf8')).toBe(original)
    const outside = join(sandbox.home, 'aang-desktop-probe-outside')
    expect(await readdir(outside)).toEqual([])
    expect(prepared.stdout).toContain(outside)

    const payload = { session_id: 'codex-thread', hook_event_name: 'SessionStart', source: 'startup', cwd: state.dir }
    const delivered = await runProcess('/bin/sh', ['-c', command], { CODEX_HOME: sandbox.codexHome }, JSON.stringify(payload))
    expect(delivered).toEqual({ status: 0, stdout: '', stderr: '' })
    expect((await collect(sandbox)).status).toBe(0)
    const events = (await resultFiles(state.dir))['events.jsonl'] ?? ''
    expect(JSON.parse(events.trim())).toMatchObject({
      runtime: 'codex',
      registration: 'user',
      hook_event_name: 'SessionStart',
      session_id: 'codex-thread',
      env: { CODEX_HOME: join('~', '.codex') },
    })

    const cleaned = await cleanup(sandbox)
    expect(cleaned.stderr).toBe('')
    expect(cleaned.status).toBe(0)
    expect(await readFile(hooksFile, 'utf8')).toBe(original)
    expect(((await stat(hooksFile)).mode & 0o777).toString(8)).toBe('640')
    expect(cleaned.stdout).toContain(state.codex?.backup ?? '')
    expect(cleaned.stdout).toContain('config.toml')
    expect(await exists(outside)).toBe(false)
    expect(await exists(state.dir)).toBe(false)
  })

  test('cleanup deletes a hooks.json that prepare created and leaves later foreign entries in place', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const hooksFile = join(sandbox.codexHome, 'hooks.json')
    expect((await prepare(sandbox, ['--claude', 'plugin-dir', '--codex-hooks'])).status).toBe(0)
    const state = await stateOf(sandbox)
    expect(state.codex?.backup).toBeNull()
    expect(Object.keys((await readJson<HooksDocument>(hooksFile)).hooks).sort()).toEqual([...codexEvents].sort())

    const cleaned = await cleanup(sandbox)
    expect(cleaned.status).toBe(0)
    expect(await exists(hooksFile)).toBe(false)

    const again = await createSandbox(onTestFinished)
    const againFile = join(again.codexHome, 'hooks.json')
    expect((await prepare(again, ['--claude', 'plugin-dir', '--codex-hooks'])).status).toBe(0)
    const later = await readJson<HooksDocument>(againFile)
    const foreign = { hooks: [{ type: 'command', command: 'echo later', timeout: 1 }] }
    later.hooks.Stop?.push(foreign)
    await writeFile(againFile, JSON.stringify(later))

    expect((await cleanup(again)).status).toBe(0)
    const left = await readJson<HooksDocument>(againFile)
    expect(Object.keys(left.hooks)).toEqual(['Stop'])
    expect(left.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'true', timeout: 2 }] }, foreign])
  })

  test('marketplace mode installs the aang plugin in user scope with the claude CLI and cleanup uninstalls it', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const fake = installFakeClaude(join(sandbox.root, 'fakes'))
    const cli = { command: fake.command, configDir: null }

    const prepared = await prepare(sandbox, ['--claude', 'marketplace', '--claude-command', fake.command])
    expect(prepared.stderr).toBe('')
    expect(prepared.status).toBe(0)
    const state = await stateOf(sandbox)
    const pluginDir = join(state.dir, 'aang-home', 'claude-plugin')
    expect(fake.calls().map((call) => call.argv)).toEqual([
      ['plugin', 'list', '--json'],
      ['plugin', 'marketplace', 'add', pluginDir, '--scope', 'user', '--json'],
      ['plugin', 'install', claudePluginId, '--scope', 'user', '--json'],
    ])
    expect(await claudePluginState(cli)).toBe('enabled')
    expect(prepared.stdout).not.toContain('--plugin-dir')
    expect(state.claude.registered).toBe(true)

    const cleaned = await cleanup(sandbox)
    expect(cleaned.stderr).toBe('')
    expect(cleaned.status).toBe(0)
    expect(await claudePluginState(cli)).toBe('not_installed')
    expect(fake.calls().map((call) => call.argv.slice(0, 3))).toContainEqual(['plugin', 'uninstall', claudePluginId])
    expect(await exists(state.dir)).toBe(false)
  })

  test('marketplace mode refuses to take over an aang plugin that is already installed', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const fake = installFakeClaude(join(sandbox.root, 'fakes'))
    const cli = { command: fake.command, configDir: null }
    expect((await prepare(sandbox, ['--claude', 'marketplace', '--claude-command', fake.command])).status).toBe(0)
    const other = { ...sandbox, dir: join(sandbox.root, 'second') }

    const refused = await prepare(other, ['--claude', 'marketplace', '--claude-command', fake.command])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`плагин ${claudePluginId} уже есть`)
    expect(refused.stderr).toContain('cleanup')
    expect((await cleanup(other)).status).toBe(0)
    expect(await claudePluginState(cli)).toBe('enabled')
  })
})

describe.runIf(process.platform === 'win32')('owner checklist registration on Windows', () => {
  test('prepare refuses marketplace and Codex hooks registration before creating anything', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    for (const args of [['--claude', 'marketplace'], ['--claude', 'plugin-dir', '--codex-hooks']]) {
      const refused = await prepare(sandbox, args)
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain('ADR-0013')
      expect(await exists(sandbox.dir)).toBe(false)
    }
    expect(await exists(join(sandbox.codexHome, 'hooks.json'))).toBe(false)
  })
})
