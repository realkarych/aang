import { mkdtemp, realpath, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type TestContext } from 'vitest'
import { createClaudeBackend, createCodexBackend, type LaunchStatus } from '@aang/observer'
import { installFakeClaude, installFakeCodex } from '@aang/testkit'
import { failNextProcessTableRead } from './process-table.js'

const builtins = { mcpServers: [], skills: [], plugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'] }
const input = { model: { version: 7 }, batch: { facts: [] }, private: 'working data must not reach admission' }
const output = { base_version: 7, ops: [], needs: [] }
const sandbox = async ({ onTestFinished }: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-admission-')))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10 }))
  const home = join(root, 'Имя Фамилия')
  await mkdir(home)
  return {
    root,
    options: {
      temporaryDirectory: root,
      environment: { ...process.env, HOME: home, USERPROFILE: home },
      windowsLauncher: resolve('packages/hook/bin/aang-hook.exe'),
      admissionStatusPath: join(root, 'support.json'),
    },
  }
}

for (const runtime of ['claude', 'codex'] as const) {
  test(`${runtime} blocks user data until synthetic admission and records its local result`, async (context) => {
    const { root, options } = await sandbox(context)
    const cli = runtime === 'claude' ? installFakeClaude(root, { replies: [{ kind: 'answer', output }] }) : installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
    const backend = runtime === 'claude' ? createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins }) : createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
    const statuses: LaunchStatus[] = []
    const unsubscribe = backend.subscribe((snapshot) => { statuses.push(snapshot) })
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'version_not_admitted' } })
    expect(cli.calls()).toEqual([])
    const admitted = await backend.admit()
    expect(admitted).toMatchObject({ admitted: true, runtime })
    expect(admitted.warning).toBe(runtime === 'claude' ? 'изоляция от сообщений других сессий на этой версии не проверена' : null)
    expect(JSON.parse(await readFile(options.admissionStatusPath, 'utf8'))).toEqual(admitted)
    const probes = cli.calls().filter((call) => call.prompt !== null)
    expect(probes).toHaveLength(2)
    expect(probes.every((call) => !call.prompt?.includes(input.private))).toBe(true)
    const positive = probes[0]
    const negative = probes[1]
    expect(positive?.cwd).toBe(negative?.cwd)
    expect(positive?.env).toEqual(negative?.env)
    if (runtime === 'claude') {
      expect(positive?.argv.map((arg) => arg === 'project' ? '' : arg)).toEqual(negative?.argv)
    } else {
      expect(positive?.argv).toContain('--dangerously-bypass-hook-trust')
      expect(negative?.argv).toContain('--dangerously-bypass-hook-trust')
      const argv = [...(negative?.argv ?? [])]
      argv.splice(argv.indexOf('hooks') - 1, 2)
      expect(positive?.argv).toEqual(argv)
    }
    expect(await backend.execute({ input })).toMatchObject({ ok: true, output })
    expect(cli.calls().at(-1)?.argv).not.toContain('--dangerously-bypass-hook-trust')
    cli.setScenario({ version: '99.0.0', replies: [{ kind: 'answer', output }] })
    const count = cli.calls().filter((call) => call.prompt !== null).length
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'version_not_admitted' } })
    expect(cli.calls().filter((call) => call.prompt !== null)).toHaveLength(count)
    expect(await backend.admit()).toMatchObject({ admitted: true, version: '99.0.0' })
    expect(await backend.execute({ input })).toMatchObject({ ok: true })
    expect(statuses.some((snapshot) => snapshot.state.state === 'disabled')).toBe(true)
    expect(statuses.some((snapshot) => snapshot.state.state === 'ok')).toBe(true)
    unsubscribe()
  })
}

