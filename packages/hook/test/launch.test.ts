import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RegistrationTag, Runtime } from '@aang/contract'
import { test } from 'vitest'
import { cleanExit, createSpool, runHook, typicalEnv, typicalPayload, withoutNames } from './hook.js'
import { createLaunchSandbox, isAlive, type LaunchSandbox, waitUntil } from './launcher.js'

const onWindows = test.runIf(process.platform === 'win32')

const launchUsage = 'usage: aang-hook launch <status-file> <input-bytes|stream> <program> [argument ...]\n'

onWindows(
  'passes the first n bytes of its stdin to the CLI unchanged, streams the CLI output and records the root exit code',
  async ({ expect, onTestFinished }) => {
    const sandbox = await createLaunchSandbox(onTestFinished)
    const input = Buffer.concat([typicalPayload, Buffer.from('\r\n\u0000ÿ', 'latin1'), Buffer.from(' Имя Фамилия')])
    const args = ['with space', 'quote"inside', 'trailing\\', '', 'Имя Фамилия']
    const launcher = sandbox.launch([sandbox.statusPath, String(input.length), ...sandbox.command('echo', '7', ...args)], {
      AANG_LAUNCH_PROBE: 'probe value',
    })

    launcher.stdin.write(Buffer.concat([input, Buffer.from('beyond the input')]))

    expect(await launcher.closed).toBe(0)
    expect(launcher.stdout()).toEqual(input)
    expect(launcher.stderr()).toBe('cli stderr')
    expect(await sandbox.status()).toEqual({ outcome: 'stopped', exit_code: 7 })
    expect(await sandbox.report()).toEqual({ args, cwd: sandbox.directory, probe: 'probe value' })
  },
)

onWindows(
  'stops a descendant that the exited root left without shared channels before writing the status',
  async ({ expect, onTestFinished }) => {
    const sandbox = await createLaunchSandbox(onTestFinished)
    const launcher = sandbox.launch([sandbox.statusPath, '0', ...sandbox.command('orphan')])
    const descendant = await sandbox.pid('descendant')

    await waitUntil(() => existsSync(sandbox.statusPath))

    expect(isAlive(descendant)).toBe(false)
    expect(await sandbox.status()).toEqual({ outcome: 'stopped', exit_code: 0 })
    expect(await launcher.closed).toBe(0)
  },
)

onWindows(
  'in stream mode passes its stdin to the CLI as it arrives, and closing it stops the whole tree',
  async ({ expect, onTestFinished }) => {
    const sandbox = await createLaunchSandbox(onTestFinished)
    const launcher = sandbox.launch([sandbox.statusPath, 'stream', ...sandbox.command('reply')])
    const root = await sandbox.pid('root')
    const replies = (): string => launcher.stdout().toString('utf8')

    launcher.stdin.write('first Имя Фамилия\n')
    await waitUntil(() => replies().includes('reply first Имя Фамилия\n'))
    launcher.stdin.write('second\n')
    await waitUntil(() => replies().includes('reply second\n'))
    expect(isAlive(root)).toBe(true)

    launcher.stdin.end()

    expect(await launcher.closed).toBe(0)
    expect(replies()).toBe('reply first Имя Фамилия\nreply second\n')
    expect(await sandbox.status()).toEqual({ outcome: 'stopped', exit_code: 1 })
    expect(isAlive(root)).toBe(false)
  },
)

onWindows('closing its stdin stops the whole tree', async ({ expect, onTestFinished }) => {
  const sandbox = await createLaunchSandbox(onTestFinished)
  const launcher = sandbox.launch([sandbox.statusPath, '0', ...sandbox.command('hold')])
  const tree = [await sandbox.pid('root'), await sandbox.pid('descendant')]
  expect(tree.map(isAlive)).toEqual([true, true])

  launcher.stdin.end()

  expect(await launcher.closed).toBe(0)
  expect(await sandbox.status()).toEqual({ outcome: 'stopped', exit_code: 1 })
  expect(tree.map(isAlive)).toEqual([false, false])
})

