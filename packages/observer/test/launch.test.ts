import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, expect, type TestContext } from 'vitest'
import { createClaudeLauncher, createCodexLauncher, observerSystemPrompt } from '@aang/observer'
import { installFakeClaude, installFakeCodex } from '@aang/testkit'

const output = { base_version: 7, ops: [], needs: [] }
const input = { model: { version: 7 }, batch: { facts: [] } }
const builtins = { mcpServers: [], skills: [], plugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'] }

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'

const isolatedPath = process.platform === 'win32' ? [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32', 'Wbem')].join(';') : '/usr/bin:/bin'

const sandbox = async ({ onTestFinished }: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-observer-test-')))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10 }))
  const home = join(root, 'Имя Фамилия')
  await mkdir(home)
  return {
    root,
    options: {
      temporaryDirectory: root,
      environment: { ...process.env, HOME: home, USERPROFILE: home, ANTHROPIC_API_KEY: 'discard', NODE_OPTIONS: '--invalid', CLAUDE_CODE_SESSION_ID: 'solver', CODEX_HOME: 'discard' },
      windowsLauncher: resolve('packages/hook/bin/aang-hook.exe'),
    },
  }
}

test('Claude launches with the isolated profile and returns structured output and usage', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root, { replies: [{ kind: 'answer', output }] })
  const backend = createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', effort: 'high', builtins })
  const result = await backend.execute({ input })
  expect(result).toMatchObject({ ok: true, output, usage: { model: 'claude-opus-5-5', cost_usd: 0.04196, tokens: { uncached_input_tokens: 2, output_tokens: 872, cache_read_input_tokens: 0, cache_write_input_tokens: 3064 } } })
  expect(backend.status()).toEqual({ state: { state: 'ok' }, activeCalls: 0 })
  const call = cli.calls().find((call) => call.command === 'print')
  expect(call).toMatchObject({ violations: [], cwd: join(root, 'aang-observer', 'empty'), systemPrompt: observerSystemPrompt })
  expect(JSON.parse(call?.prompt ?? '')).toEqual(input)
  expect(call?.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  expect(call?.env).not.toHaveProperty('NODE_OPTIONS')
  expect(call?.env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID')
  expect(call?.env).not.toHaveProperty('CODEX_HOME')
  expect(call?.argv).toContain('high')
})

test('Claude rejects leaked tools and blocks further calls until a new backend is admitted', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root, { leakedTools: ['Bash'], replies: [{ kind: 'answer', output }] })
  const backend = createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(backend.status().state).toEqual({ state: 'disabled', reason: 'isolation' })
  const count = cli.calls().length
  expect(await backend.execute({ input })).toMatchObject({ ok: false })
  expect(cli.calls()).toHaveLength(count)
})

for (const exitCode of [0, 1]) {
  test.for(['after-init', 'before-init', 'after-result'] as const)(`Claude checks isolation before rejecting malformed JSON on exit ${String(exitCode)}: %s`, async (stage, context) => {
    const { root, options } = await sandbox(context)
    const leaking = stage !== 'after-result'
    const fake = installFakeClaude(root, { leakedTools: leaking ? ['Bash'] : [], replies: [{ kind: 'answer', output }, { kind: 'answer', output }] })
    const cli = { command: process.execPath, args: [fileURLToPath(new URL('malformed-stream.ts', import.meta.url)), String(exitCode), stage, fake.command, ...fake.args] }
    const backend = createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', builtins })
    const error = leaking ? 'isolation' : 'invalid_output'
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: error } })
    expect(backend.status()).toEqual({ activeCalls: 0, state: leaking ? { state: 'disabled', reason: 'isolation' } : { state: 'ok' } })
    expect(fake.calls().filter((call) => call.command === 'print')).toHaveLength(1)
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: error } })
    expect(fake.calls().filter((call) => call.command === 'print')).toHaveLength(leaking ? 1 : 2)
  })
}

