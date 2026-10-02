import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, expect, type TestContext } from 'vitest'
import * as observer from '@aang/observer'
import { installFakeClaude, installFakeCodex } from '@aang/testkit'

const output = { base_version: 7, ops: [], needs: [] }
const input = { model: { version: 7 }, batch: { facts: [] } }
const builtins = { mcpServers: [], skills: [], plugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'] }

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
  const backend = observer.createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', effort: 'high', builtins })
  const result = await backend.execute({ input })
  expect(result).toMatchObject({ ok: true, output, usage: { model: 'claude-opus-5-5', cost_usd: 0.04196, tokens: { uncached_input_tokens: 2, output_tokens: 872, cache_read_input_tokens: 0, cache_write_input_tokens: 3064 } } })
  expect(backend.status()).toEqual({ state: { state: 'ok' }, activeCalls: 0 })
  const call = cli.calls().find((call) => call.command === 'print')
  expect(call).toMatchObject({ violations: [], cwd: join(root, 'aang-observer', 'empty') })
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
  const backend = observer.createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(backend.status().state).toEqual({ state: 'disabled', reason: 'isolation' })
  const count = cli.calls().length
  expect(await backend.execute({ input })).toMatchObject({ ok: false })
  expect(cli.calls()).toHaveLength(count)
})

test.for(['auth', 'limit', 'invalid_json'] as const)('Claude rejects %s even with subtype success', async (kind, context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root, { replies: [kind === 'invalid_json' ? { kind, text: 'not json' } : { kind }] })
  const backend = observer.createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: kind === 'invalid_json' ? 'invalid_output' : kind } })
  expect(backend.status().activeCalls).toBe(0)
})

test('Codex derives a tool-free catalog for the selected model and returns usage', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
  const backend = observer.createCodexBackend({ ...options, cli, model: 'gpt-5.5', effort: 'xhigh' })
  expect(await backend.execute({ input })).toMatchObject({ ok: true, output, usage: { model: 'gpt-5.5', cost_usd: null, tokens: { uncached_input_tokens: 1531, output_tokens: 463 } } })
  const call = cli.calls().find((call) => call.command === 'exec')
  expect(call).toMatchObject({ violations: [] })
  expect(call?.argv).toContain('model_reasoning_effort="xhigh"')
  expect(backend.status().activeCalls).toBe(0)
})

test('Codex rejects any unsupported tool attempt despite valid output', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeCodex(root, { replies: [{ kind: 'answer', output, toolAttempts: ['exec'] }] })
  const backend = observer.createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(backend.status().state).toEqual({ state: 'disabled', reason: 'isolation' })
})

test('unsafe workdir ancestors prevent every CLI launch', async (context) => {
  const { root, options } = await sandbox(context)
  await writeFile(join(root, 'AGENTS.md'), 'untrusted instructions')
  const cli = installFakeClaude(root)
  const backend = observer.createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false })
  expect(backend.status().state).toEqual({ state: 'disabled', reason: 'unsafe_workdir' })
  expect(cli.calls()).toEqual([])
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('untrusted instructions')
})


for (const runtime of ['claude', 'codex'] as const) {
  test(`${runtime} refuses an unauthenticated CLI before sending user data`, async (context) => {
    const { root, options } = await sandbox(context)
    const cli = runtime === 'claude' ? installFakeClaude(root, { loggedIn: false }) : installFakeCodex(root, { loggedIn: false })
    const backend = runtime === 'claude' ? observer.createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins }) : observer.createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'auth' } })
    expect(cli.calls().some((call) => call.prompt !== null)).toBe(false)
  })
  const modes = runtime === 'claude' ? ['mcp', 'skills', 'plugin', 'missing-init', 'error', 'schema', 'malformed', 'flood'] : ['failed', 'missing-completed', 'missing-last', 'schema', 'malformed', 'flood']
  test.for(modes)(`${runtime} rejects protocol violation %s`, async (mode, context) => {
    const { root, options } = await sandbox(context)
    const fake = runtime === 'claude' ? installFakeClaude(root, { replies: [{ kind: 'answer', output }] }) : installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
    const cli = { command: process.execPath, args: [fileURLToPath(new URL('protocol-wrapper.ts', import.meta.url)), mode, fake.command, ...fake.args] }
    const backend = runtime === 'claude' ? observer.createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins }) : observer.createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
    expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: ['mcp', 'skills', 'plugin', 'missing-init'].includes(mode) ? 'isolation' : 'invalid_output' } })
    expect(backend.status().activeCalls).toBe(0)
  })
}

