import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  endpoints,
  type HookInstallation,
  type Runtime,
  type StatusResponse,
  type SupportMatrix,
  supportMatrixFormat,
  type SupportRow,
} from '@aang/contract'
import { objectId } from '@aang/contract/ids'
import { claudePluginId, installClaudePlugin, installCodexHooks } from '@aang/hook'
import {
  type ClaudeScenario,
  type CodexScenario,
  type FakeCli,
  type FakeCommand,
  installFakeClaude,
  installFakeCodex,
} from '@aang/testkit'
import type { TestContext } from 'vitest'
import { describe, test } from 'vitest'
import { bearer, createHome, type Home, type RunningDaemon, startDaemon } from './daemon.js'
import {
  claudeHook,
  claudeSession,
  claudeTranscript,
  hookBinary,
  hookEvent,
  rolloutLines,
  rolloutThread,
  sleep,
  transcriptLines,
  waitUntil,
} from './sessions.js'

const runFile = promisify(execFile)

const hostOs = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

const unobservable = ['claude_cowork', 'claude_cloud', 'codex_cloud', 'work_cloud']

interface Connected {
  readonly home: Home
  readonly workspace: string
  readonly claude: FakeCli<ClaudeScenario>
  readonly codex: FakeCli<CodexScenario>
  readonly claudeHome: string
  readonly codexHome: string
}

const readStatus = async ({ base }: RunningDaemon, home: Home): Promise<StatusResponse> => {
  const response = await fetch(`${base}${endpoints.status.path}`, { headers: bearer(home.token) })
  return endpoints.status.response.parse(await response.json())
}

const checkHooks = async ({ base }: RunningDaemon, home: Home): Promise<StatusResponse> => {
  const response = await fetch(`${base}${endpoints.hooksCheck.path}`, {
    method: endpoints.hooksCheck.method,
    headers: { ...bearer(home.token), 'content-type': 'application/json' },
    body: '{}',
  })
  return endpoints.hooksCheck.response.parse(await response.json())
}

const statusUntil = async (
  daemon: RunningDaemon,
  home: Home,
  accept: (status: StatusResponse) => boolean,
): Promise<StatusResponse> => {
  const seen: { last: StatusResponse | null } = { last: null }
  await waitUntil(async () => {
    seen.last = await readStatus(daemon, home)
    return accept(seen.last)
  })
  if (seen.last === null) {
    throw new Error('no status was read')
  }
  return seen.last
}

const hooksOf = ({ runtimes }: StatusResponse): Record<string, HookInstallation> =>
  Object.fromEntries(runtimes.map(({ runtime, hooks }) => [runtime, hooks]))

const runtimeOf = ({ runtimes }: StatusResponse, runtime: Runtime) => runtimes.find((status) => status.runtime === runtime)

const hooksAre =
  (expected: Readonly<Record<Runtime, HookInstallation>>) =>
  (status: StatusResponse): boolean =>
    hooksOf(status).claude === expected.claude && hooksOf(status).codex === expected.codex

const writeConfig = (home: Home, config: Record<string, unknown>): Promise<void> =>
  writeFile(join(home.paths.home, 'config.json'), JSON.stringify({ api: { port: 0 }, otel: { port: 0 }, ...config }))

const connect = async (
  onTestFinished: TestContext['onTestFinished'],
  codexScenario: CodexScenario,
): Promise<Connected> => {
  const home = await createHome(onTestFinished)
  const workspace = join(home.root, 'work')
  await mkdir(workspace)
  const claude = installFakeClaude(join(home.root, 'fakes'))
  const codex = installFakeCodex(join(home.root, 'fakes'), codexScenario)
  const claudeHome = join(home.root, '.claude')
  const codexHome = join(home.root, '.codex')
  await mkdir(claudeHome, { recursive: true })
  await mkdir(codexHome, { recursive: true })
  await writeConfig(home, {
    cli: { claude: claude.command, codex: codex.command },
    collector: { rootsScanIntervalMs: 200 },
    watch: { roots: [{ path: workspace }] },
  })
  return { home, workspace, claude, codex, claudeHome, codexHome }
}

