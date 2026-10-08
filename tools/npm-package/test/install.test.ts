import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  type ClaudeScenario,
  type CodexScenario,
  type ConfigInput,
  createProfile,
  type FakeCli,
  installFakeClaude,
  installFakeCodex,
  leaseSpool,
  type Profile,
  readSpool,
} from '@aang/testkit'
import { afterAll, beforeAll, describe, test, type TestContext } from 'vitest'
import {
  buildNpmPackages,
  hookBinaryName,
  hookPackageName,
  type HookPlatform,
  hookPlatforms,
  type PackedPackage,
  run,
} from '../dist/index.js'
import { executableTarget } from './executable.js'
import { type Installation, install } from './installation.js'
import { type Registry, startRegistry } from './registry.js'

const hostPlatform = `${process.platform}-${process.arch}`
const windows = process.platform === 'win32'
const hostBinaryName = windows ? 'aang-hook.exe' : 'aang-hook'
const codexShell = windows ? { command: 'pwsh', args: ['-NoProfile', '-Command'] } : { command: '/bin/sh', args: ['-c'] }
const codexHookSlowdown = 'on Windows Codex starts PowerShell for every hook event, which slows each event by 0.25–0.4 s'
const started = /^aang started: pid ([0-9]+), (http:\/\/127\.0\.0\.1:[0-9]+)$/m
const webRoot = dirname(fileURLToPath(import.meta.resolve('@aang/web')))
const samples = new URL('../../../docs/research/samples/', import.meta.url)
const commandTimeoutMs = 180_000

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

