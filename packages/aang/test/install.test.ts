import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ClaudeScenario, type CodexScenario, type FakeCli, installFakeClaude, installFakeCodex } from '@aang/testkit'
import type { TestContext } from 'vitest'
import { describe, test } from 'vitest'
import { isAlive, sleep, waitUntil } from './processes.js'
import { createSandbox, type Sandbox } from './sandbox.js'

const posix = process.platform !== 'win32'
const hookBinaryName = posix ? 'aang-hook' : 'aang-hook.exe'

interface Connected {
  readonly sandbox: Sandbox
  readonly workspace: string
  readonly claude: FakeCli<ClaudeScenario>
  readonly codex: FakeCli<CodexScenario>
  readonly codexHome: string
  readonly defaultCodexHome: string
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

interface StatusListing {
  readonly runtimes: readonly { readonly runtime: string; readonly hooks: string }[]
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
  const codexHome = join(outside, 'codex')
  const sandbox = await createSandbox(onTestFinished, {
    cli: { claude: claude.executable, codex: codex.executable },
    watch: { roots: [{ path: workspace }] },
    runtimes: { codex: { home: codexHome } },
    ...config,
  })
  return {
    sandbox,
    workspace,
    claude,
    codex,
    codexHome,
    defaultCodexHome: join(sandbox.env.HOME ?? '', '.codex'),
    pluginHooks: join(sandbox.aangHome, 'claude-plugin', 'hooks', 'hooks.json'),
    codexHooks: join(codexHome, 'hooks.json'),
    hookBinary: join(sandbox.aangHome, 'bin', hookBinaryName),
  }
}

const readHooks = async (path: string): Promise<HooksDocument> => JSON.parse(await readFile(path, 'utf8')) as HooksDocument

const powerShellQuoted = (value: string): string => `'${value.replaceAll("'", "''")}'`

const handlersOf = (document: HooksDocument, event: string): CommandHandler[] =>
  (document.hooks[event] ?? []).flatMap((group) => group.hooks)

const run = async (command: string, args: readonly string[], stdin: string): Promise<number | null> => {
  const env = posix ? { PATH: process.env.PATH ?? '' } : process.env
  const child = spawn(command, args, { env, stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin.end(stdin)
  const [code] = (await once(child, 'close')) as [number | null]
  return code
}

const readApi = async ({ sandbox }: Connected, path: string): Promise<unknown> => {
  const state = await sandbox.daemonState()
  const token = (await readFile(join(sandbox.aangHome, 'token'), 'utf8')).trim()
  const response = await fetch(`http://127.0.0.1:${String(state?.api.port ?? 0)}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return response.json()
}

const runs = async (connected: Connected): Promise<RunListing['runs']> =>
  ((await readApi(connected, '/api/runs')) as RunListing).runs

const daemonCodexHooks = async (connected: Connected): Promise<string | undefined> =>
  ((await readApi(connected, '/api/status')) as StatusListing).runtimes.find(({ runtime }) => runtime === 'codex')?.hooks

const appServers = (codex: FakeCli<CodexScenario>) => codex.calls().filter((call) => call.command === 'app_server')

const pluginCalls = (claude: FakeCli<ClaudeScenario>): string[][] =>
  claude.calls().filter((call) => call.command === 'plugin').map((call) => call.argv)

describe.runIf(posix).concurrent('aang install and uninstall connect Claude Code and Codex to aang', () => {
  test('install registers the plugin and the Codex hooks, and their commands deliver events to the running daemon', async ({
    expect,
    onTestFinished,
  }) => {
    const connected = await connect(onTestFinished)
    const { sandbox, workspace, claude, codex, codexHome, pluginHooks, codexHooks, hookBinary } = connected
    const pluginDirectory = join(sandbox.aangHome, 'claude-plugin')
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
    expect(appServers(codex).map((call) => call.env.CODEX_HOME)).toEqual(Array(2).fill(codexHome))

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
    expect((await sandbox.aang('start')).code).toBe(0)
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
    const { sandbox, claude, codex, codexHome, codexHooks } = await connect(onTestFinished)
    const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-done', timeout: 5 }] }] } }
    await mkdir(codexHome, { recursive: true })
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

  test.for([
    { via: 'the home directory', variable: false, linked: false },
    { via: 'CODEX_HOME', variable: true, linked: false },
    { via: 'a symlink in the aang config', variable: true, linked: true },
  ])(
    'install connects the default Codex profile reached through $via, keeps its foreign hooks and leaves no codex app-server running',
    async ({ variable, linked }, { expect, onTestFinished }) => {
      const { sandbox, claude, codex, codexHome, defaultCodexHome, hookBinary } = await connect(
        onTestFinished,
        linked ? {} : { runtimes: { codex: { home: null } } },
      )
      if (!variable) {
        delete sandbox.env.CODEX_HOME
      }
      const foreign = { type: 'command', command: 'notify-done', timeout: 5 }
      await mkdir(defaultCodexHome)
      await writeFile(
        join(defaultCodexHome, 'hooks.json'),
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [foreign] }],
            SessionStart: [{ hooks: [{ type: 'command', command: '/old/bin/aang hook', timeout: 2 }] }],
          },
        }),
      )
      if (linked) {
        await symlink(defaultCodexHome, codexHome)
      }
      const profile = linked ? codexHome : defaultCodexHome

      const installed = await sandbox.aang('install')

      expect(installed.code).toBe(0)
      expect(installed.stderr).toBe('')
      expect(installed.stdout).toContain('claude: plugin aang@aang is enabled\n')
      expect(installed.stdout).toContain(
        `codex: aang hooks registered in ${join(profile, 'hooks.json')}; the previous file is kept in `,
      )
      expect(installed.stdout).toContain('codex: aang hooks are not trusted yet; trust them in Codex with /hooks')
      expect(pluginCalls(claude)).toHaveLength(3)
      const registered = await readHooks(join(defaultCodexHome, 'hooks.json'))
      const aangHandler = { type: 'command', command: `'${hookBinary}' codex user '${sandbox.spool}'`, timeout: 2 }
      expect(handlersOf(registered, 'Stop')).toEqual([foreign, aangHandler])
      expect(handlersOf(registered, 'SessionStart')).toEqual([
        { type: 'command', command: 'true', timeout: 2 },
        aangHandler,
      ])
      expect(codex.calls()).toEqual(appServers(codex))
      expect(appServers(codex).map((call) => [call.env.CODEX_HOME, call.cwd])).toEqual(
        Array(2).fill([profile, defaultCodexHome]),
      )
      expect(appServers(codex).filter((call) => isAlive(call.pid))).toEqual([])
    },
  )

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
  test.runIf(!posix)(
    'on Windows install connects Claude Code and leaves Codex to its files, --codex installs the Codex hooks for PowerShell with a warning that status repeats, and uninstall removes both',
    { timeout: 120_000 },
    async ({ expect, onTestFinished }) => {
      const connected = await connect(onTestFinished)
      const { sandbox, workspace, codex, codexHome, pluginHooks, codexHooks, hookBinary } = connected
      const offByDefault =
        'codex: hooks are not installed by default on Windows: Codex sessions are observed from their files only, so approval waits are not visible'
      const slowdown = 'on Windows Codex starts PowerShell for every hook event, which slows each event by 0.25–0.4 s'

      const installed = await sandbox.aang('install')

      expect(installed).toEqual({
        code: 0,
        stdout: [
          `claude: plugin aang@aang installed from ${join(sandbox.aangHome, 'claude-plugin')}`,
          'claude: plugin aang@aang is enabled',
          offByDefault,
          `codex: \`aang install --codex\` installs them anyway; ${slowdown}`,
          '',
        ].join('\n'),
        stderr: '',
      })
      expect(codex.calls()).toEqual([])
      await expect(readFile(codexHooks)).rejects.toThrow()
      await mkdir(codexHome)
      expect((await sandbox.aang('start')).code).toBe(0)
      expect((await sandbox.aang('status')).stdout).toContain(
        `claude hooks: active\ncodex hooks: not installed\n${offByDefault}\n`,
      )
      expect(codex.calls()).toEqual([])

      const optedIn = await sandbox.aang('install', '--codex')

      expect(optedIn).toEqual({
        code: 0,
        stdout: [
          `codex: aang hooks registered in ${codexHooks}`,
          'codex: aang hooks are not trusted yet; trust them in Codex with /hooks, until then Codex skips them',
          `codex: ${slowdown}`,
          '',
        ].join('\n'),
        stderr: '',
      })
      const codexHandlers = handlersOf(await readHooks(codexHooks), 'SessionStart')
      expect(codexHandlers).toEqual([
        {
          type: 'command',
          command: `& ${[hookBinary, 'codex', 'user', sandbox.spool].map(powerShellQuoted).join(' ')}`,
          timeout: 2,
        },
      ])
      await waitUntil(async () => (await daemonCodexHooks(connected)) === 'untrusted')
      await sleep(5_000)
      expect(appServers(codex)).toHaveLength(2)
      expect((await sandbox.aang('status')).stdout).toContain(
        `codex hooks: not trusted; trust them in Codex with /hooks\ncodex: ${slowdown}\n`,
      )
      const [pluginHandler] = handlersOf(await readHooks(pluginHooks), 'SessionStart')
      const claudeStart = await sample('claude-code-hooks/SessionStart.startup.json')
      const { stdin: codexStart } = (await sample('codex-cli/hooks/SessionStart.startup.json')) as {
        readonly stdin: Record<string, unknown>
      }

      expect(
        await run(
          pluginHandler?.command ?? '',
          pluginHandler?.args ?? [],
          JSON.stringify({ ...claudeStart, session_id: 'g12-windows-claude', cwd: workspace }),
        ),
      ).toBe(0)
      expect(
        await run(
          'pwsh',
          ['-NoProfile', '-Command', codexHandlers[0]?.command ?? ''],
          JSON.stringify({ ...codexStart, session_id: '01a0f75c-caa3-7032-aff1-00000000a613', cwd: workspace }),
        ),
      ).toBe(0)

      await waitUntil(async () => (await runs(connected)).length === 2)
      expect((await runs(connected)).map((listed) => listed.runtime).sort()).toEqual(['claude', 'codex'])
      expect(appServers(codex).filter((call) => isAlive(call.pid))).toEqual([])
      expect((await sandbox.aang('stop')).code).toBe(0)

      const removed = await sandbox.aang('uninstall')

      expect(removed).toMatchObject({ code: 0, stderr: '' })
      expect(removed.stdout).toContain(`codex: aang hooks neutralized in ${codexHooks}; the previous file is kept in `)
      await expect(readFile(pluginHooks)).rejects.toThrow()
      expect(handlersOf(await readHooks(codexHooks), 'SessionStart')).toEqual([
        { type: 'command', command: 'exit 0', timeout: 2 },
      ])
    },
  )

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
