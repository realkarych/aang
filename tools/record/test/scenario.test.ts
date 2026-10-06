import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createPlayer, createProfile, loadManifest } from '@aang/testkit'
import { afterEach, expect, test, vi } from 'vitest'
import { recordScenario, recordSession, verifyRecording, type CreatedEntries, type Scenario, type SurfaceDriver } from '../dist/index.js'

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
  vi.unstubAllEnvs()
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

test.each(['lf', 'crlf'] as const)('approved command prefixes of the regular Codex home with %s line ends become placeholders of the same shape that verification requires', async (lines) => {
  const config = await options()
  const codexHome = join(await directory(), 'codex-home')
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  const previous = process.env['CODEX_HOME']
  process.env['CODEX_HOME'] = codexHome
  try {
    const recording = await recordSession({ ...config, model: 'live', codexHome: 'regular' }, async (session) => {
      await session.run(process.execPath, [script, 'rules', 'thread-rules-1', lines])
    })
    const entries = await readdir(recording, { recursive: true, withFileTypes: true })
    const published = await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')))
    expect(published.join('\n')).not.toMatch(/owner-tools|private-project|private commit text/)
    const playback = await loadManifest(join(recording, 'playback.json'))
    const sources = playback.steps.flatMap((step) => 'target' in step && step.target.path === 'sessions/2026/10/04/rollout-rules.jsonl' && 'source' in step ? [step.source] : [])
    const records = sources.map((source) => playback.sources.get(source)?.toString() ?? '').join('').trim().split('\n').map((line) => JSON.parse(line) as {
      payload: { content?: { text: string }[]; state?: { permissions: { approved_command_prefixes: string[][] } }; proposed_execpolicy_amendment?: string[] }
    })
    const instructions = [
      '<permissions instructions>',
      '## Approved command prefixes',
      'The following prefix rules have already been approved: - ["COMMAND_1", "ARG_1", "ARG_2", "ARG_3"]',
      '- ["COMMAND_2", "ARG_1"]',
      '',
      'Approval policy is `on-request`.',
      '</permissions instructions>',
    ].join(lines === 'crlf' ? '\r\n' : '\n')
    expect(records[1]?.payload.content?.[0]?.text).toBe(instructions)
    expect(records[2]?.payload.state?.permissions.approved_command_prefixes).toEqual([['COMMAND_2', 'ARG_1'], ['COMMAND_3', 'ARG_1', 'ARG_2'], ['COMMAND_1', 'ARG_1', 'ARG_2', 'ARG_3']])
    expect(records[3]?.payload.proposed_execpolicy_amendment).toEqual(['touch', 'approved.txt'])
    const manifest = JSON.parse(await readFile(join(recording, 'manifest.json'), 'utf8')) as { artifacts: { source: string }[] }
    const outputs = manifest.artifacts.filter(({ source }) => source.startsWith('output/')).map(({ source }) => join(recording, source))
    expect(outputs).toHaveLength(1)
    const [output = ''] = outputs
    expect(await readFile(output, 'utf8')).toBe(instructions)
    await verifyRecording(recording)
    const rollout = join(recording, sources.at(-1) ?? '')
    const substitutions = [
      [rollout, '"COMMAND_3","ARG_1","ARG_2"', '"git","push","origin"'],
      [rollout, String.raw`[\"COMMAND_2\", \"ARG_1\"]`, String.raw`[\"git\", \"push\"]`],
      [output, '["COMMAND_2", "ARG_1"]', '["git", "push"]'],
    ] as const
    for (const [file, placeholders, command] of substitutions) {
      const anonymous = await readFile(file, 'utf8')
      expect(anonymous).toContain(placeholders)
      await writeFile(file, anonymous.replace(placeholders, command))
      await expect(verifyRecording(recording)).rejects.toThrow(/anonymization is required/)
      await writeFile(file, anonymous)
    }
  } finally {
    if (previous === undefined) delete process.env['CODEX_HOME']
    else process.env['CODEX_HOME'] = previous
  }
})

