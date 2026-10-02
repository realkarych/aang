import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProfile, DaemonLaunchError, invokeHook, leaseSpool, type Profile, readSpool } from '@aang/testkit'
import { type TestContext, test, vi } from 'vitest'
import { daemonEntry, hookBinary } from './artifacts.js'

const profileFor = async (
  onTestFinished: TestContext['onTestFinished'],
  options: Parameters<typeof createProfile>[0] = {},
): Promise<Profile> => {
  const profile = await createProfile(options)
  onTestFinished(profile.dispose)
  return profile
}

const hookInto = (profile: Profile, payload: string): Promise<void> =>
  invokeHook(
    { binary: hookBinary, spool: profile.spool, env: profile.env },
    { runtime: 'claude', registration: 'plugin', payload },
  )

const payloadsIn = async (profile: Profile): Promise<string[]> =>
  (await readSpool(profile.spool)).map((event) => event.payload.toString('utf8'))

const leaseExpiries = async (profile: Profile): Promise<number[]> =>
  (await readdir(profile.spool)).flatMap((name) => {
    const match = /^lease-([0-9]+)$/.exec(name)
    return match?.[1] === undefined ? [] : [Number(match[1]) * 1_000]
  })

const unknownApiStatus = async (url: string, token: string): Promise<number> =>
  (await fetch(`${url}/api/unknown`, { headers: { authorization: `Bearer ${token}` } })).status

test.for([
  { failure: 'config validation', options: { config: { spool: { thresholdBytes: -1 } } }, errorName: 'ZodError' },
  { failure: 'directory creation', options: { homeName: 'invalid\0home' }, errorName: 'TypeError' },
])('profile creation leaves no temporary directory after failed $failure', async ({ options, errorName }, {
  expect,
  onTestFinished,
}) => {
  const temporary = await mkdtemp(join(tmpdir(), 'aang-profile-failure-'))
  onTestFinished(() => rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createProfile } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}
try {
  const profile = await createProfile(${JSON.stringify(options)})
  await profile.dispose()
  process.stdout.write('null')
} catch (error) {
  process.stdout.write(JSON.stringify({ name: error.name }))
}`,
    ],
    { env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary }, encoding: 'utf8', timeout: 10_000 },
  )

  expect(probe.status, probe.stderr).toBe(0)
  expect(JSON.parse(probe.stdout)).toEqual({ name: errorName })
  expect(await readdir(temporary)).toEqual([])
})

test('daemons started from parallel profiles keep their tokens, ports, spools and leases apart', async ({
  expect,
  onTestFinished,
}) => {
  const profiles = await Promise.all(
    ['home', 'Имя Фамилия', 'home with spaces'].map((homeName) => profileFor(onTestFinished, { homeName })),
  )

  const daemons = await Promise.all(profiles.map((profile) => profile.startDaemon({ entry: daemonEntry })))

  expect(new Set(daemons.map((daemon) => daemon.pid)).size).toBe(3)
  expect(new Set(daemons.map((daemon) => daemon.url)).size).toBe(3)
  for (const [index, daemon] of daemons.entries()) {
    expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/)
    expect(await Promise.all(daemons.map((other) => unknownApiStatus(daemon.url, other.token)))).toEqual(
      daemons.map((_, other) => (other === index ? 404 : 401)),
    )
  }
  await Promise.all(profiles.map((profile, index) => hookInto(profile, `{"before":${String(index)}}`)))
  expect(await Promise.all(profiles.map(payloadsIn))).toEqual([['{"before":0}'], ['{"before":1}'], ['{"before":2}']])

  const [first, ...others] = daemons
  expect(await first?.stop()).toEqual({ code: 0, signal: null })

  await Promise.all(profiles.map((profile, index) => hookInto(profile, `{"after":${String(index)}}`)))
  expect(await Promise.all(profiles.map(payloadsIn))).toEqual([
    ['{"before":0}'],
    ['{"before":1}', '{"after":1}'],
    ['{"before":2}', '{"after":2}'],
  ])
  for (const daemon of others) {
    expect(daemon.running()).toBe(true)
    expect(await unknownApiStatus(daemon.url, daemon.token)).toBe(404)
  }
})

test('the profile environment moves the user profile, the runtime roots and AANG_HOME into the temporary profile', async ({
  expect,
  onTestFinished,
}) => {
  vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/enclosing/.claude')
  vi.stubEnv('CODEX_HOME', '/enclosing/.codex')
  vi.stubEnv('AANG_OBSERVER', '1')
  vi.stubEnv('AI_AGENT', 'enclosing-agent')
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  const profile = await profileFor(onTestFinished)

  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const names = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'AANG_HOME', 'CLAUDE_CODE_ENTRYPOINT', 'AANG_OBSERVER', 'AI_AGENT']
process.stdout.write(JSON.stringify({ homedir: process.getBuiltinModule('node:os').homedir(), env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])) }))`,
    ],
    { env: profile.env, encoding: 'utf8' },
  )

  expect(JSON.parse(probe.stdout)).toEqual({
    homedir: profile.home,
    env: {
      CLAUDE_CONFIG_DIR: join(profile.home, '.claude'),
      CODEX_HOME: join(profile.home, '.codex'),
      AANG_HOME: join(profile.home, '.aang'),
      CLAUDE_CODE_ENTRYPOINT: null,
      AANG_OBSERVER: null,
      AI_AGENT: null,
    },
  })
  expect([profile.claude, profile.codex, profile.aangHome]).toEqual([
    join(profile.home, '.claude'),
    join(profile.home, '.codex'),
    join(profile.home, '.aang'),
  ])
  expect(
    (await Promise.all([profile.claude, profile.codex, profile.aangHome].map((path) => stat(path)))).every((s) =>
      s.isDirectory(),
    ),
  ).toBe(true)
  await leaseSpool(profile.spool)
  await hookInto(profile, '{"hook_event_name":"Notification"}')
  expect((await readSpool(profile.spool)).map((event) => event.header)).toEqual([
    { runtime: 'claude', registration: 'plugin', env: {} },
  ])
})