for (const ending of ['timeout', 'cancelled'] as const) {
  test.for(['before-init', 'after-init'] as const)(`Claude ${ending} checks complete init events without rejecting an incomplete init: %s`, async (stage, context) => {
    const { root, options } = await sandbox(context)
    const fake = installFakeClaude(root, { leakedTools: ['Bash'], replies: [{ kind: 'answer', output }] })
    const ready = join(root, 'stream-ready')
    const cli = { command: process.execPath, args: [fileURLToPath(new URL('interrupted-stream.ts', import.meta.url)), stage, ready, fake.command, ...fake.args] }
    const backend = createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', builtins, timeoutMs: ending === 'timeout' ? 3000 : 10_000 })
    const controller = new AbortController()
    const pending = backend.execute({ input, signal: controller.signal })
    try {
      await expect.poll(() => existsSync(ready), { timeout: 5000 }).toBe(true)
      if (ending === 'cancelled') controller.abort()
      expect(await pending).toMatchObject({ ok: false, error: { class: stage === 'after-init' ? 'isolation' : ending } })
      expect(backend.status()).toEqual({ activeCalls: 0, state: stage === 'after-init' ? { state: 'disabled', reason: 'isolation' } : { state: 'ok' } })
      if (stage === 'after-init') {
        const count = fake.calls().length
        expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
        expect(fake.calls()).toHaveLength(count)
      }
    } finally {
      controller.abort()
      await pending
    }
  })
}

test.for(['auth', 'limit', 'invalid_json'] as const)('Claude rejects %s even with subtype success', async (kind, context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root, { replies: [kind === 'invalid_json' ? { kind, text: 'not json' } : { kind }] })
  const backend = createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: kind === 'invalid_json' ? 'invalid_output' : kind } })
  expect(backend.status().activeCalls).toBe(0)
})

test('Codex derives a tool-free catalog for the selected model and returns usage', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
  const backend = createCodexLauncher({ ...options, cli, model: 'gpt-5.5', effort: 'xhigh' })
  expect(await backend.execute({ input })).toMatchObject({ ok: true, output, usage: { model: 'gpt-5.5', cost_usd: null, tokens: { uncached_input_tokens: 1531, output_tokens: 463 } } })
  const call = cli.calls().find((call) => call.command === 'exec')
  expect(call).toMatchObject({ violations: [], systemPrompt: observerSystemPrompt })
  expect(JSON.parse(call?.prompt ?? '')).toEqual(input)
  expect(call?.argv).toContain('model_reasoning_effort="xhigh"')
  expect(backend.status().activeCalls).toBe(0)
})

test('Codex rejects any unsupported tool attempt despite valid output', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeCodex(root, { replies: [{ kind: 'answer', output, toolAttempts: ['exec'] }] })
  const backend = createCodexLauncher({ ...options, cli, model: 'gpt-6.1-sol' })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(backend.status().state).toEqual({ state: 'disabled', reason: 'isolation' })
})

test('unsafe workdir ancestors prevent every CLI launch', async (context) => {
  const { root, options } = await sandbox(context)
  await writeFile(join(root, 'AGENTS.md'), 'untrusted instructions')
  const cli = installFakeClaude(root)
  const backend = createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false })
  expect(backend.status().state).toEqual({ state: 'disabled', reason: 'unsafe_workdir' })
  expect(cli.calls()).toEqual([])
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('untrusted instructions')
})