test('the regular Claude home is the real home without CLAUDE_CONFIG_DIR, keeps only files of the temporary project and reports them', async () => {
  const config = { ...await options(), runtime: 'claude' as const, surface: 'claude_cli' as const, scenario: 'regular-claude', model: 'live' as const }
  const home = await directory()
  const claude = join(home, '.claude')
  const session = '5b8f3c2e-1d4a-4c6b-9e7f-0a1b2c3d4e5f'
  await mkdir(join(claude, 'projects', '-Users-someone-else-old'), { recursive: true })
  await writeFile(join(claude, 'projects', '-Users-someone-else-old', '9d0c51f4-6d0e-4b5e-8f3a-2f6f0f4a7c11.jsonl'), `${JSON.stringify({ type: 'user', cwd: '/Users/someone-else/old' })}\n`)
  await mkdir(join(claude, 'sessions'), { recursive: true })
  await writeFile(join(claude, 'sessions', '1.json'), JSON.stringify({ pid: 1, sessionId: 'existing', cwd: '/Users/someone-else/old' }))
  await mkdir(join(claude, 'plugins', 'data', 'aang-probe-inline'), { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
  await expect(recordSession({ ...config, model: 'stub', claudeHome: 'regular' }, async () => {})).rejects.toThrow(/only for live Claude/)
  const created: CreatedEntries[] = []
  let environment: { home?: string; claudeConfigDir?: string | null; pid?: number; args?: string[] } = {}
  let plugin = ''
  const recording = await recordSession({ ...config, claudeHome: 'regular', created: (entries) => created.push(entries) }, async (context) => {
    expect(context.claude).toBe(claude)
    expect(context.claudeHome).toBe('regular')
    plugin = context.plugin
    environment = JSON.parse((await context.run(process.execPath, [script, 'regular-claude', session])).stdout) as typeof environment
  })
  expect(environment).toMatchObject({ home, claudeConfigDir: null, args: ['--plugin-dir', plugin, '--setting-sources', 'project,local', '--strict-mcp-config'] })
  const playback = await loadManifest(join(recording, 'playback.json'))
  const targets = playback.steps.flatMap((step) => 'target' in step && step.target.root === 'claude' ? [step.target.path] : [])
  expect(targets.toSorted()).toEqual([
    `projects/-fixture-project/${session}.jsonl`,
    `projects/-fixture-project/${session}/subagents/agent-a1.jsonl`,
    `sessions/${String(environment.pid)}.json`,
    `tasks/${session}/1.json`,
  ])
  const text = [...playback.sources.values()].join('\n')
  expect(text).toMatch(/USER[\\/]+\.claude[\\/]+settings\.json/)
  expect(text).not.toMatch(/someone-else|Foreign task|team-new|later/)
  expect(text).not.toContain(home)
  await verifyRecording(recording)
  const project = (await readdir(join(claude, 'projects'))).find((name) => name.endsWith('-home-project'))
  expect(created).toEqual([{
    sessions: [session],
    paths: [
      join(claude, 'plugins', 'data', 'aang-inline'),
      join(claude, 'projects', String(project)),
      join(claude, 'session-env', session),
      join(claude, 'sessions', `${String(environment.pid)}.json`),
      join(claude, 'tasks', session),
    ].toSorted(),
    unreadable: [],
  }])
})

test('a throwing created callback aborts publication or leaves the recording error in place, and cleanup still runs', async () => {
  const config = { ...await options(), runtime: 'claude' as const, surface: 'claude_cli' as const, model: 'live' as const, claudeHome: 'regular' as const }
  const home = await directory()
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
  const created = (): void => {
    throw new Error('Report failed')
  }
  const sessions: { project: string; otlp: string }[] = []
  await expect(recordSession({ ...config, scenario: 'reported', created }, async (session) => {
    sessions.push({ project: session.project, otlp: session.otlp })
    await session.run(process.execPath, [script, 'otlp', session.otlp])
  })).rejects.toThrow('Report failed')
  await expect(recordSession({ ...config, scenario: 'failed', created }, async (session) => {
    sessions.push({ project: session.project, otlp: session.otlp })
    await session.run(process.execPath, [script, 'otlp', session.otlp])
    throw new Error('Scenario failed')
  })).rejects.toThrow('Scenario failed')
  expect(sessions).toHaveLength(2)
  for (const { project, otlp } of sessions) {
    await expect(stat(project)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fetch(otlp, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).rejects.toThrow()
  }
  await expect(stat(join(config.fixturesRoot, 'claude', '0.0.1', 'claude_cli', os, 'reported'))).rejects.toMatchObject({ code: 'ENOENT' })
})

const streamHost = fileURLToPath(new URL('../dist/claude/stream-host.js', import.meta.url))
const sdkHost = fileURLToPath(new URL('../dist/claude/sdk-host.js', import.meta.url))
const messages = (session: string): string => [
  { type: 'system', subtype: 'init', session_id: session, tools: [] },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: session },
].map((message) => JSON.stringify(message)).join(',')

const fakeEngine = async (work: string, kind: 'stream' | 'sdk'): Promise<string> => {
  if (kind === 'sdk') {
    const module = join(work, 'sdk.mjs')
    await writeFile(module, [
      "import { writeFileSync } from 'node:fs'",
      'export const query = ({ prompt, options }) => {',
      '  writeFileSync(options.env.AANG_TEST_OUT, JSON.stringify({ settingSources: options.settingSources ?? null, strictMcpConfig: options.strictMcpConfig ?? null }))',
      `  const stream = (async function* () { for await (const _ of prompt) yield* [${messages('sdk-session')}] })()`,
      '  return Object.assign(stream, { interrupt: async () => undefined })',
      '}',
      '',
    ].join('\n'))
    return module
  }
  const engine = join(work, 'claude')
  await writeFile(engine, [
    `#!${process.execPath}`,
    "import { writeFileSync } from 'node:fs'",
    "import { createInterface } from 'node:readline'",
    'writeFileSync(process.env.AANG_TEST_OUT, JSON.stringify(process.argv.slice(2)))',
    `createInterface({ input: process.stdin }).on('line', () => { for (const message of [${messages('stream-session')}]) process.stdout.write(JSON.stringify(message) + '\\n') })`,
    '',
  ].join('\n'))
  await chmod(engine, 0o755)
  return engine
}

test.for([
  { kind: 'stream' as const, host: streamHost },
  { kind: 'sdk' as const, host: sdkHost },
])('the $kind host gives the engine the setting sources and strict MCP configuration the recorder appends', async ({ kind, host }, context) => {
  if (kind === 'stream' && process.platform === 'win32') {
    context.skip()
    return
  }
  const work = await directory()
  const engine = await fakeEngine(work, kind)
  const run = async (name: string, recorder: readonly string[]): Promise<unknown> => {
    const out = join(work, `${name}.out.json`)
    const plan = join(work, `${name}.plan.json`)
    await writeFile(plan, JSON.stringify({ engine, args: ['--setting-sources', 'user,project,local'], env: { AANG_TEST_OUT: out }, turns: [{ prompt: 'hello' }] }))
    await exec(process.execPath, [host, plan, join(work, `${name}.summary.json`), '--plugin-dir', work, ...recorder], { cwd: work })
    return JSON.parse(await readFile(out, 'utf8'))
  }
  const regular = await run('regular', ['--setting-sources', 'project,local', '--strict-mcp-config'])
  const isolated = await run('isolated', [])
  if (kind === 'sdk') {
    expect(regular).toEqual({ settingSources: ['project', 'local'], strictMcpConfig: true })
    expect(isolated).toEqual({ settingSources: null, strictMcpConfig: null })
    return
  }
  const lastSources = (args: unknown): unknown => (args as string[]).slice((args as string[]).lastIndexOf('--setting-sources'))
  expect(lastSources(regular)).toEqual(['--setting-sources', 'project,local', '--strict-mcp-config'])
  expect(lastSources(isolated)).toEqual(['--setting-sources', 'user,project,local', '--permission-mode', 'default', '--plugin-dir', work])
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

test('checkpoints inside one appended chunk split it after their lines and playback restores the whole file', async () => {
  const words = ['asked', 'done', 'hello', 'done']
  const events = { root: 'home' as const, path: 'project/events.jsonl' }
  const recording = await recordSession({ ...await options(), scenario: 'chunk' }, async (session) => {
    await session.run(process.execPath, [script, 'append', words.join(',')])
    await session.checkpoint('question-asked', { ...events, contains: '"asked"' }, 'The question is visible')
    await session.checkpoint('final-answer', { ...events, contains: '"done"', occurrence: 'first' }, 'The first turn ends with its final answer')
    await session.checkpoint('question-reply', { ...events, contains: '"done"' }, 'The reply turn ends')
  })
  const playback = await loadManifest(join(recording, 'playback.json'))
  const chunks = playback.steps.flatMap((step) => step.kind === 'append'
    ? [[step.label, (playback.sources.get(step.source)?.toString() ?? '').trim().split('\n').map((line) => (JSON.parse(line) as { word: string }).word)]]
    : [])
  expect(chunks).toEqual([['question-asked', ['asked']], ['final-answer', ['done']], ['question-reply', ['hello', 'done']]])
  const manifest = JSON.parse(await readFile(join(recording, 'manifest.json'), 'utf8')) as { control_events: { label: string; step: number }[] }
  expect(manifest.control_events.map(({ label, step }) => [label, playback.steps[step]?.label])).toEqual([
    ['question-asked', 'question-asked'], ['final-answer', 'final-answer'], ['question-reply', 'question-reply'],
  ])
  const profile = await createProfile()
  try {
    await createPlayer(playback, { roots: profile, timeScale: 0 }).play()
    expect(await readFile(join(profile.home, 'project/events.jsonl'), 'utf8')).toBe(words.map((word) => `${JSON.stringify({ type: 'event', word })}\n`).join(''))
  } finally {
    await profile.dispose()
  }
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
  const paired = scenario({ name: 'paired', models: ['stub', 'live'], run: async (session) => { await session.run(process.execPath, [script, 'otlp', session.otlp]) } })
  const live = await recordScenario(paired, driver, { fixturesRoot, hookBinary: binary, model: 'live', selection: {} })
  expect(live).toBe(join(fixturesRoot, 'codex', '9.8.7', 'codex_exec', os, 'paired-live'))
  expect(JSON.parse(await readFile(join(live, 'manifest.json'), 'utf8'))).toMatchObject({ scenario: 'paired-live', model: 'live' })
  expect(await recordScenario(paired, driver, { fixturesRoot, hookBinary: binary, selection: {} })).toBe(join(fixturesRoot, 'codex', '9.8.7', 'codex_exec', os, 'paired'))
  await expect(recordScenario(scenario({ name: 'elsewhere', os: [os === 'linux' ? 'windows' : 'linux'] }), driver, { fixturesRoot, hookBinary: binary, selection: {} })).rejects.toThrow(/not recorded on/)
  await expect(recordScenario(scenario({ surface: 'claude_cli' }), driver, { fixturesRoot, hookBinary: binary, selection: {} })).rejects.toThrow(/does not belong/)
})

test('the scenario CLI lists the catalog and rejects unknown surfaces and scenarios', async () => {
  const listed = await exec(process.execPath, [cli, 'scenarios'])
  expect(listed.stderr).toBe('')
  const interactive = os === 'windows' ? ' (not on windows)' : ''
  for (const surface of ['claude_cli', 'claude_sdk', 'claude_desktop']) {
    for (const name of ['elicitation', 'workflow', 'plugin', 'user-hooks']) {
      expect(listed.stdout).toMatch(new RegExp(`^${surface} ${name} \\[stub\\]`, 'm'))
    }
  }
  expect(listed.stdout).toMatch(/^claude_cli agents-flag \[stub\]$/m)
  expect(listed.stdout).toMatch(/^claude_sdk agents-flag \[stub\]$/m)
  expect(listed.stdout).not.toMatch(/^claude_desktop agents-flag /m)
  expect(listed.stdout).toMatch(/^codex_exec agent-role \[stub\]$/m)
  expect(listed.stdout).toMatch(/^codex_desktop question \[stub\]/m)
  expect(listed.stdout).toContain(`claude_cli teammates [stub]${interactive}\nclaude_cli input-dialogs [stub]${interactive}\n`)
  expect(listed.stdout).not.toMatch(/^claude_(?:sdk|desktop) (?:teammates|input-dialogs) /m)
  await expect(exec(process.execPath, [cli, 'scenario', 'unknown_surface'])).rejects.toMatchObject({ code: 1 })
  await expect(exec(process.execPath, [cli, 'scenario', 'codex_exec', 'no-such-scenario'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unknown codex_exec scenarios') as unknown })
  await expect(exec(process.execPath, [cli, 'scenario', 'codex_exec', '--model', 'other'])).rejects.toMatchObject({ code: 1 })
  await expect(exec(process.execPath, [cli, 'scenario', 'claude_cli', '--model', 'live', '--claude-home', 'shared'])).rejects.toMatchObject({ code: 1 })
  await expect(exec(process.execPath, [cli, 'scenario', 'codex_tui', '--model', 'live'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('No codex_tui scenarios for this model and OS') as unknown })
  const fixtures = join(await directory(), 'sessions')
  await expect(exec(process.execPath, [cli, 'scenario', 'claude_cli', 'tools', '--claude', join(fixtures, 'missing-claude'), '--fixtures', fixtures])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('is not an executable file') as unknown })
})
