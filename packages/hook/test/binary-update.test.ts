import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { deployHookBinary, hookBinaryName, writeClaudePlugin } from '@aang/hook'
import { inject, test } from 'vitest'
import { cleanExit, type HookResult, readSpoolEvents, runProcess, typicalEnv } from './hook.js'
import { createInstallHome, finishedProcessId, readJson } from './install.js'

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
const deployers = 3
const deploysPerLoop = 12

const execFileAsync = promisify(execFile)

const hookModule = new URL('../dist/index.js', import.meta.url).href

const deployLoops = `
const [hookModule, aangHome, rounds, ...sources] = process.argv.slice(1)
const { deployHookBinary } = await import(hookModule)
const deploy = async (offset) => {
  for (let round = 0; round < Number(rounds); round += 1) {
    await deployHookBinary({ aangHome, hookBinarySource: sources[(round + offset) % sources.length] })
  }
}
await Promise.all([deploy(0), deploy(1)])
`

const runDeployer = async (aangHome: string, sources: readonly string[]): Promise<void> => {
  await execFileAsync(process.execPath, [
    '--input-type=module',
    '-e',
    deployLoops,
    hookModule,
    aangHome,
    String(deploysPerLoop),
    ...sources,
  ])
}

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

test('concurrent deploys from several processes into one AANG_HOME all succeed and leave only the binary', async ({
  expect,
  onTestFinished,
}) => {
  const home = await createInstallHome(onTestFinished)
  const sources = [binaries.plain, binaries.stripped]

  await Promise.all(
    Array.from({ length: deployers }, (_, index) =>
      runDeployer(home.aangHome, index % 2 === 0 ? sources : sources.toReversed()),
    ),
  )

  expect(await readdir(dirname(home.paths.binary))).toEqual([hookBinaryName])
  expect([await readFile(binaries.plain), await readFile(binaries.stripped)]).toContainEqual(
    await readFile(home.paths.binary),
  )
}, 120_000)

test('the next deploy removes copies and the lock left by an interrupted update', async ({
  expect,
  onTestFinished,
}) => {
  const home = await createInstallHome(onTestFinished)
  const directory = dirname(home.paths.binary)
  await mkdir(directory, { recursive: true })
  const leftovers = [`.${hookBinaryName}.1.staged`, `.${hookBinaryName}.2.retired`]
  for (const name of leftovers) {
    await writeFile(join(directory, name), 'partial')
  }
  await writeFile(join(directory, `.${hookBinaryName}.lock`), String(await finishedProcessId(onTestFinished)))
  await writeFile(join(directory, 'notes.txt'), 'kept')

  await deployHookBinary({ aangHome: home.aangHome, hookBinarySource: binaries.plain })

  expect((await readdir(directory)).sort()).toEqual([hookBinaryName, 'notes.txt'].sort())
  expect(await readFile(home.paths.binary)).toEqual(await readFile(binaries.plain))
})

test('concurrent deploys from several processes after an interrupted update take over its lock and all succeed', async ({
  expect,
  onTestFinished,
}) => {
  const home = await createInstallHome(onTestFinished)
  const directory = dirname(home.paths.binary)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `.${hookBinaryName}.lock`), String(await finishedProcessId(onTestFinished)))
  const sources = [binaries.plain, binaries.stripped]

  await Promise.all(
    Array.from({ length: deployers }, (_, index) =>
      runDeployer(home.aangHome, index % 2 === 0 ? sources : sources.toReversed()),
    ),
  )

  expect(await readdir(directory)).toEqual([hookBinaryName])
}, 120_000)

test('a lock takeover interrupted by a crash stops the next deploy and leaves both lock files for the user', async ({
  expect,
  onTestFinished,
}) => {
  const home = await createInstallHome(onTestFinished)
  const directory = dirname(home.paths.binary)
  await mkdir(directory, { recursive: true })
  const lock = join(directory, `.${hookBinaryName}.lock`)
  const crashed = String(await finishedProcessId(onTestFinished))
  await writeFile(lock, crashed)
  await writeFile(`${lock}.recovery`, crashed)

  await expect(deployHookBinary({ aangHome: home.aangHome, hookBinarySource: binaries.plain })).rejects.toMatchObject({
    reason: 'install_locked',
    message: expect.stringContaining(`${lock}.recovery`) as unknown,
  })

  expect((await readdir(directory)).sort()).toEqual([`.${hookBinaryName}.lock`, `.${hookBinaryName}.lock.recovery`])
})