for (const fault of ['hook_missing', 'hook_leak', 'registry_missing', 'registry_marker', 'transcript', 'tool_execution'] as const) {
  test(`Claude refuses admission on ${fault} and never receives working data`, async (context) => {
    const { root, options } = await sandbox(context)
    const cli = installFakeClaude(root, { admissionFault: fault })
    const backend = createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
    expect(await backend.admit()).toMatchObject({ admitted: false, reason: expect.any(String) as unknown })
    expect(backend.status().state).toEqual({ state: 'disabled', reason: 'isolation' })
    const count = cli.calls().length
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
    expect(cli.calls()).toHaveLength(count)
    expect(JSON.parse(await readFile(options.admissionStatusPath, 'utf8'))).toMatchObject({ admitted: false })
  })
}

for (const fault of ['hook_missing', 'hook_leak', 'rollout', 'sqlite', 'tool_supported', 'no_http'] as const) {
  test(`Codex refuses admission on ${fault}`, async (context) => {
    const { root, options } = await sandbox(context)
    const cli = installFakeCodex(root, { admissionFault: fault })
    const backend = createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
    expect(await backend.admit()).toMatchObject({ admitted: false, reason: expect.any(String) as unknown })
    expect(backend.status().state).toEqual({ state: 'disabled', reason: 'isolation' })
    const count = cli.calls().length
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
    expect(cli.calls()).toHaveLength(count)
  })
}

for (const model of ['gpt-5.5', 'gpt-6.1-sol']) {
  test(`Codex disables ${model} when its Responses inventory contains tools`, async (context) => {
    const { root, options } = await sandbox(context)
    const cli = installFakeCodex(root, { leakedTools: ['exec'] })
    const backend = createCodexBackend({ ...options, cli, model })
    expect(await backend.admit()).toMatchObject({ admitted: false, reason: expect.stringContaining('advertised tools') as unknown })
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  })
}

test('Claude requires a fresh successful admission after a runtime isolation violation', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root)
  const backend = createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins, verifiedClaudeVersions: ['2.1.286'] })
  expect(await backend.admit()).toMatchObject({ admitted: true, warning: null })
  cli.setScenario({ leakedTools: ['Bash'], replies: [{ kind: 'answer', output }] })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(backend.admission()).toMatchObject({ admitted: false })
  cli.setScenario({ replies: [{ kind: 'answer', output }] })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(await backend.admit()).toMatchObject({ admitted: true })
  expect(await backend.execute({ input })).toMatchObject({ ok: true })
  const restarted = createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', effort: 'high', builtins })
  expect(await restarted.execute({ input })).toMatchObject({ ok: false, error: { class: 'version_not_admitted' } })
  expect(await restarted.admit()).toMatchObject({ admitted: true, warning: expect.any(String) as unknown })
  expect(restarted.admission().profile).not.toBe(backend.admission().profile)
})

test('working calls are refused while admission is in progress', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root)
  const backend = createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  const pending = backend.admit()
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'admission_busy' } })
  expect(await backend.admit()).toMatchObject({ admitted: false, reason: 'admission_busy' })
  expect(await pending).toMatchObject({ admitted: true })
  expect(cli.calls().filter((call) => call.prompt?.includes(input.private))).toEqual([])
})

test('working calls run side by side and admission waits until they finish', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root, { replies: [{ kind: 'answer', output }, { kind: 'answer', output }] })
  const backend = createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.admit()).toMatchObject({ admitted: true })
  const calls = [backend.execute({ input }), backend.execute({ input })]
  expect(await backend.admit()).toMatchObject({ admitted: false, reason: 'admission_busy' })
  expect(await Promise.all(calls)).toMatchObject([{ ok: true, output }, { ok: true, output }])
  expect(await backend.admit()).toMatchObject({ admitted: true })
})

for (const runtime of ['claude', 'codex'] as const) {
  test(`${runtime} cannot pass negative hook control with its switch removed`, async (context) => {
    const { root, options } = await sandbox(context)
    const fake = runtime === 'claude' ? installFakeClaude(root) : installFakeCodex(root)
    const cli = { command: process.execPath, args: [fileURLToPath(new URL('admission-wrapper.ts', import.meta.url)), runtime, fake.command, ...fake.args] }
    const backend = runtime === 'claude' ? createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins }) : createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
    expect(await backend.admit()).toMatchObject({ admitted: false, reason: expect.stringContaining('hooks executed') as unknown })
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  })
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true }
  catch (error) { return error instanceof Error && 'code' in error && error.code !== 'ESRCH' }
}