const staleHooks = JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '~/src/aang/bin/aang hook', timeout: 2 }] }],
    Stop: [{ hooks: [{ type: 'command', command: '~/src/aang/bin/aang hook', timeout: 2 }] }],
  },
})

const writeRollout = async (codexHome: string, workspace: string): Promise<void> => {
  const path = join(codexHome, 'sessions', '2026', '10', '04', 'rollout-g7.jsonl')
  await mkdir(join(codexHome, 'sessions', '2026', '10', '04'), { recursive: true })
  await writeFile(path, `${rolloutLines(workspace).join('\n')}\n`)
}

const fakeCalls = (fake: Pick<FakeCli<never>, 'calls'>, command: FakeCommand) => fake.calls().filter((call) => call.command === command)

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const withVersion = (lines: readonly string[], version: string): string[] =>
  lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>
    return JSON.stringify('version' in record ? { ...record, version } : record)
  })

const supportRow = (row: Pick<SupportRow, 'runtime' | 'surface' | 'engine_version' | 'status'>): SupportRow => ({
  ...row,
  os: hostOs,
  placement: 'local',
  app_version: null,
  gaps: row.status === 'full' ? [] : ['E2E 1 and 4 were not run'],
  scenarios: {
    during_work: 'not_run',
    after_iteration: 'not_run',
    resume: 'passed',
    compaction: 'passed',
    child_sessions: 'passed',
    reconnect: 'passed',
  },
  observer: { admission: 'not_run', cross_session_inbound: 'not_run', builtins: { mcp_servers: [], plugins: [], skills: [] } },
  verified_on: null,
})

