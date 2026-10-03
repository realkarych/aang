import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createPlayer, createProfile, loadManifest } from '@aang/testkit'
import { afterEach, expect, test } from 'vitest'
import { recordScenario, recordSession, verifyRecording, type Scenario, type SurfaceDriver } from '../dist/index.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url))
const script = fileURLToPath(new URL('./scenario-runtime.ts', import.meta.url))
const binary = resolve('packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook')
const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
const temporary: string[] = []

const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), 'aang-scenario-test-'))
  temporary.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const options = async () => ({
  runtime: 'codex' as const,
  engineVersion: '0.0.1',
  surface: 'codex_exec' as const,
  scenario: 'otlp',
  expectedFacts: ['An approval decision arrives through OTel'],
  fixturesRoot: join(await directory(), 'sessions'),
  hookBinary: binary,
})

test('captures OTLP logs as anonymized playback steps and returns command output with extra environment', async () => {
  const config = await options()
  let output = ''
  const recording = await recordSession({ ...config, model: 'stub' }, async (session) => {
    expect(session.otlp).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/)
    expect(session.os).toBe(os)
    expect(session.hook).toBe(binary)
    output = (await session.run(process.execPath, [script, 'otlp', session.otlp], { env: { AANG_SCENARIO_MARK: 'marked' } })).stdout
  })
  expect(output).toBe('posted marked')
  const manifest = JSON.parse(await readFile(join(recording, 'manifest.json'), 'utf8')) as { model: string }
  expect(manifest.model).toBe('stub')
  const playback = await loadManifest(join(recording, 'playback.json'))
  const steps = playback.steps.filter((step) => step.kind === 'otlp')
  expect(steps).toHaveLength(1)
  const body = playback.sources.get(steps[0] && 'source' in steps[0] ? steps[0].source : '')?.toString() ?? ''
  expect(body).toContain('codex.tool_decision')
  expect(body).not.toMatch(/someone\.personal|acct-private/)
  const received: string[] = []
  const receiver = createServer((request, response) => {
    let text = ''
    request.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
    request.on('end', () => {
      received.push(text)
      response.end('{}')
    })
  })
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  const profile = await createProfile()
  try {
    const { port } = receiver.address() as AddressInfo
    await createPlayer(playback, { roots: profile, timeScale: 0, otlp: `http://127.0.0.1:${String(port)}/v1/logs` }).play()
    expect(received).toEqual([body])
  } finally {
    await profile.dispose()
    receiver.close()
  }
})

