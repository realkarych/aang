import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, expect, test } from 'vitest'
import { driverOf, EngineUnavailableError, recordScenario, type Scenario, scenarioModel, scenarios, supportsOs, verifyRecording } from '../dist/index.js'

const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
const binary = resolve('packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook')
const env = process.env
const selection = {
  claude: env['AANG_RECORD_CLAUDE'],
  codex: env['AANG_RECORD_CODEX'],
  claudeSdk: env['AANG_RECORD_CLAUDE_SDK'],
  codexSdk: env['AANG_RECORD_CODEX_SDK'],
  claudeDesktop: env['AANG_RECORD_CLAUDE_DESKTOP'],
  codexDesktop: env['AANG_RECORD_CODEX_DESKTOP'],
}
const required = new Set((env['AANG_RECORD_REQUIRE'] ?? '').split(',').filter(Boolean))
const kept = env['AANG_RECORD_FIXTURES']
const fixturesRoot = kept === undefined ? await mkdtemp(join(tmpdir(), 'aang-catalog-')) : resolve(kept)

afterAll(async () => {
  if (kept === undefined) await rm(fixturesRoot, { recursive: true, force: true })
})

const runnable = scenarios.filter((scenario) => scenarioModel(scenario, 'stub') !== undefined && supportsOs(scenario, driverOf(scenario), os))

const installed = async (scenario: Scenario): Promise<boolean> => {
  const available = await driverOf(scenario).resolve(selection).then(() => true, (error: unknown) => {
    if (error instanceof EngineUnavailableError) return false
    throw error
  })
  expect(available || !required.has(scenario.surface), `${scenario.surface} is required but not installed`).toBe(true)
  return available
}

test.for(runnable.map((scenario) => ({ id: `${scenario.surface}/${scenario.name}`, scenario })))(
  'records and verifies $id with the model stub',
  { tags: ['runtime'], timeout: 900_000 },
  async ({ scenario }, context) => {
    if (!await installed(scenario)) {
      context.skip()
      return
    }
    const recording = await recordScenario(scenario, driverOf(scenario), { fixturesRoot, hookBinary: binary, model: 'stub', selection }).catch((error: unknown) => {
      if (error instanceof EngineUnavailableError && !required.has(scenario.surface)) return undefined
      throw error
    })
    if (recording === undefined) {
      context.skip()
      return
    }
    await verifyRecording(recording)
  },
)

const inputDialogs = runnable.find((scenario) => scenario.surface === 'claude_cli' && scenario.name === 'input-dialogs')

test.runIf(inputDialogs !== undefined)(
  'records claude_cli/input-dialogs started inside tmux with a reachable it2 on the login shell PATH',
  { tags: ['runtime'], timeout: 900_000 },
  async (context) => {
    if (inputDialogs === undefined || !await installed(inputDialogs)) {
      context.skip()
      return
    }
    const outside = await mkdtemp(join(tmpdir(), 'aang-inside-tmux-'))
    try {
      const tools = join(outside, 'bin')
      await mkdir(tools)
      await writeFile(join(tools, 'it2'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const loginShell = join(outside, 'login-shell')
      await writeFile(loginShell, `#!/bin/sh\nPATH='${tools}':$PATH\nexport PATH\nexec /bin/sh "$@"\n`, { mode: 0o755 })
      const recorder = fileURLToPath(new URL('../dist/main.js', import.meta.url))
      const recorded = await promisify(execFile)(process.execPath, [
        recorder, 'scenario', 'claude_cli', 'input-dialogs', '--model', 'stub', '--fixtures', join(outside, 'sessions'), '--hook', binary,
        ...selection.claude === undefined ? [] : ['--claude', selection.claude],
      ], {
        env: { ...env, TMUX: `${join(outside, 'tmux-socket')},4242,0`, TMUX_PANE: '%42', SHELL: loginShell, PATH: `${tools}${delimiter}${env['PATH'] ?? ''}` },
      })
      await verifyRecording(recorded.stdout.trim())
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  },
)
