import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect, test, type TestContext } from 'vitest'
import { createClaudeBackend, createCodexBackend, type LaunchStatus } from '@aang/observer'
import { installFakeClaude, installFakeCodex } from '@aang/testkit'

const output = { base_version: 0, ops: [], needs: [] }
const builtins = { mcpServers: [], skills: [], plugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'] }
const input = { model: { version: 0 }, batch: { facts: [] } }
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true }
  catch (error) { return error instanceof Error && 'code' in error && error.code !== 'ESRCH' }
}
const waitUntil = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 20_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await setTimeout(25)
  }
}

const sandbox = async ({ onTestFinished }: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-observer-tree-')))
  const pids: number[] = []
  onTestFinished(async () => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    await rm(root, { recursive: true, force: true, maxRetries: 10 })
  })
  return {
    root,
    options: { temporaryDirectory: root, windowsLauncher: resolve('packages/hook/bin/aang-hook.exe'), environment: { ...process.env, HOME: root, USERPROFILE: root } },
    pid: async (path: string): Promise<number> => {
      await waitUntil(() => existsSync(path))
      const pid = Number(readFileSync(path, 'utf8'))
      pids.push(pid)
      return pid
    },
  }
}

for (const runtime of ['claude', 'codex'] as const) {
  for (const ending of ['timeout', 'cancel', 'exit'] as const) {
    test(`${runtime} ${ending} releases its slot only after the root and descendants stop`, async (context) => {
      const { root, options, pid } = await sandbox(context)
      const pidFile = join(root, 'descendant.pid')
      const scenario = { descendant: { pidFile, inheritStdio: ending !== 'exit' }, replies: [ending === 'exit' ? { kind: 'answer' as const, output } : { kind: 'timeout' as const }] }
      const cli = runtime === 'claude' ? installFakeClaude(root, scenario) : installFakeCodex(root, scenario)
      const backend = runtime === 'claude'
        ? createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins, timeoutMs: ending === 'timeout' ? 2000 : 10_000 })
        : createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol', timeoutMs: ending === 'timeout' ? 2000 : 10_000 })
      const changes: LaunchStatus[] = []
      let releasedWithLiveDescendant = false
      const detach = backend.subscribe((status) => {
        changes.push(status)
        if (status.activeCalls === 0 && existsSync(pidFile) && alive(Number(readFileSync(pidFile, 'utf8')))) releasedWithLiveDescendant = true
      })
      const controller = new AbortController()
      const call = backend.execute({ input, signal: controller.signal })
      const descendant = await pid(pidFile)
      if (ending === 'cancel') controller.abort()
      const result = await call
      expect(result).toMatchObject(ending === 'exit' ? { ok: true } : { ok: false, error: { class: ending === 'cancel' ? 'cancelled' : 'timeout' } })
      expect(alive(descendant)).toBe(false)
      expect(releasedWithLiveDescendant).toBe(false)
      const rootPid = cli.calls().find((call) => call.command === 'print' || call.command === 'exec')?.pid
      expect(rootPid).toBeDefined()
      expect(alive(rootPid ?? 0)).toBe(false)
      expect(backend.status().activeCalls).toBe(0)
      expect(changes.some((change) => change.activeCalls === 1)).toBe(true)
      cli.setScenario({ replies: [{ kind: 'answer', output }] })
      expect(await backend.execute({ input })).toMatchObject({ ok: true })
      detach()
    })
  }
}

for (const ending of ['timeout', 'exit'] as const) {
  test(`Codex npm-style node wrapper ${ending} cannot leave a live CLI child`, async (context) => {
    const { root, options, pid } = await sandbox(context)
    const cli = installFakeCodex(root, { replies: [{ kind: 'timeout' }] })
    const wrapperPid = join(root, 'wrapper.pid')
    const childPid = join(root, 'child.pid')
    const backend = createCodexBackend({
      ...options,
      cli: { command: process.execPath, args: [fileURLToPath(new URL('wrapper.ts', import.meta.url)), ending, wrapperPid, childPid, cli.command, ...cli.args] },
      model: 'gpt-6.1-sol', timeoutMs: 2000,
    })
    const call = backend.execute({ input })
    const wrapper = await pid(wrapperPid)
    const child = await pid(childPid)
    expect(await call).toMatchObject({ ok: false })
    expect(alive(wrapper)).toBe(false)
    expect(alive(child)).toBe(false)
    expect(backend.status().activeCalls).toBe(0)
  })
}


test.skipIf(process.platform === 'win32')('an unreaped group zombie keeps the slot until its external parent reaps it', async (context) => {
  const { root, options, pid } = await sandbox(context)
  const helper = join(root, 'zombie-helper')
  await promisify(execFile)('cc', [fileURLToPath(new URL('zombie.c', import.meta.url)), '-o', helper])
  const cli = installFakeClaude(root, { replies: [{ kind: 'answer', output }] })
  const backend = createClaudeBackend({
    ...options, model: 'claude-opus-5-5', builtins,
    cli: { command: process.execPath, args: [fileURLToPath(new URL('zombie-wrapper.ts', import.meta.url)), helper, root, cli.command, ...cli.args] },
  })
  const changes: LaunchStatus[] = []
  backend.subscribe((status) => changes.push(status))
  const call = backend.execute({ input })
  const zombie = await pid(join(root, 'zombie.pid'))
  const reaper = await pid(join(root, 'reaper.pid'))
  context.onTestFinished(async () => {
    await writeFile(join(root, 'release'), '')
    await waitUntil(() => !alive(zombie) && !alive(reaper))
  })
  expect(await call).toMatchObject({ ok: false, error: { class: 'process_stuck' } })
  expect(backend.status()).toEqual({ activeCalls: 1, state: { state: 'unavailable', reason: 'process_stuck', retry_at: null } })
  const count = cli.calls().length
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'process_stuck' } })
  expect(cli.calls()).toHaveLength(count)
  await writeFile(join(root, 'release'), '')
  await waitUntil(() => backend.status().activeCalls === 0)
  expect(alive(zombie)).toBe(false)
  expect(changes.at(-1)).toEqual({ activeCalls: 0, state: { state: 'ok' } })
  cli.setScenario({ replies: [{ kind: 'answer', output }] })
  expect(await backend.execute({ input })).toMatchObject({ ok: true })
})

test.skipIf(process.platform !== 'win32')('losing the Windows launcher holds the slot and reports process_stuck', async (context) => {
  const { root, options, pid } = await sandbox(context)
  const cli = installFakeCodex(root, { replies: [{ kind: 'timeout' }] })
  const wrapperPid = join(root, 'wrapper.pid')
  const backend = createCodexBackend({
    ...options, model: 'gpt-6.1-sol',
    cli: { command: process.execPath, args: [fileURLToPath(new URL('wrapper.ts', import.meta.url)), 'timeout', wrapperPid, join(root, 'child.pid'), cli.command, ...cli.args] },
  })
  const call = backend.execute({ input })
  const launcher = await pid(`${wrapperPid}.parent`)
  process.kill(launcher, 'SIGKILL')
  expect(await call).toMatchObject({ ok: false, error: { class: 'process_stuck' } })
  expect(backend.status()).toEqual({ activeCalls: 1, state: { state: 'unavailable', reason: 'process_stuck', retry_at: null } })
  const count = cli.calls().length
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'process_stuck' } })
  expect(cli.calls()).toHaveLength(count)
})