for (const runtime of ['claude', 'codex'] as const) {
  for (const ending of ['exits during the call', 'outlives the stopped group'] as const) {
    test.skipIf(process.platform === 'win32')(`${runtime} fails admission when a descendant leaves the process group and ${ending}`, async (context) => {
      const { root, options } = await sandbox(context)
      const pidFile = join(root, 'escaped.pid')
      context.onTestFinished(async () => {
        const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
        if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
      })
      const scenario = { groupEscape: { pidFile, lifetimeMs: ending === 'exits during the call' ? 200 : 20_000 }, replies: [{ kind: 'answer' as const, output }] }
      const cli = runtime === 'claude' ? installFakeClaude(root, scenario) : installFakeCodex(root, scenario)
      const backend = runtime === 'claude' ? createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins }) : createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
      expect(await backend.admit()).toMatchObject({ admitted: false, reason: expect.stringMatching(/^CLI descendant left its process group: /) as unknown })
      expect(backend.status()).toEqual({ activeCalls: 0, state: { state: 'disabled', reason: 'isolation' } })
      expect(alive(Number(await readFile(pidFile, 'utf8')))).toBe(ending === 'outlives the stopped group')
      expect(JSON.parse(await readFile(options.admissionStatusPath, 'utf8'))).toMatchObject({ admitted: false, reason: expect.stringMatching(/^CLI descendant left its process group: /) as unknown })
      const count = cli.calls().length
      expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
      expect(cli.calls()).toHaveLength(count)
      cli.setScenario({ replies: [{ kind: 'answer', output }] })
      expect(await backend.admit()).toMatchObject({ admitted: true })
      expect(await backend.execute({ input })).toMatchObject({ ok: true, output })
    })
  }
}

test.skipIf(process.platform === 'win32')('Codex fails admission when its profile leaves the shell snapshot enabled', async (context) => {
  const { root, options } = await sandbox(context)
  const fake = installFakeCodex(root)
  const cli = { command: process.execPath, args: [fileURLToPath(new URL('snapshot-wrapper.ts', import.meta.url)), fake.command, ...fake.args] }
  const backend = createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
  expect(await backend.admit()).toMatchObject({ admitted: false, reason: expect.stringMatching(/^CLI descendant left its process group: /) as unknown })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(fake.calls().filter((call) => call.prompt !== null)).toHaveLength(1)
})

for (const runtime of ['claude', 'codex'] as const) {
  test.skipIf(process.platform === 'win32')(`${runtime} fails admission when the process table cannot be read during a call even if the final read succeeds`, async (context) => {
    const { root, options } = await sandbox(context)
    const cli = runtime === 'claude' ? installFakeClaude(root, { replies: [{ kind: 'answer', output }] }) : installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
    const backend = runtime === 'claude' ? createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins }) : createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
    context.onTestFinished(failNextProcessTableRead())
    expect(await backend.admit()).toMatchObject({ admitted: false, reason: expect.stringMatching(/^CLI process group could not be checked: .*process table is unavailable/) as unknown })
    expect(backend.status()).toEqual({ activeCalls: 0, state: { state: 'disabled', reason: 'isolation' } })
    const count = cli.calls().length
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
    expect(cli.calls()).toHaveLength(count)
  })
}

test('Codex cannot reuse the positive control output when the negative branch omits last.json', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeCodex(root, { admissionFault: 'missing_last' })
  const backend = createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
  expect(await backend.admit()).toMatchObject({ admitted: false })
  expect(await backend.execute({ input })).toMatchObject({ ok: false })
})

test('Claude rejects tools in synthetic init before permitting working calls', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root, { leakedTools: ['Bash'] })
  const backend = createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.admit()).toMatchObject({ admitted: false, reason: expect.stringContaining('init') as unknown })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
})

