import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { driverOf, EngineUnavailableError, recordScenario, scenarioModel, scenarios, supportsOs, verifyRecording } from '../dist/index.js'

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

test.for(runnable.map((scenario) => ({ id: `${scenario.surface}/${scenario.name}`, scenario })))(
  'records and verifies $id with the model stub',
  { tags: ['runtime'], timeout: 900_000 },
  async ({ scenario }, context) => {
    const driver = driverOf(scenario)
    const available = await driver.resolve(selection).then(() => true, (error: unknown) => {
      if (error instanceof EngineUnavailableError) return false
      throw error
    })
    expect(available || !required.has(scenario.surface), `${scenario.surface} is required but not installed`).toBe(true)
    if (!available) {
      context.skip()
      return
    }
    const recording = await recordScenario(scenario, driver, { fixturesRoot, hookBinary: binary, model: 'stub', selection })
    await verifyRecording(recording)
  },
)