test('Codex rebuilds the bundled model catalog after a CLI version change', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeCodex(root, { replies: [{ kind: 'answer', output }, { kind: 'answer', output }] })
  const backend = observer.createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
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
  const backend = observer.createCodexBackend({ ...options, cli, model: 'not-in-catalog' })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'isolation' } })
  expect(cli.calls().some((call) => call.command === 'exec')).toBe(false)
})

test('the observer refuses a populated working directory without deleting its files', async (context) => {
  const { root, options } = await sandbox(context)
  const cwd = join(root, 'aang-observer', 'empty')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'data'), 'keep')
  const cli = installFakeClaude(root)
  const backend = observer.createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'unsafe_workdir' } })
  expect(cli.calls()).toEqual([])
  expect(await readFile(join(cwd, 'data'), 'utf8')).toBe('keep')
})

test('a missing CLI disables the backend without occupying a process slot', async (context) => {
  const { root, options } = await sandbox(context)
  const backend = observer.createClaudeBackend({ ...options, cli: join(root, 'missing'), model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'cli_missing' } })
  expect(backend.status()).toEqual({ state: { state: 'disabled', reason: 'cli_missing' }, activeCalls: 0 })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'cli_missing' } })
})

test.skipIf(process.platform !== 'win32')('a missing Windows launcher disables launch without retaining a slot', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root)
  const backend = observer.createClaudeBackend({ ...options, windowsLauncher: join(root, 'missing.exe'), cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'launcher_unavailable' } })
  expect(backend.status()).toEqual({ state: { state: 'disabled', reason: 'launcher_unavailable' }, activeCalls: 0 })
  expect(cli.calls()).toEqual([])
})

test.skipIf(process.platform !== 'win32')('Codex resolves its npm cmd shim to node and the package script without a shell', async (context) => {
  const { root, options } = await sandbox(context)
  const fake = installFakeCodex(root, { replies: [{ kind: 'answer', output }] })
  const bin = join(root, 'npm bin')
  const scripts = join(bin, 'node_modules', '@openai', 'codex', 'bin')
  await mkdir(scripts, { recursive: true })
  await writeFile(join(bin, 'codex.cmd'), 'exit /b 99')
  const [script, state] = fake.args
  await writeFile(join(scripts, 'codex.js'), `process.argv.splice(1, 1, ${JSON.stringify(script)}, ${JSON.stringify(state)}); await import(${JSON.stringify(pathToFileURL(script ?? '').href)});`)
  const backend = observer.createCodexBackend({ ...options, cli: join(bin, 'codex.cmd'), model: 'gpt-6.1-sol' })
  expect(await backend.execute({ input })).toMatchObject({ ok: true })
  expect(fake.calls().find((call) => call.command === 'exec')?.violations).toEqual([])
})


test('Codex disables isolation after an unsupported tool even when stdout is malformed', async (context) => {
  const { root, options } = await sandbox(context)
  const fake = installFakeCodex(root, { replies: [{ kind: 'answer', output, toolAttempts: ['exec'] }] })
  const cli = { command: process.execPath, args: [fileURLToPath(new URL('protocol-wrapper.ts', import.meta.url)), 'malformed', fake.command, ...fake.args] }
  const backend = observer.createCodexBackend({ ...options, cli, model: 'gpt-6.1-sol' })
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
  const backend = observer.createClaudeBackend({ ...options, temporaryDirectory: alias, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: false, error: { class: 'unsafe_workdir' } })
  expect(cli.calls()).toEqual([])
})

test.skipIf(process.platform === 'win32')('CLI name is resolved before the inherited PATH is cleared', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root, { replies: [{ kind: 'answer', output }] })
  const backend = observer.createClaudeBackend({ ...options, environment: { ...options.environment, PATH: join(root, 'claude', 'bin') }, cli: 'claude', model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input })).toMatchObject({ ok: true })
  expect(cli.calls().find((call) => call.command === 'print')?.env.PATH).toBe('/usr/bin:/bin')
})

test('an already cancelled call does not spawn a CLI', async (context) => {
  const { root, options } = await sandbox(context)
  const cli = installFakeClaude(root)
  const backend = observer.createClaudeBackend({ ...options, cli, model: 'claude-opus-5-5', builtins })
  expect(await backend.execute({ input, signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { class: 'cancelled' } })
  expect(cli.calls()).toEqual([])
  expect(backend.status().activeCalls).toBe(0)
})