test('Codex admits the flat Responses inventory and can readmit after a working tool attempt', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeCodex(root, { replies: [{ kind: 'answer', output, toolAttempts: ['exec'] }] })
  const backend = createCodexBackend({ ...options, cli, model: 'gpt-5.5' })
  expect(await backend.admit()).toMatchObject({ admitted: true })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(backend.admission()).toMatchObject({ admitted: false })
  cli.setScenario({ replies: [{ kind: 'answer', output }] })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(await backend.admit()).toMatchObject({ admitted: true })
  expect(await backend.execute({ input })).toMatchObject({ ok: true })
})

for (const runtime of ['claude', 'codex'] as const) {
  test(`${runtime} refuses a version change between the admission gate and working launch`, async (context) => {
    const { root, options } = await sandbox(context)
    const fake = runtime === 'claude' ? installFakeClaude(root, { replies: [{ kind: 'answer', output }] }) : installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
    const cli = { command: process.execPath, args: [fileURLToPath(new URL('version-wrapper.ts', import.meta.url)), runtime, join(root, 'version-count'), fake.command, ...fake.args] }
    const backend = runtime === 'claude' ? createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins }) : createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
    expect(await backend.admit()).toMatchObject({ admitted: true })
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'version_not_admitted' } })
    expect(fake.calls().filter((call) => call.prompt?.includes(input.private))).toEqual([])
    expect(backend.admission()).toMatchObject({ admitted: false })
    expect(JSON.parse(await readFile(options.admissionStatusPath, 'utf8'))).toMatchObject({ admitted: false })
  })
}

