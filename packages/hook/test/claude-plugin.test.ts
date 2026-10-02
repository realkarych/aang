import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  claudePluginState,
  HookInstallError,
  installClaudePlugin,
  uninstallClaudePlugin,
} from '@aang/hook'
import { describe, inject, test } from 'vitest'
import { cleanExit, readSpoolEvents, runProcess, typicalEnv, typicalPayload, withoutNames } from './hook.js'
import { createInstallHome, type InstallHome, readJson, sampleText } from './install.js'

interface Handler {
  readonly type: string
  readonly command: string
  readonly args: readonly string[]
  readonly timeout: number
}

interface PluginHooks {
  readonly hooks: Readonly<Record<string, readonly { readonly matcher: string; readonly hooks: readonly Handler[] }[]>>
}

const spikePlugin = JSON.parse(await sampleText('claude-code-hooks/plugin-used.json')) as {
  readonly _layout: { readonly 'hooks/hooks.json': PluginHooks }
}

const unregisteredEvents: readonly string[] = ['MessageDisplay', 'PreModelSwitch']

const expectedEvents = Object.keys(spikePlugin._layout['hooks/hooks.json'].hooks)
  .filter((event) => !unregisteredEvents.includes(event))
  .sort()

const binaries = inject('hookBinaries')

const install = (home: InstallHome, claude = home.fakeClaude().cli, hookBinarySource = binaries.plain) =>
  installClaudePlugin({ aangHome: home.aangHome, hookBinarySource, claude })

const installCalls = (home: InstallHome): string[][] => [
  ['plugin', 'marketplace', 'add', home.paths.claudePlugin, '--scope', 'user', '--json'],
  ['plugin', 'install', 'aang@aang', '--scope', 'user', '--json'],
]

const pluginSnapshot = async (home: InstallHome): Promise<Record<string, Buffer>> => {
  const files = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json']
  return Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, await readFile(join(home.paths.claudePlugin, file))] as const)),
  )
}