test('the config builder writes the config the daemon runs with and rejects an invalid one', async ({
  expect,
  onTestFinished,
}) => {
  const profile = await profileFor(onTestFinished, { config: { spool: { leaseTtlMs: 600_000 } } })

  expect(JSON.parse(await readFile(join(profile.aangHome, 'config.json'), 'utf8'))).toEqual({
    api: { port: 0 },
    otel: { port: 0 },
    spool: { leaseTtlMs: 600_000 },
  })
  const settings = await profile.write('claude', 'settings.json', '{"enabledPlugins":{}}')
  expect(settings).toBe(join(profile.claude, 'settings.json'))
  expect(await readFile(settings, 'utf8')).toBe('{"enabledPlugins":{}}')

  const startedAt = Date.now()
  const daemon = await profile.startDaemon({ entry: daemonEntry })

  const [expiry] = await leaseExpiries(profile)
  expect(expiry).toBeGreaterThan(startedAt)
  expect(expiry).toBeLessThanOrEqual(Date.now() + 600_000)
  await daemon.stop()

  await expect(profile.configure({ spool: { thresholdBytes: -1 } })).rejects.toThrow('thresholdBytes')
  await profile.write('aang', 'config.json', '{"spool":{"thresholdBytes":"big"}}')
  const failed = profile.startDaemon({ entry: daemonEntry })
  await expect(failed).rejects.toThrow(DaemonLaunchError)
  await expect(failed).rejects.toThrow('config.json')
})

test('a second daemon of one profile is refused, a killed daemon keeps its lease, and a new daemon replaces it', async ({
  expect,
  onTestFinished,
}) => {
  const profile = await profileFor(onTestFinished)
  const first = await profile.startDaemon({ entry: daemonEntry })

  await expect(profile.startDaemon({ entry: daemonEntry })).rejects.toThrow('already running')
  expect(first.running()).toBe(true)

  await first.kill()

  expect(first.running()).toBe(false)
  await hookInto(profile, '{"while":"killed"}')
  expect(await payloadsIn(profile)).toEqual(['{"while":"killed"}'])

  const second = await profile.startDaemon({ entry: daemonEntry })

  expect(second.pid).not.toBe(first.pid)
  expect((await second.request('/api/unknown')).status).toBe(404)
  expect(second.token).toBe(first.token)
  expect(await second.stop()).toEqual({ code: 0, signal: null })
  expect(await leaseExpiries(profile)).toEqual([])
  await hookInto(profile, '{"after":"shutdown"}')
  expect(await payloadsIn(profile)).toEqual(['{"while":"killed"}'])
  expect(second.output()).toContain('aang stopped: shutdown')
})