onWindows(
  'the exit of the process that started it closes its stdin and stops the whole tree',
  async ({ expect, onTestFinished }) => {
    const sandbox = await createLaunchSandbox(onTestFinished)
    const parent = sandbox.launchFromParent([sandbox.statusPath, '0', ...sandbox.command('hold')])
    const tree = [await sandbox.pid('root'), await sandbox.pid('descendant')]
    const launcher = await sandbox.pid('launcher')
    expect([launcher, ...tree].map(isAlive)).toEqual([true, true, true])

    await parent.kill()
    await waitUntil(() => existsSync(sandbox.statusPath))

    expect(await sandbox.status()).toEqual({ outcome: 'stopped', exit_code: 1 })
    expect(tree.map(isAlive)).toEqual([false, false])
    await waitUntil(() => !isAlive(launcher))
  },
)

onWindows(
  'terminated from outside, it leaves no process of the job and writes no status',
  async ({ expect, onTestFinished }) => {
    const sandbox = await createLaunchSandbox(onTestFinished)
    const launcher = sandbox.launch([sandbox.statusPath, '0', ...sandbox.command('hold')])
    const tree = [await sandbox.pid('root'), await sandbox.pid('descendant')]

    await launcher.kill()
    await waitUntil(() => !tree.some(isAlive))

    expect(existsSync(sandbox.statusPath)).toBe(false)
  },
)

onWindows(
  'a program that cannot be created is not started and the status names the failed step',
  async ({ expect, onTestFinished }) => {
    const sandbox = await createLaunchSandbox(onTestFinished)
    const launcher = sandbox.launch([sandbox.statusPath, '0', join(sandbox.directory, 'missing.exe')])

    expect(await launcher.closed).toBe(0)
    expect([launcher.stdout().length, launcher.stderr()]).toEqual([0, ''])
    const { error, ...status } = (await sandbox.status()) as Readonly<Record<string, unknown>>
    expect(status).toEqual({ outcome: 'not_started', step: 'create_process' })
    expect(error).toBeTypeOf('string')
  },
)

interface UsageCase {
  readonly name: string
  readonly args: (sandbox: LaunchSandbox) => readonly string[]
}

const usageCases: readonly UsageCase[] = [
  { name: 'no arguments', args: () => [] },
  { name: 'no program', args: (sandbox) => [sandbox.statusPath, '0'] },
  { name: 'an empty status path', args: () => ['', '0', process.execPath] },
  { name: 'an empty program', args: (sandbox) => [sandbox.statusPath, '0', ''] },
  { name: 'an input length that is not a number', args: (sandbox) => [sandbox.statusPath, 'all', process.execPath] },
  { name: 'a negative input length', args: (sandbox) => [sandbox.statusPath, '-1', process.execPath] },
]

onWindows.for(usageCases)(
  'refuses $name with the usage line, starts nothing and writes no status',
  async (usage, { expect, onTestFinished }) => {
    const sandbox = await createLaunchSandbox(onTestFinished)
    const launcher = sandbox.launch(usage.args(sandbox))

    expect(await launcher.closed).toBe(2)
    expect([launcher.stdout().length, launcher.stderr()]).toEqual([0, launchUsage])
    expect(existsSync(sandbox.statusPath)).toBe(false)
  },
)

onWindows('a status file that cannot be written leaves the stop unconfirmed', async ({ expect, onTestFinished }) => {
  const sandbox = await createLaunchSandbox(onTestFinished)
  const statusPath = join(sandbox.directory, 'missing', 'status.json')
  const launcher = sandbox.launch([statusPath, '0', ...sandbox.command('echo', '0')])

  expect(await launcher.closed).toBe(1)
  expect(await sandbox.report()).toEqual({ args: [], cwd: sandbox.directory, probe: null })
  expect(existsSync(dirname(statusPath))).toBe(false)
})

const registrations: readonly { readonly runtime: Runtime; readonly tag: RegistrationTag }[] = [
  { runtime: 'claude', tag: 'plugin' },
  { runtime: 'codex', tag: 'user' },
]

onWindows.for(registrations)(
  'a $runtime hook call from the configs is recorded as an event and never reaches the launcher',
  async ({ runtime, tag }, { expect, onTestFinished }) => {
    const spool = await createSpool(onTestFinished)

    const result = await runHook(spool.args(runtime, tag), { env: typicalEnv })

    expect(result).toEqual(cleanExit)
    expect(withoutNames(await spool.events())).toEqual([
      { header: { runtime, registration: tag, env: typicalEnv }, payload: typicalPayload },
    ])
  },
)