describe.skipIf(process.platform === 'win32')('Claude plugin installation through the local marketplace', () => {
  test('install copies the binary unchanged into AANG_HOME/bin, generates the plugin and registers it in user scope', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const claude = home.fakeClaude()

    const installation = await install(home, claude.cli)

    expect(installation).toEqual({ binary: join(home.aangHome, 'bin', 'aang-hook'), plugin: home.paths.claudePlugin })
    expect(home.paths.claudePlugin).toBe(join(home.aangHome, 'claude-plugin'))
    expect(await readFile(installation.binary)).toEqual(await readFile(binaries.plain))
    expect(claude.argv()).toEqual(installCalls(home))
    expect(await claudePluginState(claude.cli)).toBe('enabled')
  })

  test('the plugin registers every Claude event except Worktree*, MessageDisplay and PreModelSwitch in exec form with the absolute paths of AANG_HOME', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)

    await install(home)

    const plugin = (await readJson(home.pluginHooksFile)) as PluginHooks
    expect(Object.keys(plugin.hooks).sort()).toEqual(expectedEvents)
    expect(expectedEvents.some((event) => event.startsWith('Worktree'))).toBe(false)
    for (const groups of Object.values(plugin.hooks)) {
      expect(groups).toEqual([
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: join(home.aangHome, 'bin', 'aang-hook'),
              args: ['claude', 'plugin', join(home.aangHome, 'spool')],
              timeout: 2,
            },
          ],
        },
      ])
    }
  })

  test('a handler of the generated plugin, launched without a shell as Claude does, records the event in the spool of the overridden AANG_HOME', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    await install(home)
    const [handler] = ((await readJson(home.pluginHooksFile)) as PluginHooks).hooks.PermissionRequest?.[0]?.hooks ?? []
    expect(handler).toBeDefined()

    const result = await runProcess(handler?.command ?? '', handler?.args ?? [], { env: typicalEnv })

    expect(result).toEqual(cleanExit)
    expect(withoutNames(await readSpoolEvents(home.paths.spool))).toEqual([
      { header: { runtime: 'claude', registration: 'plugin', env: typicalEnv }, payload: typicalPayload },
    ])
  })

  test('repeated install is idempotent and an install with an updated binary replaces only the binary', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const claude = home.fakeClaude()
    await install(home, claude.cli)
    const plugin = await pluginSnapshot(home)
    const hooksModified = (await stat(home.pluginHooksFile)).mtimeMs

    await install(home, claude.cli)
    await install(home, claude.cli, binaries.stripped)

    expect(await pluginSnapshot(home)).toEqual(plugin)
    expect((await stat(home.pluginHooksFile)).mtimeMs).toBe(hooksModified)
    expect(await readFile(home.paths.binary)).toEqual(await readFile(binaries.stripped))
    expect(claude.argv()).toEqual([...installCalls(home), ...installCalls(home), ...installCalls(home)])
    expect(await claudePluginState(claude.cli)).toBe('enabled')
  })

  test('the plugin state follows a plugin disabled by the user, and install enables it again', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const claude = home.fakeClaude()
    expect(await claudePluginState(claude.cli)).toBe('not_installed')
    await install(home, claude.cli)

    await claude.run(['plugin', 'disable', 'aang@aang'])

    expect(await claudePluginState(claude.cli)).toBe('disabled')
    await install(home, claude.cli)
    expect(await claudePluginState(claude.cli)).toBe('enabled')
  })

  test('a configured Claude config directory reaches every claude call as CLAUDE_CONFIG_DIR', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const claude = home.fakeClaude()
    const configDir = join(home.root, 'claude config')

    await install(home, { ...claude.cli, configDir })
    await install(home, claude.cli)

    expect(claude.calls().map((call) => call.env.CLAUDE_CONFIG_DIR)).toEqual([
      configDir,
      configDir,
      process.env.CLAUDE_CONFIG_DIR,
      process.env.CLAUDE_CONFIG_DIR,
    ])
  })

  test('uninstall removes the plugin, its marketplace and the generated files, and can be repeated', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const claude = home.fakeClaude()
    await install(home, claude.cli)

    await uninstallClaudePlugin({ aangHome: home.aangHome, claude: claude.cli })
    await uninstallClaudePlugin({ aangHome: home.aangHome, claude: claude.cli })

    const uninstallCalls = [
      ['plugin', 'uninstall', 'aang@aang', '--scope', 'user', '--json'],
      ['plugin', 'marketplace', 'remove', 'aang', '--scope', 'user', '--json'],
    ]
    expect(claude.argv()).toEqual([...installCalls(home), ...uninstallCalls, ...uninstallCalls])
    expect(await claudePluginState(claude.cli)).toBe('not_installed')
    await expect(stat(home.paths.claudePlugin)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a failing claude call stops the install with the reason reported by claude', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const claude = home.fakeClaude({ pluginFailures: ['install'] })

    const installing = install(home, claude.cli)

    await expect(installing).rejects.toBeInstanceOf(HookInstallError)
    await expect(installing).rejects.toMatchObject({
      reason: 'claude_cli',
      message: expect.stringContaining('fake claude: scenario: install fails') as unknown,
    })
    expect(claude.argv()).toEqual(installCalls(home))
  })

  test('a missing claude CLI or one that is not Claude Code fails install, uninstall and the state check', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const missing = { command: join(home.root, 'missing', 'claude'), configDir: null }
    const notClaude = { command: process.execPath, configDir: null }
    const failingList = home.fakeClaude({ pluginFailures: ['list'] }).cli

    await expect(install(home, missing)).rejects.toMatchObject({ reason: 'claude_cli' })
    await expect(install(home, notClaude)).rejects.toMatchObject({
      reason: 'claude_cli',
      message: expect.stringContaining('claude plugin marketplace add') as unknown,
    })
    await expect(uninstallClaudePlugin({ aangHome: home.aangHome, claude: notClaude })).rejects.toMatchObject({
      reason: 'claude_cli',
    })
    await expect(claudePluginState(failingList)).rejects.toMatchObject({ reason: 'claude_cli' })
  })
})
