import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test, vi } from 'vitest'
import { startModelStub } from '../dist/claude/stub.js'
import { drivers, EngineUnavailableError, recordSession, verifyRecording } from '../dist/index.js'

const exec = promisify(execFile)
const binary = resolve('packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook')
const required = new Set((process.env['AANG_RECORD_REQUIRE'] ?? '').split(',').filter(Boolean))
const excluded = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'AANG_OBSERVER'])
const slashes = (path: string): string => path.replaceAll('\\', '/')
const temporary: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const settingsOf = async (home: string): Promise<Readonly<Record<string, unknown>>> => {
  const claude = join(home, '.claude')
  const files = [
    ...(await readdir(claude)).filter((name) => /^settings.*\.json$/.test(name) || name === 'CLAUDE.md'),
    ...(await readdir(join(claude, 'plugins'))).filter((name) => name.endsWith('.json')).map((name) => join('plugins', name)),
  ].toSorted()
  const state = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as { mcpServers?: unknown }
  return {
    ...Object.fromEntries(await Promise.all(files.map(async (file): Promise<[string, string]> => [slashes(file), await readFile(join(claude, file), 'utf8')]))),
    mcpServers: state.mcpServers,
  }
}

test('a regular Claude home recording runs no user hook or MCP server and leaves the settings files unchanged', { tags: ['runtime'], timeout: 600_000 }, async (context) => {
  const driver = drivers.find(({ surface }) => surface === 'claude_cli')
  const engine = await driver?.resolve({ claude: process.env['AANG_RECORD_CLAUDE'] }).catch((error: unknown) => {
    if (error instanceof EngineUnavailableError) return undefined
    throw error
  })
  expect(engine !== undefined || !required.has('claude_cli'), 'claude_cli is required but not installed').toBe(true)
  if (engine === undefined) {
    context.skip()
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'aang-regular-claude-'))
  temporary.push(root)
  const home = join(root, 'home')
  const claude = join(home, '.claude')
  const project = join(root, 'project')
  const control = join(root, 'control.txt')
  const probe = join(root, 'probe.mjs')
  await mkdir(join(claude, 'plugins'), { recursive: true })
  await mkdir(project)
  await writeFile(probe, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(control)}, process.argv[2] + '\\n')\n`)
  const hook = `"${slashes(process.execPath)}" "${slashes(probe)}" hook`
  await writeFile(join(claude, 'settings.json'), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] } }, null, 2)}\n`)
  await writeFile(join(claude, 'CLAUDE.md'), 'Instructions of the owner\n')
  await writeFile(join(claude, 'plugins', 'installed_plugins.json'), `${JSON.stringify({ version: 2, plugins: {} })}\n`)
  await writeFile(join(claude, 'plugins', 'known_marketplaces.json'), '{}\n')
  await writeFile(join(home, '.claude.json'), `${JSON.stringify({ mcpServers: { probe: { type: 'stdio', command: process.execPath, args: [probe, 'mcp'] } } }, null, 2)}\n`)
  const controls = async (): Promise<string[]> => (await readFile(control, 'utf8').catch(() => '')).split('\n').filter(Boolean).toSorted()
  const stub = await startModelStub({}, join(root, 'model-stub.jsonl'))
  try {
    const model = {
      ANTHROPIC_BASE_URL: stub.url, ANTHROPIC_API_KEY: 'sk-ant-api03-aang-record-model-stub', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    }
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.has(key)))
    await exec(engine.executable, ['-p', 'hello'], { cwd: project, env: { ...environment, ...model, HOME: home, USERPROFILE: home }, timeout: 300_000 })
    expect(await controls()).toEqual(['hook', 'mcp'])
    await rm(control)
    const before = await settingsOf(home)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
    for (const scenario of ['first', 'second']) {
      const recording = await recordSession({
        runtime: 'claude', engineVersion: engine.version, surface: 'claude_cli', scenario, model: 'live', claudeHome: 'regular',
        expectedFacts: ['A session runs in the regular Claude home'], fixturesRoot: join(root, 'sessions'), hookBinary: binary,
      }, async (session) => {
        await session.run(engine.executable, ['-p', 'hello', '--setting-sources', 'user,project,local'], { env: model })
      })
      await verifyRecording(recording)
    }
    expect(await controls()).toEqual([])
    expect(await settingsOf(home)).toEqual(before)
  } finally {
    await stub.close()
  }
})
