import { mkdtemp, realpath, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type TestContext } from 'vitest'
import { createClaudeBackend, createCodexBackend, type LaunchStatus } from '@aang/observer'
import { installFakeClaude, installFakeCodex } from '@aang/testkit'

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

test('Codex refuses a version change between the admission gate and model catalog lookup', async (context) => {
  const { root, options } = await sandbox(context)
  const fake = installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
  const cli = { command: process.execPath, args: [fileURLToPath(new URL('version-wrapper.ts', import.meta.url)), join(root, 'version-count'), fake.command, ...fake.args] }
  const backend = createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
  expect(await backend.admit()).toMatchObject({ admitted: true })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'version_not_admitted' } })
  expect(fake.calls().filter((call) => call.prompt?.includes(input.private))).toEqual([])
  expect(backend.admission()).toMatchObject({ admitted: false })
})

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
