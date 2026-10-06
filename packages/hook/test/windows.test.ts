import { delimiter, dirname, join } from 'node:path'
import { codexHooksState, deployHookBinary, hookBinaryName } from '@aang/hook'
import { installFakeCodex } from '@aang/testkit'
import { inject, test, vi } from 'vitest'
import { createInstallHome } from './install.js'

const onWindows = test.runIf(process.platform === 'win32')

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