describe.skipIf(process.platform === 'win32')('the static hooks state of ADR-0004 in /api/status', () => {
  test(
    'Codex hooks go from not installed through untrusted to active and disabled, stale aang entries never count, and a session without hook events stays visible',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace, codex, codexHome } = await connect(onTestFinished, { hooks: 'trusted' })
      await writeFile(join(codexHome, 'hooks.json'), staleHooks)
      const daemon = await startDaemon(home, onTestFinished)

      const stale = await statusUntil(daemon, home, hooksAre({ claude: 'not_installed', codex: 'not_installed' }))
      expect(stale.not_observable).toEqual(unobservable)

      codex.setScenario({ hooks: 'untrusted' })
      await installCodexHooks({ aangHome: home.paths.home, hookBinarySource: hookBinary, codexHome, codex })
      await writeRollout(codexHome, workspace)
      const untrusted = await statusUntil(
        daemon,
        home,
        (status) => hooksOf(status).codex === 'untrusted' && runtimeOf(status, 'codex')?.hooks_inactive_sessions.length === 1,
      )
      expect(runtimeOf(untrusted, 'codex')).toMatchObject({
        root: codexHome,
        root_exists: true,
        hooks_inactive_sessions: [objectId({ kind: 'session', runtime: 'codex', session: rolloutThread })],
        double_registration_sessions: [],
      })
      expect(untrusted.versions).toEqual([
        {
          key: { runtime: 'codex', surface: 'codex_exec', os: hostOs, placement: 'local', engine_version: '0.159.2' },
          status: 'unverified',
          sessions: 1,
          last_seen_at: expect.any(BigInt) as unknown,
        },
      ])

      codex.setScenario({ hooks: 'trusted' })
      await writeFile(join(codexHome, 'config.toml'), '[hooks.state."aang"]\ntrusted_hash = "sha256:aang"\n')
      await statusUntil(daemon, home, (status) => hooksOf(status).codex === 'active')

      codex.setScenario({ hooks: 'disabled' })
      await appendFile(join(codexHome, 'config.toml'), 'enabled = false\n')
      await statusUntil(daemon, home, (status) => hooksOf(status).codex === 'disabled')

      const servers = fakeCalls(codex, 'app_server')
      expect(servers.length).toBeGreaterThanOrEqual(6)
      expect(servers.filter(({ pid }) => isRunning(pid))).toEqual([])
    },
  )

  test(
    'reading the status never starts a CLI; a changed runtime config and an explicit hooks check do, and the Claude plugin goes from not installed to active and disabled',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, claude, codex, claudeHome } = await connect(onTestFinished, {})
      const daemon = await startDaemon(home, onTestFinished)
      await statusUntil(daemon, home, hooksAre({ claude: 'not_installed', codex: 'not_installed' }))
      await waitUntil(() => fakeCalls(claude, 'plugin').length === 1 && fakeCalls(codex, 'app_server').length === 1)

      await installClaudePlugin({
        aangHome: home.paths.home,
        hookBinarySource: hookBinary,
        claude: { command: claude.command, configDir: null },
      })
      const installed = fakeCalls(claude, 'plugin').length
      for (let read = 0; read < 10; read += 1) {
        expect(hooksOf(await readStatus(daemon, home))).toEqual({ claude: 'not_installed', codex: 'not_installed' })
      }
      await sleep(1_500)
      expect(fakeCalls(claude, 'plugin')).toHaveLength(installed)
      expect(fakeCalls(codex, 'app_server')).toHaveLength(1)

      const anonymous = await fetch(`${daemon.base}${endpoints.hooksCheck.path}`, { method: 'POST', body: '{}' })
      expect(anonymous.status).toBe(401)
      const checked = await checkHooks(daemon, home)
      expect(hooksOf(checked)).toEqual({ claude: 'active', codex: 'not_installed' })
      expect(checked.not_observable).toEqual(unobservable)
      expect(fakeCalls(claude, 'plugin')).toHaveLength(installed + 1)
      expect(fakeCalls(codex, 'app_server')).toHaveLength(2)

      await runFile(claude.command, ['plugin', 'disable', claudePluginId, '--json'])
      await writeFile(join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { [claudePluginId]: false } }))
      await statusUntil(daemon, home, (status) => hooksOf(status).claude === 'disabled')
      expect(fakeCalls(codex, 'app_server')).toHaveLength(2)
    },
  )

  test(
    'the checks own their process trees: a descendant of a finished Claude check is stopped, and stopping the daemon cancels hanging checks',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, claude, codex, claudeHome, codexHome } = await connect(onTestFinished, {})
      const descendantFile = join(home.root, 'plugin-descendant.pid')
      claude.setScenario({ pluginDescendant: { pidFile: descendantFile } })
      const daemon = await startDaemon(home, onTestFinished)
      await statusUntil(daemon, home, hooksAre({ claude: 'not_installed', codex: 'not_installed' }))
      expect(isRunning(Number(await readFile(descendantFile, 'utf8')))).toBe(false)

      claude.setScenario({ pluginHang: true })
      codex.setScenario({ hooks: 'unanswered' })
      const finished = { claude: fakeCalls(claude, 'plugin').length, codex: fakeCalls(codex, 'app_server').length }
      await writeFile(join(claudeHome, 'settings.json'), '{}')
      await writeFile(join(codexHome, 'hooks.json'), '{}')
      await waitUntil(
        () =>
          fakeCalls(claude, 'plugin').length > finished.claude && fakeCalls(codex, 'app_server').length > finished.codex,
      )
      const hanging = [
        ...fakeCalls(claude, 'plugin').slice(finished.claude),
        ...fakeCalls(codex, 'app_server').slice(finished.codex),
      ]
      expect(hanging.filter(({ pid }) => isRunning(pid))).toHaveLength(2)

      const stopping = Date.now()
      daemon.abort()
      await daemon.stopped
      expect(Date.now() - stopping).toBeLessThan(7_000)
      expect(hanging.filter(({ pid }) => isRunning(pid))).toEqual([])
    },
  )
})

