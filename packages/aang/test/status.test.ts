import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFakeClaude, installFakeCodex } from '@aang/testkit'
import { describe, test } from 'vitest'
import { isAlive } from './processes.js'
import { createSandbox } from './sandbox.js'

const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const notObservable = 'not observable: claude_cowork, claude_cloud, codex_cloud, work_cloud\n'

const hostOs = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

const codexNotInstalled = `codex hooks: not installed\n${
  process.platform === 'win32'
    ? 'codex: hooks are not installed by default on Windows: Codex sessions are observed from their files only, so approval waits are not visible\n'
    : ''
}`

const codexRollout = fileURLToPath(
  new URL(
    '../../../docs/research/samples/codex-cli/rollout/rollout-real-exec-then-resume-with-compaction.jsonl',
    import.meta.url,
  ),
)

const closedPort = async (): Promise<number> => {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  server.close()
  await once(server, 'close')
  if (address === null || typeof address === 'string') {
    throw new Error('the probe server has no port')
  }
  return address.port
}

describe.concurrent('aang status shows the connection state of the running daemon', () => {
  test('without runtime CLIs the Claude hooks state is unknown, Codex without aang hooks needs no CLI to be not installed, and a stopped daemon shows no connection state', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await sandbox.aang('start')).code).toBe(0)

    const running = await sandbox.aang('status')
    expect((await sandbox.aang('stop')).code).toBe(0)
    const stopped = await sandbox.aang('status')

    expect(running.code).toBe(0)
    expect(running.stdout).toContain(
      `claude hooks: unknown, the check did not succeed\n${codexNotInstalled}${notObservable}`,
    )
    expect(stopped.code).toBe(0)
    expect(stopped.stdout).not.toContain('hooks:')
    expect(stopped.stdout).not.toContain('not observable')
  })

  test.skipIf(process.platform === 'win32')(
    'each aang status checks the hooks again, so a trust change outside the watched files shows at once',
    async ({ expect, onTestFinished }) => {
      const sandbox = await createSandbox(onTestFinished)
      const root = dirname(sandbox.aangHome)
      const claude = installFakeClaude(join(root, 'fakes'))
      const codex = installFakeCodex(join(root, 'fakes'))
      const codexHome = join(root, '.codex')
      const command = `${quoted(join(sandbox.aangHome, 'bin', 'aang-hook'))} codex user ${quoted(sandbox.spool)}`
      await mkdir(codexHome, { recursive: true })
      await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }))
      await writeFile(
        join(sandbox.aangHome, 'config.json'),
        JSON.stringify({ cli: { claude: claude.command, codex: codex.command }, api: { port: 0 }, otel: { port: 0 } }),
      )
      expect((await sandbox.aang('start')).code).toBe(0)

      const untrusted = await sandbox.aang('status')
      const checks = codex.calls().filter((call) => call.command === 'app_server').length
      codex.setScenario({ hooks: 'trusted' })
      const trusted = await sandbox.aang('status')
      expect((await sandbox.aang('stop')).code).toBe(0)

      expect(untrusted.stdout).toContain(
        `claude hooks: not installed\ncodex hooks: not trusted; trust them in Codex with /hooks\n${notObservable}`,
      )
      expect(trusted.stdout).toContain(`claude hooks: not installed\ncodex hooks: active\n${notObservable}`)
      expect(codex.calls().filter((call) => call.command === 'app_server')).toHaveLength(checks + 1)
    },
  )

  test.skipIf(process.platform === 'win32')(
    'a hanging Claude CLI leaves only its own hooks state unknown: aang status answers with the rest of the connection state, and aang stop leaves no CLI behind',
    { timeout: 120_000 },
    async ({ expect, onTestFinished }) => {
      const sandbox = await createSandbox(onTestFinished)
      const root = dirname(sandbox.aangHome)
      const claude = installFakeClaude(join(root, 'fakes'), { pluginHang: true })
      const codex = installFakeCodex(join(root, 'fakes'))
      await mkdir(join(root, '.codex'), { recursive: true })
      await writeFile(
        join(sandbox.aangHome, 'config.json'),
        JSON.stringify({ cli: { claude: claude.command, codex: codex.command }, api: { port: 0 }, otel: { port: 0 } }),
      )
      expect((await sandbox.aang('start')).code).toBe(0)

      const status = await sandbox.aang('status')
      const stop = await sandbox.aang('stop')
      const checks = claude.calls().filter((call) => call.command === 'plugin')

      expect(status).toMatchObject({ code: 0, stderr: '' })
      expect(status.stdout).toContain(
        `claude hooks: unknown, the check did not succeed\ncodex hooks: not installed\n${notObservable}`,
      )
      expect(stop).toMatchObject({ code: 0, stderr: '' })
      expect(checks.length).toBeGreaterThanOrEqual(2)
      expect(checks.filter(({ pid }) => isAlive(pid))).toEqual([])
    },
  )

  test('the placement from the config keys the versions of the sessions', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished, { placement: 'vm', watch: { all: true } })
    const sessions = join(dirname(sandbox.aangHome), '.codex', 'sessions', '2026', '10', '04')
    await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, 'rollout-g7.jsonl'), await readFile(codexRollout))
    expect((await sandbox.aang('start')).code).toBe(0)

    const version = `version codex_exec 0.159.2 on ${hostOs} (vm): unverified, 1 session\n`
    const deadline = Date.now() + 20_000
    let status = await sandbox.aang('status')
    while (!status.stdout.includes(version) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      status = await sandbox.aang('status')
    }
    expect((await sandbox.aang('stop')).code).toBe(0)

    expect(status.code).toBe(0)
    expect(status.stdout).toContain(
      `${codexNotInstalled}codex: hooks inactive in 1 session\n${version}${notObservable}`,
    )
  })

  test('when the process of the daemon state is alive but no daemon answers, aang status reports it and fails', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await sandbox.aang('start')).code).toBe(0)
    const state = await sandbox.daemonState()
    expect((await sandbox.aang('stop')).code).toBe(0)
    if (state === null) {
      throw new Error('the daemon wrote no state')
    }
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 60_000)'], { stdio: 'ignore' })
    if (stranger.pid === undefined) {
      throw new Error('the stand-in process did not start')
    }
    sandbox.track(stranger.pid)
    await writeFile(
      join(sandbox.aangHome, 'daemon.json'),
      JSON.stringify({ ...state, pid: stranger.pid, api: { ...state.api, port: await closedPort() } }),
    )

    const status = await sandbox.aang('status')

    expect(status.code).toBe(1)
    expect(status.stdout).toContain(`daemon: running, pid ${String(stranger.pid)}`)
    expect(status.stdout).not.toContain('hooks:')
    expect(status.stderr).toContain('aang status: the hooks check failed: ')
    expect(status.stderr).toContain('aang status: the connection state is unavailable: ')
  })
})