test.each(['protobuf', 'invalid'])('an OTLP %s body aborts publication', async (mode) => {
  const config = await options()
  await expect(recordSession(config, async (session) => {
    await session.run(process.execPath, [script, mode, session.otlp])
  })).rejects.toThrow(/OTLP|JSON/)
  await expect(readFile(join(config.fixturesRoot, 'codex', '0.0.1', 'codex_exec', os, 'otlp', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('the regular Codex home is passed to the runtime and keeps only new rollouts of the temporary project and the real home', async () => {
  const config = await options()
  const codexHome = join(await directory(), 'codex-home')
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  await writeFile(join(codexHome, 'sessions', 'existing.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/someone-else/old' } })}\n`)
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ token: 'never-copy-authorization' }))
  const previous = process.env['CODEX_HOME']
  process.env['CODEX_HOME'] = codexHome
  let environment: { home?: string; codexHome?: string } = {}
  try {
    const recording = await recordSession({ ...config, model: 'live', codexHome: 'regular' }, async (session) => {
      expect(session.codex).toBe(codexHome)
      environment = JSON.parse((await session.run(process.execPath, [script, 'regular', 'thread-own-1'])).stdout) as typeof environment
    })
    expect(environment).toEqual({ home: homedir(), codexHome })
    const playback = await loadManifest(join(recording, 'playback.json'))
    const targets = playback.steps.flatMap((step) => 'target' in step ? [step.target.path] : [])
    expect(targets).toEqual(['sessions/2026/10/03/rollout-own.jsonl'])
    const text = [...playback.sources.values()].join('\n')
    expect(text).toContain('thread-own-1')
    expect(text).toContain('task_started')
    expect(text).not.toMatch(/thread-foreign|someone-else|never-copy-authorization|later/)
    expect(text).not.toContain(homedir())
    await verifyRecording(recording)
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME']
    else process.env['CODEX_HOME'] = previous
  }
})

test('checkpoints select the first or a content-matching event, tasks are captured, failures show the stderr tail', async () => {
  const config = { ...await options(), runtime: 'claude' as const, surface: 'claude_cli' as const, scenario: 'select' }
  const recording = await recordSession(config, async (session) => {
    await session.run(process.execPath, [script, 'append', 'alpha'])
    await session.run(process.execPath, [script, 'append', 'beta'])
    await session.run(process.execPath, [script, 'append', 'gamma'])
    await session.run(process.execPath, [script, 'tasks', 'session-public-1'])
    await session.checkpoint('first', { root: 'home', path: 'project/events.jsonl', occurrence: 'first' }, 'The first event is visible')
    await session.checkpoint('beta', { root: 'home', path: 'project/events.jsonl', contains: 'beta' }, 'The second event is visible')
    await session.checkpoint('task', { root: 'claude', path: 'tasks/session-public-1/1.json' }, 'The task list shows one task in progress')
    await expect(session.checkpoint('missing', { root: 'home', path: 'project/events.jsonl', contains: 'delta' }, 'Never happens')).rejects.toThrow(/Checkpoint/)
  })
  const playback = await loadManifest(join(recording, 'playback.json'))
  const labelled = (label: string): string => {
    const step = playback.steps.find((item) => item.label === label)
    return playback.sources.get(step && 'source' in step ? step.source : '')?.toString() ?? ''
  }
  expect(labelled('first')).toContain('alpha')
  expect(labelled('beta')).toContain('beta')
  expect(JSON.parse(labelled('task'))).toMatchObject({ status: 'in_progress' })
  await expect(recordSession({ ...config, scenario: 'failing' }, async (session) => {
    await session.run(process.execPath, [script, 'fail', 'quota exhausted'])
  })).rejects.toThrow(/Recording command failed: 3\n[\s\S]*the engine reported quota exhausted$/)
})

const driver: SurfaceDriver = {
  surface: 'codex_exec',
  runtime: 'codex',
  resolve: () => Promise.resolve({ executable: process.execPath, version: '9.8.7', appVersion: 'app 1' }),
}

const scenario = (override: Partial<Scenario> = {}): Scenario => ({
  name: 'synthetic',
  surface: 'codex_exec',
  models: ['stub'],
  expectedFacts: ['An OTel decision is recorded'],
  run: async (session) => {
    expect(session.engine.version).toBe('9.8.7')
    expect(session.model).toBe('stub')
    await session.run(process.execPath, [script, 'otlp', session.otlp])
  },
  ...override,
})

test('a catalog scenario records under the resolved engine version with its model and app version', async () => {
  const fixturesRoot = join(await directory(), 'sessions')
  const recording = await recordScenario(scenario(), driver, { fixturesRoot, hookBinary: binary, selection: {} })
  expect(recording).toBe(join(fixturesRoot, 'codex', '9.8.7', 'codex_exec', os, 'synthetic'))
  expect(JSON.parse(await readFile(join(recording, 'manifest.json'), 'utf8'))).toMatchObject({ model: 'stub', app_version: 'app 1', engine_version: '9.8.7' })
  await expect(recordScenario(scenario(), driver, { fixturesRoot, hookBinary: binary, model: 'live', selection: {} })).rejects.toThrow(/supports only stub/)
  await expect(recordScenario(scenario({ name: 'elsewhere', os: [os === 'linux' ? 'windows' : 'linux'] }), driver, { fixturesRoot, hookBinary: binary, selection: {} })).rejects.toThrow(/not recorded on/)
  await expect(recordScenario(scenario({ surface: 'claude_cli' }), driver, { fixturesRoot, hookBinary: binary, selection: {} })).rejects.toThrow(/does not belong/)
})

test('the scenario CLI lists the catalog and rejects unknown surfaces and scenarios', async () => {
  const listed = await exec(process.execPath, [cli, 'scenarios'])
  expect(listed.stderr).toBe('')
  await expect(exec(process.execPath, [cli, 'scenario', 'unknown_surface'])).rejects.toMatchObject({ code: 1 })
  await expect(exec(process.execPath, [cli, 'scenario', 'codex_exec', 'no-such-scenario'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown codex_exec scenarios') as unknown })
  await expect(exec(process.execPath, [cli, 'scenario', 'codex_exec', '--model', 'other'])).rejects.toMatchObject({ code: 1 })
  await expect(exec(process.execPath, [cli, 'scenario', 'codex_tui', '--model', 'live'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('No codex_tui scenarios for this model and OS') as unknown })
  const fixtures = join(await directory(), 'sessions')
  await expect(exec(process.execPath, [cli, 'scenario', 'claude_cli', 'tools', '--claude', join(fixtures, 'missing-claude'), '--fixtures', fixtures])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('is not an executable file') as unknown })
})
