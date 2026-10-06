import { delimiter, dirname, join } from 'node:path'
import { codexHooksState, deployHookBinary, hookBinaryName } from '@aang/hook'
import { installFakeCodex } from '@aang/testkit'
import { inject, test, vi } from 'vitest'
import { type AppServerCall, fakeAppServer } from './app-server.js'
import { createInstallHome, type InstallHome } from './install.js'
import { isAlive, resumeWindowsProcess, suspendWindowsProcess, waitUntil } from './launcher.js'

const onWindows = test.runIf(process.platform === 'win32')

const hangingCheck = async (home: InstallHome, signal?: AbortSignal) => {
  await deployHookBinary({ aangHome: home.aangHome, hookBinarySource: inject('hookBinaries').plain })
  const cli = await fakeAppServer(home, { failure: 'timeout' })
  const options = { aangHome: home.aangHome, codexHome: home.codexHome, codex: cli }
  const checking = codexHooksState({ ...options, timeoutMs: 120_000, ...(signal === undefined ? {} : { signal }) })
  checking.catch(() => undefined)
  const server = await vi.waitFor(async (): Promise<AppServerCall> => {
    const listing = (await cli.calls()).find((call) => call.request.method === 'hooks/list')
    if (listing === undefined) {
      throw new Error('the app-server has not received hooks/list yet')
    }
    return listing
  }, { timeout: 20_000, interval: 50 })
  return { cli, options, checking, server }
}

onWindows(
  'on Windows the Codex hooks state needs the launcher of the installation and fails explicitly without it, starting no CLI',
  async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)

    await expect(codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: home.codex })).rejects.toMatchObject({
      reason: 'codex_app_server',
      message: expect.stringContaining(hookBinaryName) as unknown,
    })

    await expect(home.codex.calls()).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

onWindows(
  'on Windows a Codex command given by name runs the codex.exe found in PATH through the launcher',
  async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    await deployHookBinary({ aangHome: home.aangHome, hookBinarySource: inject('hookBinaries').plain })
    const codex = installFakeCodex(join(home.root, 'fakes'))
    vi.stubEnv('PATH', `${dirname(codex.executable)}${delimiter}${process.env.PATH ?? ''}`)
    onTestFinished(() => {
      vi.unstubAllEnvs()
    })

    const state = await codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: { command: 'codex' } })

    expect(state.status).toBe('not_installed')
    expect(codex.calls().filter((call) => call.command === 'app_server')).toHaveLength(1)
  },
)

onWindows(
  'a suspended launcher bounds a cancelled check by the stop deadline and blocks checks of the profile until it confirms the stop late',
  { timeout: 90_000 },
  async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const cancel = new AbortController()
    const { cli, options, checking, server } = await hangingCheck(home, cancel.signal)
    const launcher = server.ppid
    await suspendWindowsProcess(launcher)
    onTestFinished(async () => {
      if (isAlive(launcher)) {
        await resumeWindowsProcess(launcher)
      }
    })

    const cancelledAt = Date.now()
    cancel.abort()
    await expect(checking).rejects.toMatchObject({ reason: 'codex_app_server', message: expect.stringContaining('did not stop') as unknown })
    expect(Date.now() - cancelledAt).toBeLessThan(30_000)

    const calls = (await cli.calls()).length
    await expect(codexHooksState(options)).rejects.toMatchObject({
      reason: 'codex_app_server',
      message: expect.stringContaining('not confirmed stopped') as unknown,
    })
    expect(await cli.calls()).toHaveLength(calls)
    expect(isAlive(server.pid)).toBe(true)

    await resumeWindowsProcess(launcher)
    await waitUntil(() => !isAlive(launcher) && !isAlive(server.pid))

    const state = await vi.waitFor(() => codexHooksState(options), { timeout: 20_000, interval: 100 })
    expect(state.status).toBe('not_installed')
    expect((await cli.calls()).length).toBeGreaterThan(calls)
  },
)

onWindows(
  'a launcher lost without a status file fails the check at once and blocks further checks of the profile',
  { timeout: 60_000 },
  async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const { cli, options, checking, server } = await hangingCheck(home)

    process.kill(server.ppid, 'SIGKILL')

    await expect(checking).rejects.toMatchObject({
      reason: 'codex_app_server',
      message: expect.stringContaining('without confirming') as unknown,
    })
    await waitUntil(() => !isAlive(server.pid))
    const calls = (await cli.calls()).length
    await expect(codexHooksState(options)).rejects.toMatchObject({
      reason: 'codex_app_server',
      message: expect.stringContaining('not confirmed stopped') as unknown,
    })
    expect(await cli.calls()).toHaveLength(calls)
  },
)
