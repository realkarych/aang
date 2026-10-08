import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'vitest'
import type { Cli } from '../dist/clis.js'
import { createJournal } from '../dist/journal.js'
import { createLab, type Lab, waitFor } from '../dist/lab.js'
import { windows } from '../dist/processes.js'

type Leftover = 'named' | 'group' | 'session' | 'holder'

const strayKey = 'processes of the profile still running after the cleanup'

const leaving = [
  "const { spawn } = process.getBuiltinModule('node:child_process')",
  "const { writeFileSync } = process.getBuiltinModule('node:fs')",
  'const [kind, file, root] = process.argv.slice(1)',
  'const own = Object.fromEntries(Object.entries(process.env).filter(([, value]) => !value.includes(root)))',
  'const options = {',
  "  named: { stdio: 'ignore', detached: true, env: own },",
  "  group: { stdio: 'ignore', env: own },",
  "  session: { stdio: 'ignore', detached: true },",
  "  holder: { stdio: ['ignore', 'inherit', 'ignore'], env: own },",
  '}[kind]',
  "const args = ['-e', 'setTimeout(() => undefined, 120000)', ...(kind === 'named' ? [root] : [])]",
  'const child = spawn(process.execPath, args, { ...options, windowsHide: true })',
  'child.unref()',
  'writeFileSync(file, String(child.pid))',
].join('\n')

const fakeCli = (name: Cli['name']): Cli => ({ name, command: process.execPath, version: 'node' })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const createFakeLab = (): Promise<Lab> =>
  createLab({
    clis: { claude: fakeCli('claude'), codex: fakeCli('codex') },
    aangEntry: fileURLToPath(new URL('../../../packages/aang/dist/main.js', import.meta.url)),
    journal: createJournal(),
  })

const leaveAndDispose = async (kind: Leftover): Promise<{ readonly strays: unknown; readonly aliveAfter: boolean }> => {
  const lab = await createFakeLab()
  const file = join(lab.work, `${kind}.pid`)
  let left: number | null = null
  let disposed = false
  try {
    const cli = lab.claude(['-e', leaving, kind, file, lab.profile.root])
    if (kind === 'holder') {
      await waitFor('the CLI to exit', () => Promise.resolve(!cli.running()), 15_000, 50)
    } else {
      await cli.done
    }
    const pid = Number(await readFile(file, 'utf8'))
    left = pid
    if (!alive(pid)) throw new Error(`the process ${String(pid)} left by the CLI is not running before the cleanup`)
    await lab.dispose(false)
    disposed = true
    const aliveAfter = await waitFor('the stopped process to disappear', () => Promise.resolve(!alive(pid)), 5_000, 50).then(
      () => false,
      () => true,
    )
    return { strays: lab.journal.report({ name: kind, area: 'restart', runtimes: [], summary: '' }, null).observations[strayKey], aliveAfter }
  } finally {
    if (left !== null && alive(left)) process.kill(left, 'SIGKILL')
    if (!disposed) await lab.dispose(false).catch(() => undefined)
  }
}

describe('the cleanup of a scenario stops what an exited CLI left running', () => {
  test('a process whose command line names the profile', async ({ expect }) => {
    const { strays, aliveAfter } = await leaveAndDispose('named')
    expect(aliveAfter).toBe(false)
    expect(strays).toContainEqual(expect.stringContaining('setTimeout'))
  })

  test.skipIf(windows)('a process left in the process group of the CLI', async ({ expect }) => {
    const { strays, aliveAfter } = await leaveAndDispose('group')
    expect(aliveAfter).toBe(false)
    expect(strays).toContainEqual(expect.stringContaining('setTimeout'))
  })

  test.skipIf(windows)('a process in a new session whose environment names the profile', async ({ expect }) => {
    const { strays, aliveAfter } = await leaveAndDispose('session')
    expect(aliveAfter).toBe(false)
    expect(strays).toContainEqual(expect.stringContaining('setTimeout'))
  })

  test.skipIf(windows)('a process in the process group of the CLI that holds its output', async ({ expect }) => {
    const { aliveAfter } = await leaveAndDispose('holder')
    expect(aliveAfter).toBe(false)
  })
})