for (const runtime of ['claude', 'codex'] as const) {
  test(`${runtime} refuses an unauthenticated CLI before sending user data`, async (context) => {
    const { root, options } = await sandbox(context)
    const cli = runtime === 'claude' ? installFakeClaude(root, { loggedIn: false }) : installFakeCodex(root, { loggedIn: false })
    const backend = runtime === 'claude' ? createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', builtins }) : createCodexLauncher({ ...options, cli, model: 'gpt-6.1-sol' })
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'auth' } })
    expect(cli.calls().some((call) => call.prompt !== null)).toBe(false)
  })
  const modes = runtime === 'claude' ? ['mcp', 'skills', 'plugin', 'missing-init', 'error', 'schema', 'malformed', 'flood'] : ['failed', 'missing-completed', 'missing-last', 'schema', 'malformed', 'flood']
  test.for(modes)(`${runtime} rejects protocol violation %s`, async (mode, context) => {
    const { root, options } = await sandbox(context)
    const fake = runtime === 'claude' ? installFakeClaude(root, { replies: [{ kind: 'answer', output }] }) : installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
    const cli = { command: process.execPath, args: [fileURLToPath(new URL('protocol-wrapper.ts', import.meta.url)), mode, fake.command, ...fake.args] }
    const backend = runtime === 'claude' ? createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', builtins }) : createCodexLauncher({ ...options, cli, model: 'gpt-6.1-sol' })
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: ['mcp', 'skills', 'plugin', 'missing-init'].includes(mode) ? 'isolation' : 'invalid_output' } })
    expect(backend.status().activeCalls).toBe(0)
  })
}

test('Codex rebuilds the bundled model catalog after a CLI version change', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeCodex(root, { replies: [{ kind: 'answer', output }, { kind: 'answer', output }] })
  const backend = createCodexLauncher({ ...options, cli, model: 'gpt-6.1-sol' })
  expect(await backend.execute({ input })).toMatchObject({ ok: true })
  expect(await backend.execute({ input })).toMatchObject({ ok: true })
  expect(cli.calls().filter((call) => call.command === 'debug_models')).toHaveLength(1)
  cli.setScenario({ version: '0.160.0', replies: [{ kind: 'answer', output }] })
  expect(await backend.execute({ input })).toMatchObject({ ok: true })
  expect(cli.calls().filter((call) => call.command === 'debug_models')).toHaveLength(2)
})

test('Codex cannot launch a model absent from the isolated catalog', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeCodex(root)
  const backend = createCodexLauncher({ ...options, cli, model: 'not-in-catalog' })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(cli.calls().some((call) => call.command === 'exec')).toBe(false)
})

test('the observer refuses a populated working directory without deleting its files', async (context) => {
  const { root, options } = await sandbox(context)
  const cwd = join(root, 'aang-observer', 'empty')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'data'), 'keep')
  const cli = installFakeClaude(root)
  const backend = createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'unsafe_workdir' } })
  expect(cli.calls()).toEqual([])
  expect(await readFile(join(cwd, 'data'), 'utf8')).toBe('keep')
})

test('a missing CLI disables the backend without occupying a process slot', async (context) => {
  const { root, options } = await sandbox(context)
  const backend = createClaudeLauncher({ ...options, cli: join(root, 'missing'), model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'cli_missing' } })
  expect(backend.status()).toEqual({ state: { state: 'disabled', reason: 'cli_missing' }, activeCalls: 0 })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'cli_missing' } })
})

test.skipIf(process.platform !== 'win32')('a missing Windows launcher disables launch without retaining a slot', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root)
  const backend = createClaudeLauncher({ ...options, windowsLauncher: join(root, 'missing.exe'), cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'launcher_unavailable' } })
  expect(backend.status()).toEqual({ state: { state: 'disabled', reason: 'launcher_unavailable' }, activeCalls: 0 })
  expect(cli.calls()).toEqual([])
})