test(
  'versions of the sessions carry their support status from the matrix by the OS and placement of the daemon, a version of an unknown surface stays visible as unverified, and a configured placement has its own rows',
  { timeout: 60_000 },
  async ({ expect, onTestFinished }) => {
    const home = await createHome(onTestFinished)
    const workspace = join(home.root, 'work')
    await mkdir(workspace)
    const config = {
      cli: { claude: join(home.root, 'no-cli', 'claude'), codex: join(home.root, 'no-cli', 'codex') },
      collector: { rootsScanIntervalMs: 200 },
      watch: { roots: [{ path: workspace }] },
    }
    await writeConfig(home, config)
    const matrix: SupportMatrix = {
      format: supportMatrixFormat,
      rows: [supportRow({ runtime: 'claude', surface: 'claude_cli', engine_version: '2.1.286', status: 'limited' })],
    }
    const supportMatrix = join(home.root, 'matrix.json')
    await writeFile(supportMatrix, JSON.stringify(matrix))
    const session = 'g7-versions'
    const filesOnly = 'g7-files-only'
    await claudeTranscript(home, '-work', session, transcriptLines(session, workspace, 22))
    await claudeTranscript(home, '-work', filesOnly, withVersion(transcriptLines(filesOnly, workspace, 22), '999.0.0'))
    await writeRollout(join(home.root, '.codex'), workspace)

    const local = await startDaemon(home, onTestFinished, { supportMatrix })
    await hookEvent(home, claudeHook('SessionStart.startup', session, workspace))
    const seen = await statusUntil(
      local,
      home,
      ({ versions }) => versions.length === 3 && versions.some(({ key }) => key.surface === 'claude_cli'),
    )
    expect(seen.versions.map(({ key, status, sessions }) => ({ key, status, sessions }))).toEqual([
      {
        key: { runtime: 'claude', surface: 'claude_cli', os: hostOs, placement: 'local', engine_version: '2.1.286' },
        status: 'limited',
        sessions: 1,
      },
      {
        key: { runtime: 'claude', surface: null, os: hostOs, placement: 'local', engine_version: '999.0.0' },
        status: 'unverified',
        sessions: 1,
      },
      {
        key: { runtime: 'codex', surface: 'codex_exec', os: hostOs, placement: 'local', engine_version: '0.159.2' },
        status: 'unverified',
        sessions: 1,
      },
    ])
    expect(hooksOf(seen)).toEqual({ claude: 'unknown', codex: 'unknown' })
    expect(runtimeOf(seen, 'claude')?.hooks_inactive_sessions).toEqual([objectId(claudeSession(filesOnly))])
    expect(runtimeOf(seen, 'codex')?.hooks_inactive_sessions).toEqual([
      objectId({ kind: 'session', runtime: 'codex', session: rolloutThread }),
    ])
    expect(seen.not_observable).toEqual(unobservable)
    local.abort()
    await local.stopped

    const placed = async (settings: Parameters<typeof startDaemon>[2]) => {
      const daemon = await startDaemon(home, onTestFinished, { supportMatrix, ...settings })
      const { versions } = await readStatus(daemon, home)
      daemon.abort()
      await daemon.stopped
      return versions.map(({ key: { placement }, status }) => ({ placement, status }))
    }
    const unverifiedIn = (placement: string) => Array.from({ length: 3 }, () => ({ placement, status: 'unverified' }))
    expect(await placed({ placement: 'docker' })).toEqual(unverifiedIn('docker'))
    for (const placement of ['vm', 'desktop_ssh']) {
      await writeConfig(home, { ...config, placement })
      expect(await placed({})).toEqual(unverifiedIn(placement))
    }
    await writeConfig(home, { ...config, placement: 'local' })
    expect(await placed({ placement: 'docker' })).toEqual([
      { placement: 'local', status: 'limited' },
      { placement: 'local', status: 'unverified' },
      { placement: 'local', status: 'unverified' },
    ])
  },
)

test('a missing or invalid support matrix stops the daemon before it starts serving', async ({ expect, onTestFinished }) => {
  const home = await createHome(onTestFinished)
  await expect(startDaemon(home, onTestFinished, { supportMatrix: join(home.root, 'missing.json') })).rejects.toMatchObject({
    code: 'ENOENT',
  })
  const invalid = join(home.root, 'invalid.json')
  await writeFile(invalid, JSON.stringify({ format: supportMatrixFormat, rows: [{}] }))
  await expect(startDaemon(home, onTestFinished, { supportMatrix: invalid })).rejects.toThrow(invalid)
})
