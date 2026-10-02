import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { deployHookBinary, hookBinaryName, writeClaudePlugin } from '@aang/hook'
import { inject, test } from 'vitest'
import { cleanExit, type HookResult, readSpoolEvents, runProcess, typicalEnv } from './hook.js'
import { createInstallHome, readJson } from './install.js'

interface Handler {
  readonly command: string
  readonly args: readonly string[]
}

interface PluginHooks {
  readonly hooks: Readonly<Record<string, readonly { readonly hooks: readonly Handler[] }[]>>
}

type Launch = { readonly afterUpdate: boolean } & (
  | { readonly launched: true; readonly result: HookResult }
  | { readonly launched: false; readonly code: unknown }
)

const binaries = inject('hookBinaries')
const callers = 4
const callsPerPhase = 24

const errorCode = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : error)

test('updating the binary during continuous hook calls keeps the plugin command line and every launched call exits 0', async ({
  expect,
  onTestFinished,
}) => {
  const home = await createInstallHome(onTestFinished)
  const prepare = async (source: string): Promise<void> => {
    const hookBinary = await deployHookBinary({ aangHome: home.aangHome, hookBinarySource: source })
    await writeClaudePlugin({ directory: home.paths.claudePlugin, hookBinary, spool: home.paths.spool })
  }
  await prepare(binaries.plain)
  const plugin = await readFile(home.pluginHooksFile)
  const [handler] = ((await readJson(home.pluginHooksFile)) as PluginHooks).hooks.PreToolUse?.[0]?.hooks ?? []
  expect(handler).toBeDefined()
  const launches: Launch[] = []
  let updated = false
  let stopped = false
  const call = async (): Promise<void> => {
    while (!stopped) {
      const afterUpdate = updated
      try {
        launches.push({
          afterUpdate,
          launched: true,
          result: await runProcess(handler?.command ?? '', handler?.args ?? [], { env: typicalEnv }),
        })
      } catch (error) {
        launches.push({ afterUpdate, launched: false, code: errorCode(error) })
        await delay(1)
      }
    }
  }
  const waitForLaunches = async (count: number, afterUpdate: boolean): Promise<void> => {
    while (launches.filter((launch) => launch.afterUpdate === afterUpdate).length < count) {
      await delay(5)
    }
  }
  const running = Array.from({ length: callers }, call)

  await waitForLaunches(callsPerPhase, false)
  await prepare(binaries.stripped)
  updated = true
  await waitForLaunches(callsPerPhase, true)
  stopped = true
  await Promise.all(running)

  expect(await readFile(home.pluginHooksFile)).toEqual(plugin)
  expect(await readFile(home.paths.binary)).toEqual(await readFile(binaries.stripped))
  const results = launches.flatMap((launch) => (launch.launched ? [launch.result] : []))
  expect(results).toEqual(results.map(() => cleanExit))
  const failedLaunches = launches.flatMap((launch) => (launch.launched ? [] : [launch.code]))
  expect(failedLaunches).toEqual(process.platform === 'win32' ? failedLaunches.map(() => 'ENOENT') : [])
  expect(launches.filter((launch) => launch.afterUpdate && launch.launched).length).toBeGreaterThan(0)
  expect(await readSpoolEvents(home.paths.spool)).toHaveLength(results.length)

  await deployHookBinary({ aangHome: home.aangHome, hookBinarySource: binaries.stripped })

  expect(await readdir(dirname(home.paths.binary))).toEqual([hookBinaryName])
}, 120_000)

test('the next deploy removes copies left by an interrupted update', async ({ expect, onTestFinished }) => {
  const home = await createInstallHome(onTestFinished)
  const directory = dirname(home.paths.binary)
  await mkdir(directory, { recursive: true })
  const leftovers = [`.${hookBinaryName}.1.staged`, `.${hookBinaryName}.2.retired`]
  for (const name of leftovers) {
    await writeFile(join(directory, name), 'partial')
  }
  await writeFile(join(directory, 'notes.txt'), 'kept')

  await deployHookBinary({ aangHome: home.aangHome, hookBinarySource: binaries.plain })

  expect((await readdir(directory)).sort()).toEqual([hookBinaryName, 'notes.txt'].sort())
  expect(await readFile(home.paths.binary)).toEqual(await readFile(binaries.plain))
})