test.skipIf(process.platform === 'win32')('Claude refuses an unadmitted CLI after an updater switches its symlink during the version check', async (context) => {
  const { root, options } = await sandbox(context)
  const admitted = installFakeClaude(join(root, 'old'), { version: '2.1.286' })
  const updated = installFakeClaude(join(root, 'new'), { version: '99.0.0', replies: [{ kind: 'answer', output }] })
  const entry = join(root, 'claude-entry')
  const wrapper = join(root, 'updater.mjs')
  const enabled = join(root, 'update-enabled')
  await writeFile(wrapper, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, renameSync, symlinkSync } from 'node:fs'
const args = process.argv.slice(2)
const result = spawnSync(${JSON.stringify(admitted.command)}, args, { stdio: 'inherit' })
if (args.includes('--version') && existsSync(${JSON.stringify(enabled)})) {
  symlinkSync(${JSON.stringify(updated.command)}, ${JSON.stringify(`${entry}.updated`)})
  renameSync(${JSON.stringify(`${entry}.updated`)}, ${JSON.stringify(entry)})
}
process.exitCode = result.status ?? 1
`, { mode: 0o755 })
  await symlink(wrapper, entry)
  const backend = createClaudeBackend({ ...options, cli: entry, model: 'claude-opus-5-5', builtins })
  expect(await backend.admit()).toMatchObject({ admitted: true, version: '2.1.286' })
  await writeFile(enabled, '')
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'version_not_admitted' } })
  expect(await realpath(entry)).toBe(updated.command)
  expect(updated.calls().filter((call) => call.prompt !== null)).toEqual([])
  expect(backend.admission()).toMatchObject({ admitted: false })
  expect(backend.status()).toMatchObject({ activeCalls: 0, state: { state: 'disabled', reason: 'version_not_admitted' } })
  expect(JSON.parse(await readFile(options.admissionStatusPath, 'utf8'))).toMatchObject({ admitted: false })
  const count = updated.calls().length
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'version_not_admitted' } })
  expect(updated.calls()).toHaveLength(count)
  expect(await backend.admit()).toMatchObject({ admitted: true, version: '99.0.0' })
  expect(await backend.execute({ input })).toMatchObject({ ok: true, output })
})

for (const runtime of ['claude', 'codex'] as const) {
  test.skipIf(process.platform === 'win32')(`${runtime} pins an object CLI through a symlink update after the internal version check`, async (context) => {
    const { root, options } = await sandbox(context)
    const install = runtime === 'claude' ? installFakeClaude : installFakeCodex
    const admitted = install(join(root, 'old'), { version: '1.0.0', replies: [{ kind: 'answer', output }] })
    const updated = install(join(root, 'new'), { version: '99.0.0', replies: [{ kind: 'answer', output }] })
    const entry = join(root, 'cli-entry')
    const wrapper = join(root, 'updater.mjs')
    const counter = join(root, 'working-version-count')
    await writeFile(wrapper, `#!${process.execPath}
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync, symlinkSync } from 'node:fs'
const args = process.argv.slice(2)
const result = spawnSync(${JSON.stringify(admitted.command)}, args, { stdio: 'inherit' })
const counter = ${JSON.stringify(counter)}
if (args.includes('--version') && existsSync(counter)) {
  const count = Number(readFileSync(counter, 'utf8')) + 1
  writeFileSync(counter, String(count))
  if (count === 2) {
    symlinkSync(${JSON.stringify(updated.command)}, ${JSON.stringify(`${entry}.updated`)})
    renameSync(${JSON.stringify(`${entry}.updated`)}, ${JSON.stringify(entry)})
  }
}
process.exitCode = result.status ?? 1
`, { mode: 0o755 })
    await symlink(wrapper, entry)
    const cli = { command: entry, args: [] }
    const backend = runtime === 'claude' ? createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins }) : createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
    expect(await backend.admit()).toMatchObject({ admitted: true, version: '1.0.0' })
    await writeFile(counter, '0')
    expect(await backend.execute({ input })).toMatchObject({ ok: true, output })
    expect(await readFile(counter, 'utf8')).toBe('2')
    expect(await realpath(entry)).toBe(updated.command)
    expect(updated.calls().map((call) => call.command)).toEqual([])
    expect(admitted.calls().at(-1)?.prompt).toBe(JSON.stringify(input))
    expect(backend.admission()).toMatchObject({ admitted: true, version: '1.0.0' })
    expect(JSON.parse(await readFile(options.admissionStatusPath, 'utf8'))).toMatchObject({ admitted: true, version: '1.0.0' })
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'version_not_admitted' } })
    expect(updated.calls().map((call) => call.command)).toEqual(['version'])
    expect(backend.admission()).toMatchObject({ admitted: false })
    expect(JSON.parse(await readFile(options.admissionStatusPath, 'utf8'))).toMatchObject({ admitted: false })
  })
}

test('readmission revokes the local success record before running new probes', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root)
  const backend = createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.admit()).toMatchObject({ admitted: true })
  const pending = backend.admit()
  try {
    await expect.poll(() => cli.calls().filter((call) => call.command === 'version').length).toBe(3)
    expect(JSON.parse(await readFile(options.admissionStatusPath, 'utf8'))).toMatchObject({ admitted: false, reason: 'admission_pending' })
  } finally { await pending }
})

test('an unreadable Claude registry fails admission without an uncaught timer error', async (context) => {
  const { root, options } = await sandbox(context)
  const registryRoot = join(options.environment.HOME, '.claude')
  await mkdir(registryRoot)
  await writeFile(join(registryRoot, 'sessions'), 'not a directory')
  const cli = installFakeClaude(root)
  const backend = createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.admit()).toMatchObject({ admitted: false })
  expect(await backend.execute({ input })).toMatchObject({ ok: false })
})

test.skipIf(process.platform === 'win32')('Claude admits when the temporary directory has a symlink alias', async (context) => {
  const { root, options } = await sandbox(context)
  const physical = join(root, 'physical')
  const alias = join(root, 'alias')
  await mkdir(physical)
  await symlink(physical, alias)
  const cli = installFakeClaude(root)
  const backend = createClaudeBackend({ ...options, temporaryDirectory: alias, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.admit()).toMatchObject({ admitted: true })
})