test.skipIf(process.platform !== 'win32').for(['absolute-cmd', 'absolute-posix', 'name'] as const)('Codex resolves npm shims to node and the package script without a shell: %s', async (selection, context) => {
  const { root, options } = await sandbox(context)
  const fake = installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
  const bin = join(root, 'npm bin')
  const scripts = join(bin, 'node_modules', '@openai', 'codex', 'bin')
  await mkdir(scripts, { recursive: true })
  await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 99\n')
  await writeFile(join(bin, 'codex.cmd'), 'exit /b 99')
  await writeFile(join(bin, 'codex.ps1'), 'exit 99')
  const [script, state] = fake.args
  await writeFile(join(scripts, 'codex.js'), `process.argv.splice(1, 1, ${JSON.stringify(script)}, ${JSON.stringify(state)}); await import(${JSON.stringify(pathToFileURL(script ?? '').href)});`)
  const cli = selection === 'name' ? 'codex' : join(bin, selection === 'absolute-cmd' ? 'codex.cmd' : 'codex')
  const environment = Object.fromEntries(Object.entries(options.environment).filter(([name]) => name.toLowerCase() !== 'path'))
  const backend = createCodexLauncher({ ...options, environment: { ...environment, Path: bin }, cli, model: 'gpt-6.1-sol' })
  expect(await backend.execute({ input })).toMatchObject({ ok: true, output })
  expect(fake.calls().find((call) => call.command === 'exec')?.violations).toEqual([])
})

test.skipIf(process.platform === 'win32').for(['absolute', 'name'] as const)('Codex runs an env node npm entrypoint with the isolated PATH: %s', async (selection, context) => {
  const { root, options } = await sandbox(context)
  const fake = installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
  const bin = join(root, 'npm bin')
  const script = join(root, 'codex entrypoint.mjs')
  await mkdir(bin)
  await writeFile(script, `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process'\nconst result = spawnSync(${JSON.stringify(fake.command)}, [...${JSON.stringify(fake.args)}, ...process.argv.slice(2)], { stdio: 'inherit' })\nprocess.exitCode = result.status ?? 1\n`, { mode: 0o755 })
  await symlink(script, join(bin, 'codex'))
  const backend = createCodexLauncher({ ...options, environment: { ...options.environment, PATH: bin }, cli: selection === 'name' ? 'codex' : script, model: 'gpt-6.1-sol' })
  expect(await backend.execute({ input })).toMatchObject({ ok: true, output })
  const call = fake.calls().find((call) => call.command === 'exec')
  expect(call?.violations).toEqual([])
  expect(call?.env.PATH).toBe('/usr/bin:/bin')
})


test('Codex disables isolation after an unsupported tool even when stdout is malformed', async (context) => {
  const { root, options } = await sandbox(context)
  const fake = installFakeCodex(root, { replies: [{ kind: 'answer', output, toolAttempts: ['exec'] }] })
  const cli = { command: process.execPath, args: [fileURLToPath(new URL('protocol-wrapper.ts', import.meta.url)), 'malformed', fake.command, ...fake.args] }
  const backend = createCodexLauncher({ ...options, cli, model: 'gpt-6.1-sol' })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(backend.status().state).toEqual({ state: 'disabled', reason: 'isolation' })
})


test('instructions in the physical ancestor of a symlinked workdir prevent launch', async (context) => {
  const { root, options } = await sandbox(context)
  const physical = join(root, 'physical')
  const alias = join(root, 'alias')
  await mkdir(physical)
  await writeFile(join(physical, 'CLAUDE.md'), 'untrusted')
  await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const cli = installFakeClaude(root)
  const backend = createClaudeLauncher({ ...options, temporaryDirectory: alias, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'unsafe_workdir' } })
  expect(cli.calls()).toEqual([])
})

test('CLI name is resolved before the inherited PATH is cleared', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root, { replies: [{ kind: 'answer', output }] })
  const inherited = Object.fromEntries(Object.entries(options.environment).filter(([name]) => name.toLowerCase() !== 'path'))
  const backend = createClaudeLauncher({ ...options, environment: { ...inherited, PATH: dirname(cli.path) }, cli: 'claude', model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: true })
  const env = Object.entries(cli.calls().find((call) => call.command === 'print')?.env ?? {})
  expect(env.find(([name]) => name.toLowerCase() === 'path')?.[1]).toBe(isolatedPath)
})

test('an already cancelled call does not spawn a CLI', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root)
  const backend = createClaudeLauncher({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input, signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { class: 'cancelled' } })
  expect(cli.calls()).toEqual([])
  expect(backend.status().activeCalls).toBe(0)
})
