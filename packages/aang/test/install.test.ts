import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ClaudeScenario, type CodexScenario, type FakeCli, installFakeClaude, installFakeCodex } from '@aang/testkit'
import type { TestContext } from 'vitest'
import { describe, test } from 'vitest'
import { waitUntil } from './processes.js'
import { createSandbox, type Sandbox } from './sandbox.js'

const posix = process.platform !== 'win32'

interface Connected {
  readonly sandbox: Sandbox
  readonly workspace: string
  readonly claude: FakeCli<ClaudeScenario>
  readonly codex: FakeCli<CodexScenario>
  readonly pluginHooks: string
  readonly codexHooks: string
  readonly hookBinary: string
}

interface CommandHandler {
  readonly type: string
  readonly command: string
  readonly args?: readonly string[]
  readonly timeout: number
}

interface HooksDocument {
  readonly hooks: Readonly<Record<string, readonly { readonly hooks: readonly CommandHandler[] }[]>>
}

interface RunListing {
  readonly runs: readonly { readonly runtime: string }[]
}

const sample = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(new URL(`../../../docs/research/samples/${path}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>

const connect = async (
  onTestFinished: TestContext['onTestFinished'],
  config: Record<string, unknown> = {},
): Promise<Connected> => {
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'aang-install-')))
  onTestFinished(() => rm(outside, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const workspace = join(outside, 'work')
  await mkdir(workspace)
  const claude = installFakeClaude(join(outside, 'fakes'))
  const codex = installFakeCodex(join(outside, 'fakes'))
  const sandbox = await createSandbox(onTestFinished, {
    cli: { claude: claude.command, codex: codex.command },
    watch: { roots: [{ path: workspace }] },
    ...config,
  })
  return {
    sandbox,
    workspace,
    claude,
    codex,
    pluginHooks: join(sandbox.aangHome, 'claude-plugin', 'hooks', 'hooks.json'),
    codexHooks: join(sandbox.env.CODEX_HOME ?? '', 'hooks.json'),
    hookBinary: join(sandbox.aangHome, 'bin', 'aang-hook'),
  }
}

const readHooks = async (path: string): Promise<HooksDocument> => JSON.parse(await readFile(path, 'utf8')) as HooksDocument

const handlersOf = (document: HooksDocument, event: string): CommandHandler[] =>
  (document.hooks[event] ?? []).flatMap((group) => group.hooks)

const run = async (command: string, args: readonly string[], stdin: string): Promise<number | null> => {
  const child = spawn(command, args, { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin.end(stdin)
  const [code] = (await once(child, 'close')) as [number | null]
  return code
}

const runs = async ({ sandbox }: Connected): Promise<RunListing['runs']> => {
  const state = await sandbox.daemonState()
  const token = (await readFile(join(sandbox.aangHome, 'token'), 'utf8')).trim()
  const response = await fetch(`http://127.0.0.1:${String(state?.api.port ?? 0)}/api/runs`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return ((await response.json()) as RunListing).runs
}

const pluginCalls = (claude: FakeCli<ClaudeScenario>): string[][] =>
  claude.calls().filter((call) => call.command === 'plugin').map((call) => call.argv)

describe.runIf(posix).concurrent('aang install and uninstall connect Claude Code and Codex to aang', () => {
  test('install registers the plugin and the Codex hooks, and their commands deliver events to the running daemon', async ({
    expect,
    onTestFinished,
  }) => {
    const connected = await connect(onTestFinished)
    const { sandbox, workspace, claude, codex, pluginHooks, codexHooks, hookBinary } = connected
    const pluginDirectory = join(sandbox.aangHome, 'claude-plugin')
    expect((await sandbox.aang('start')).code).toBe(0)

    const installed = await sandbox.aang('install')

    expect(installed).toEqual({
      code: 0,
      stdout: [
        `claude: plugin aang@aang installed from ${pluginDirectory}`,
        'claude: plugin aang@aang is enabled',
        `codex: aang hooks registered in ${codexHooks}`,
        'codex: aang hooks are not trusted yet; trust them in Codex with /hooks, until then Codex skips them',
        '',
      ].join('\n'),
      stderr: '',
    })
    expect(pluginCalls(claude)).toEqual([
      ['plugin', 'marketplace', 'add', pluginDirectory, '--scope', 'user', '--json'],
      ['plugin', 'install', 'aang@aang', '--scope', 'user', '--json'],
      ['plugin', 'list', '--json'],
    ])
    const appServers = codex.calls().filter((call) => call.command === 'app_server')
    expect(appServers).toHaveLength(3)
    expect(appServers.map((call) => call.env.CODEX_HOME)).toEqual(Array(3).fill(sandbox.env.CODEX_HOME))

    const [pluginHandler] = handlersOf(await readHooks(pluginHooks), 'SessionStart')
    expect(pluginHandler).toEqual({
      type: 'command',
      command: hookBinary,
      args: ['claude', 'plugin', sandbox.spool],
      timeout: 2,
    })
    const codexHandlers = handlersOf(await readHooks(codexHooks), 'SessionStart')
    expect(codexHandlers).toEqual([
      { type: 'command', command: `'${hookBinary}' codex user '${sandbox.spool}'`, timeout: 2 },
    ])
    const claudeStart = await sample('claude-code-hooks/SessionStart.startup.json')
    const { stdin: codexStart } = (await sample('codex-cli/hooks/SessionStart.startup.json')) as {
      readonly stdin: Record<string, unknown>
    }

    expect(
      await run(
        pluginHandler?.command ?? '',
        pluginHandler?.args ?? [],
        JSON.stringify({ ...claudeStart, session_id: 'g12-install-claude', cwd: workspace }),
      ),
    ).toBe(0)
    expect(
      await run(
        '/bin/sh',
        ['-c', codexHandlers[0]?.command ?? ''],
        JSON.stringify({ ...codexStart, session_id: '01a0f75c-caa3-7032-aff1-00000000a612', cwd: workspace }),
      ),
    ).toBe(0)

    await waitUntil(async () => (await runs(connected)).length === 2)
    expect((await runs(connected)).map((listed) => listed.runtime).sort()).toEqual(['claude', 'codex'])
    expect((await sandbox.aang('stop')).code).toBe(0)
  })

  test('install --codex reports the trust state, and a repeated install keeps the registered command', async ({
    expect,
    onTestFinished,
  }) => {
    const { sandbox, claude, codex, codexHooks } = await connect(onTestFinished)
    const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-done', timeout: 5 }] }] } }
    await mkdir(sandbox.env.CODEX_HOME ?? '', { recursive: true })
    await writeFile(codexHooks, JSON.stringify(foreign))

    const first = await sandbox.aang('install', '--codex')

    expect(first.code).toBe(0)
    const backup = /; the previous file is kept in (.+)$/m.exec(first.stdout)?.[1] ?? ''
    expect(JSON.parse(await readFile(backup, 'utf8'))).toEqual(foreign)
    expect(first.stdout).toContain('codex: aang hooks are not trusted yet; trust them in Codex with /hooks')
    const registered = await readFile(codexHooks, 'utf8')
    expect(handlersOf(JSON.parse(registered) as HooksDocument, 'Stop')[0]).toEqual(foreign.hooks.Stop[0]?.hooks[0])
    expect(pluginCalls(claude)).toEqual([])

    codex.setScenario({ hooks: 'trusted' })
    const trusted = await sandbox.aang('install', '--codex')

    expect(trusted).toEqual({
      code: 0,
      stdout: `codex: aang hooks registered in ${codexHooks}\ncodex: aang hooks are trusted and active\n`,
      stderr: '',
    })
    expect(await readFile(codexHooks, 'utf8')).toBe(registered)

    codex.setScenario({ hooks: 'disabled' })
    const disabled = await sandbox.aang('install', '--codex')

    expect(disabled.code).toBe(0)
    expect(disabled.stdout).toContain('codex: aang hooks are trusted but disabled; enable them in Codex with /hooks\n')

    codex.setScenario({ hooks: 'unlisted' })
    const unlisted = await sandbox.aang('install', '--codex')

    expect(unlisted.code).toBe(1)
    expect(unlisted.stdout).toContain(
      'codex: aang hooks are not listed by codex app-server after the installation, so Codex does not load them\n',
    )
  })

  test('install --claude touches only the plugin', async ({ expect, onTestFinished }) => {
    const { sandbox, claude, codex, codexHooks } = await connect(onTestFinished)

    const installed = await sandbox.aang('install', '--claude')

    expect(installed.code).toBe(0)
    expect(installed.stdout).toContain('claude: plugin aang@aang is enabled\n')
    expect(installed.stdout).not.toContain('codex:')
    expect(pluginCalls(claude)).toHaveLength(3)
    expect(codex.calls()).toEqual([])
    await expect(readFile(codexHooks)).rejects.toThrow()
  })

  test('uninstall removes the plugin and neutralizes the Codex hooks', async ({
    expect,
    onTestFinished,
  }) => {
    const { sandbox, claude, pluginHooks, codexHooks } = await connect(onTestFinished)
    expect((await sandbox.aang('install')).code).toBe(0)

    const removed = await sandbox.aang('uninstall')

    const backup = /; the previous file is kept in (.+)$/m.exec(removed.stdout)?.[1] ?? ''
    expect(removed).toEqual({
      code: 0,
      stdout: [
        'claude: plugin aang@aang and its marketplace are removed',
        `codex: aang hooks neutralized in ${codexHooks}; the previous file is kept in ${backup}`,
        '',
      ].join('\n'),
      stderr: '',
    })
    expect(pluginCalls(claude).slice(3)).toEqual([
      ['plugin', 'uninstall', 'aang@aang', '--scope', 'user', '--json'],
      ['plugin', 'marketplace', 'remove', 'aang', '--scope', 'user', '--json'],
    ])
    await expect(readFile(pluginHooks)).rejects.toThrow()
    const neutralized = handlersOf(await readHooks(codexHooks), 'SessionStart')
    expect(neutralized).toEqual([{ type: 'command', command: 'true', timeout: 2 }])

    const again = await sandbox.aang('uninstall')

    expect(again).toEqual({
      code: 0,
      stdout: `claude: plugin aang@aang and its marketplace are removed\ncodex: no aang hooks in ${codexHooks}\n`,
      stderr: '',
    })
  })

  test('a runtime that fails is reported and the other one is still installed', async ({ expect, onTestFinished }) => {
    const { sandbox, claude, codexHooks } = await connect(onTestFinished)
    claude.setScenario({ pluginFailures: ['install'] })

    const installed = await sandbox.aang('install')

    expect(installed.code).toBe(1)
    expect(installed.stderr).toMatch(/^aang install: claude: claude plugin install aang@aang --scope user --json failed: /)
    expect(installed.stdout).toContain(`codex: aang hooks registered in ${codexHooks}\n`)
    expect(handlersOf(await readHooks(codexHooks), 'Stop')).toHaveLength(1)
  })

  test('a runtime CLI that cannot be started fails only its own runtime', async ({ expect, onTestFinished }) => {
    const { sandbox, codexHooks } = await connect(onTestFinished, {
      cli: { claude: join(tmpdir(), 'aang-no-such-claude'), codex: join(tmpdir(), 'aang-no-such-codex') },
    })

    const installed = await sandbox.aang('install')
    const removed = await sandbox.aang('uninstall')

    expect(installed.code).toBe(1)
    expect(installed.stderr).toContain('aang install: claude: claude plugin marketplace add')
    expect(installed.stderr).toContain('aang install: codex: codex app-server:')
    expect(removed.code).toBe(1)
    expect(removed.stderr).toContain('aang uninstall: claude: claude plugin uninstall')
    expect(removed.stdout).toBe(`codex: no aang hooks in ${codexHooks}\n`)
  })
})

describe.concurrent('aang install and uninstall on any platform', () => {
  test.runIf(!posix)('installing and removing hooks is refused on Windows until it is enabled there', async ({
    expect,
    onTestFinished,
  }) => {
    const { sandbox, codexHooks } = await connect(onTestFinished)

    const installed = await sandbox.aang('install')
    const removed = await sandbox.aang('uninstall')

    for (const [result, command] of [
      [installed, 'install'],
      [removed, 'uninstall'],
    ] as const) {
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`aang ${command}: claude: installing hooks on Windows is not enabled yet`)
      expect(result.stderr).toContain(`aang ${command}: codex: installing hooks on Windows is not enabled yet`)
    }
    await expect(readFile(codexHooks)).rejects.toThrow()
  })

  test.for([
    { args: ['install', 'claude'], message: 'aang install takes no positional arguments' },
    { args: ['install', '--all'], message: "Unknown option '--all'" },
    { args: ['uninstall', '--codex'], message: "Unknown option '--codex'" },
    { args: ['uninstall', 'now'], message: 'aang uninstall takes no arguments' },
  ])('aang $args is a usage error', async ({ args, message }, { expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.aang(...args)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
    expect(result.stderr).toContain('install [--claude] [--codex]')
  })
})