const waitUntil = async (condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`)
    }
    await sleep(50)
  }
}

const filesUnder = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort()

interface WatchedProfile {
  readonly profile: Profile
  readonly workspace: string
}

const watchedProfile = async (
  onTestFinished: TestContext['onTestFinished'],
  config: ConfigInput = {},
): Promise<WatchedProfile> => {
  const profile = await createProfile()
  const workspace = join(profile.root, 'work')
  await mkdir(workspace)
  await profile.configure({ collector: { rootsScanIntervalMs: 200 }, watch: { roots: [{ path: workspace }] }, ...config })
  onTestFinished(async () => {
    const state = await readFile(join(profile.aangHome, 'daemon.json'), 'utf8').catch(() => null)
    const pid = state === null ? null : (JSON.parse(state) as { readonly pid: number }).pid
    if (pid !== null && isAlive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
    await profile.dispose()
  })
  return { profile, workspace }
}

const sample = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(path, samples), 'utf8')) as Record<string, unknown>

const sessionStart = async (workspace: string): Promise<string> =>
  JSON.stringify({ ...(await sample('claude-code-hooks/SessionStart.startup.json')), session_id: randomUUID(), cwd: workspace })

const codexSessionStart = async (workspace: string): Promise<string> => {
  const { stdin } = (await sample('codex-cli/hooks/SessionStart.startup.json')) as { readonly stdin: Record<string, unknown> }
  return JSON.stringify({ ...stdin, cwd: workspace })
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

const powerShellQuoted = (value: string): string => `'${value.replaceAll("'", "''")}'`

const codexHookCommand = (hookBinary: string, spool: string): string =>
  windows
    ? `& ${[hookBinary, 'codex', 'user', spool].map(powerShellQuoted).join(' ')}`
    : `'${hookBinary}' codex user '${spool}'`

const sessionStartHandlers = async (hooksFile: string): Promise<CommandHandler[]> =>
  ((JSON.parse(await readFile(hooksFile, 'utf8')) as HooksDocument).hooks.SessionStart ?? []).flatMap(
    (group) => group.hooks,
  )

interface Connected extends WatchedProfile {
  readonly claude: FakeCli<ClaudeScenario>
  readonly codex: FakeCli<CodexScenario>
  readonly codexHome: string
}

const connectedProfile = async (onTestFinished: TestContext['onTestFinished']): Promise<Connected> => {
  const fakes = await realpath(await mkdtemp(join(tmpdir(), 'aang-npm-fakes-')))
  onTestFinished(() => rm(fakes, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const claude = installFakeClaude(fakes)
  const codex = installFakeCodex(fakes)
  const codexHome = join(fakes, 'codex-profile')
  const watched = await watchedProfile(onTestFinished, {
    cli: { claude: claude.executable, codex: codex.executable },
    runtimes: { codex: { home: codexHome } },
  })
  return { ...watched, claude, codex, codexHome }
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

const runtimesOfRuns = async (url: string, aangHome: string): Promise<string[]> => {
  const token = (await readFile(join(aangHome, 'token'), 'utf8')).trim()
  const response = await fetch(`${url}/api/runs`, { headers: { authorization: `Bearer ${token}` } })
  const { runs } = (await response.json()) as { readonly runs: readonly { readonly runtime: string }[] }
  return runs.map(({ runtime }) => runtime).sort()
}

describe('the packed aang package installs from a registry and runs', { tags: ['package'] }, () => {
  let packages: readonly PackedPackage[] = []
  let registry: Registry | undefined
  let installation: Installation | undefined
  let output: string | undefined

  const installed = (): Installation => {
    if (installation === undefined) {
      throw new Error('aang is not installed')
    }
    return installation
  }

  const registryUrl = (): string => {
    if (registry === undefined) {
      throw new Error('the registry is not running')
    }
    return registry.url
  }

  beforeAll(async () => {
    output = await realpath(await mkdtemp(join(tmpdir(), 'aang-npm-package-')))
    packages = await buildNpmPackages(output)
    registry = await startRegistry(packages)
    installation = await install(registry.url, 'global')
  }, 900_000)

  afterAll(async () => {
    await installation?.remove()
    await registry?.close()
    if (output !== undefined) {
      await rm(output, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })

  test('npm installs aang for Node 26 and later with the aang-hook package of this platform only', async ({ expect }) => {
    const manifest: unknown = JSON.parse(await readFile(join(installed().packageDirectory, 'package.json'), 'utf8'))
    const dependencies = await readdir(join(installed().packageDirectory, 'node_modules'))

    expect(manifest).toMatchObject({
      name: 'aang',
      engines: { node: '>=26' },
      bin: { aang: 'dist/aang.js', 'aang-hook': 'dist/aang-hook.js' },
    })
    expect(dependencies.filter((name) => name.startsWith('aang-hook-'))).toEqual([`aang-hook-${hostPlatform}`])
  })

  test('in a temporary HOME the installed aang-hook writes to the spool and aang starts, ingests it, reports status, serves the web build and stops', { timeout: commandTimeoutMs }, async ({
    expect,
    onTestFinished,
  }) => {
    const { profile, workspace } = await watchedProfile(onTestFinished)
    const env = profile.env
    const payload = await sessionStart(workspace)
    await leaseSpool(profile.spool)

    const hooked = await installed().run('aang-hook', ['claude', 'plugin', profile.spool], { env, input: payload })

    expect(hooked).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(
      (await readSpool(profile.spool)).map(({ header, payload: body }) => [header.runtime, header.registration, body.toString()]),
    ).toEqual([['claude', 'plugin', payload]])
    expect((await installed().run('aang', ['status'], { env })).stdout).toContain('daemon: not running\nspool: 1 files')

    const start = await installed().run('aang', ['start'], { env })

    const [, pid = '', url = ''] = started.exec(start.stdout) ?? []
    expect(start.code, start.stderr).toBe(0)
    expect(start.stdout).toMatch(started)
    await waitUntil(async () => (await readSpool(profile.spool)).length === 0)
    const status = await installed().run('aang', ['status'], { env })
    expect(status).toMatchObject({ code: 0, stderr: '' })
    expect(status.stdout).toContain(`daemon: running, pid ${pid}, ${url}\nspool: 0 files`)

    const open = await installed().run('aang', ['open'], { env })

    expect(open).toMatchObject({ code: 0, stderr: '' })
    expect(open.stdout.trim().startsWith(`${url}/auth/`)).toBe(true)
    const signedIn = await fetch(open.stdout.trim())
    expect(signedIn.status).toBe(200)
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const webFiles = await filesUnder(webRoot)
    expect(webFiles.length).toBeGreaterThan(0)
    for (const file of webFiles) {
      const response = await fetch(`${url}/${file}`, { headers: { cookie } })
      expect(response.status, file).toBe(200)
      expect(Buffer.from(await response.arrayBuffer()).equals(await readFile(join(webRoot, file))), file).toBe(true)
    }

    const stop = await installed().run('aang', ['stop'], { env })

    expect(stop).toMatchObject({ code: 0, stdout: `aang stopped: pid ${pid}\n` })
    expect(isAlive(Number(pid))).toBe(false)
  })

  test('in a temporary HOME the installed aang install deploys the binary of the aang-hook package and registers hooks whose commands deliver events to the running daemon, on Windows the Codex hooks only with --codex', { timeout: commandTimeoutMs }, async ({
    expect,
    onTestFinished,
  }) => {
    const { profile, workspace, claude, codex, codexHome } = await connectedProfile(onTestFinished)
    const env = profile.env
    const pluginDirectory = join(profile.aangHome, 'claude-plugin')
    const codexHooks = join(codexHome, 'hooks.json')
    const hookBinary = join(profile.aangHome, 'bin', hostBinaryName)
    const packagedBinary = join(installed().packageDirectory, 'node_modules', `aang-hook-${hostPlatform}`, hostBinaryName)
    const codexRegistered = [
      `codex: aang hooks registered in ${codexHooks}`,
      'codex: aang hooks are not trusted yet; trust them in Codex with /hooks, until then Codex skips them',
      ...(windows ? [`codex: ${codexHookSlowdown}`] : []),
    ]
    const codexByDefault = windows
      ? [
          'codex: hooks are not installed by default on Windows: Codex sessions are observed from their files only, so approval waits are not visible',
          `codex: \`aang install --codex\` installs them anyway; ${codexHookSlowdown}`,
        ]
      : codexRegistered

    const connected = await installed().run('aang', ['install'], { env })

    expect(connected).toEqual({
      code: 0,
      stdout: [
        `claude: plugin aang@aang installed from ${pluginDirectory}`,
        'claude: plugin aang@aang is enabled',
        ...codexByDefault,
        '',
      ].join('\n'),
      stderr: '',
    })
    expect(claude.calls().filter((call) => call.command === 'plugin').map((call) => call.argv)).toEqual([
      ['plugin', 'marketplace', 'add', pluginDirectory, '--scope', 'user', '--json'],
      ['plugin', 'install', 'aang@aang', '--scope', 'user', '--json'],
      ['plugin', 'list', '--json'],
    ])
    expect((await readFile(hookBinary)).equals(await readFile(packagedBinary))).toBe(true)
    if (windows) {
      expect(codex.calls()).toEqual([])
      expect(await exists(codexHooks)).toBe(false)

      const optedIn = await installed().run('aang', ['install', '--codex'], { env })

      expect(optedIn).toEqual({ code: 0, stdout: [...codexRegistered, ''].join('\n'), stderr: '' })
    }
    expect(codex.calls().filter((call) => call.command === 'app_server').map((call) => call.env.CODEX_HOME)).toEqual(
      Array(3).fill(codexHome),
    )
    const [pluginHandler] = await sessionStartHandlers(join(pluginDirectory, 'hooks', 'hooks.json'))
    expect(pluginHandler).toEqual({ type: 'command', command: hookBinary, args: ['claude', 'plugin', profile.spool], timeout: 2 })
    const codexHandlers = await sessionStartHandlers(codexHooks)
    expect(codexHandlers).toEqual([{ type: 'command', command: codexHookCommand(hookBinary, profile.spool), timeout: 2 }])
    const start = await installed().run('aang', ['start'], { env })
    const [, pid = '', url = ''] = started.exec(start.stdout) ?? []
    expect(start.code, start.stderr).toBe(0)

    const fromClaude = await run(pluginHandler?.command ?? '', pluginHandler?.args ?? [], {
      env,
      input: await sessionStart(workspace),
    })
    const fromCodex = await run(codexShell.command, [...codexShell.args, codexHandlers[0]?.command ?? ''], {
      env,
      input: await codexSessionStart(workspace),
    })

    expect(fromClaude).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(fromCodex).toEqual({ code: 0, stdout: '', stderr: '' })
    await waitUntil(async () => (await runtimesOfRuns(url, profile.aangHome)).length === 2)
    expect(await runtimesOfRuns(url, profile.aangHome)).toEqual(['claude', 'codex'])
    const stop = await installed().run('aang', ['stop'], { env })
    expect(stop).toMatchObject({ code: 0, stdout: `aang stopped: pid ${pid}\n` })
  })

  test('installed into a project without optional dependencies, aang-hook and aang install name the missing binary and aang still runs', { timeout: commandTimeoutMs }, async ({
    expect,
    onTestFinished,
  }) => {
    const bare = await install(registryUrl(), 'project', ['--omit=optional'])
    onTestFinished(() => bare.remove())
    const { profile, workspace } = await watchedProfile(onTestFinished)
    await leaseSpool(profile.spool)

    const hooked = await bare.run('aang-hook', ['claude', 'plugin', profile.spool], {
      env: profile.env,
      input: await sessionStart(workspace),
    })

    expect(hooked).toMatchObject({ code: 1, stdout: '' })
    expect(hooked.stderr).toContain(`no aang-hook binary is installed for ${hostPlatform}`)
    expect(await readSpool(profile.spool)).toEqual([])

    const connected = await bare.run('aang', ['install'], { env: profile.env })

    expect(connected).toMatchObject({ code: 1, stdout: '' })
    expect(connected.stderr).toMatch(new RegExp(`^aang install: no aang-hook binary is installed for ${hostPlatform};`))
    expect(await exists(join(profile.aangHome, 'bin'))).toBe(false)
    const status = await bare.run('aang', ['status'], { env: profile.env })
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('daemon: not running\nspool: 0 files')
  })

  test.for(hookPlatforms)(
    'the aang-hook-$os-$cpu package declares its platform and carries a binary built for it',
    async (platform: HookPlatform, { expect }) => {
      const packed = packages.find(({ name }) => name === hookPackageName(platform))
      expect(packed?.manifest).toMatchObject({ os: [platform.os], cpu: [platform.cpu] })
      const binary = await readFile(join(packed?.directory ?? '', hookBinaryName(platform)))
      expect(executableTarget(binary)).toEqual({ os: platform.os, cpu: platform.cpu })
    },
  )
})
