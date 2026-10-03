import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createProfile, leaseSpool, type Profile, readSpool } from '@aang/testkit'
import { afterAll, beforeAll, describe, test, type TestContext } from 'vitest'
import { buildNpmPackages, hookBinaryName, hookPackageName, type HookPlatform, hookPlatforms, type PackedPackage } from '../dist/index.js'
import { executableTarget } from './executable.js'
import { type Installation, install } from './installation.js'
import { type Registry, startRegistry } from './registry.js'

const hostPlatform = `${process.platform}-${process.arch}`
const started = /^aang started: pid ([0-9]+), (http:\/\/127\.0\.0\.1:[0-9]+)$/m
const webRoot = dirname(fileURLToPath(import.meta.resolve('@aang/web')))
const sessionStartSample = new URL('../../../docs/research/samples/claude-code-hooks/SessionStart.startup.json', import.meta.url)
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

const watchedProfile = async (onTestFinished: TestContext['onTestFinished']): Promise<WatchedProfile> => {
  const profile = await createProfile()
  const workspace = join(profile.root, 'work')
  await mkdir(workspace)
  await profile.configure({ collector: { rootsScanIntervalMs: 200 }, watch: { roots: [{ path: workspace }] } })
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

const sessionStart = async (workspace: string): Promise<string> => {
  const sample: unknown = JSON.parse(await readFile(sessionStartSample, 'utf8'))
  return JSON.stringify({ ...(sample as Record<string, unknown>), session_id: randomUUID(), cwd: workspace })
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

  test('installed into a project without optional dependencies, aang-hook names the missing binary and aang still runs', { timeout: commandTimeoutMs }, async ({
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
