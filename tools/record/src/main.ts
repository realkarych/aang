import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Surface } from '@aang/contract'
import { z } from 'zod'
import type { CreatedEntries } from './capture.js'
import { driverOf, scenarios } from './catalog.js'
import { recordSession, type RecordContext } from './record.js'
import { recordScenario, scenarioModel, supportsOs } from './scenario.js'
import { ModelMode, ProfileHome, RecordMetadata, recordingOs } from './schema.js'
import { verifyRecording } from './verify.js'

const Scenario = z.object({
  options: RecordMetadata.safeExtend({ fixturesRoot: z.string().min(1), hookBinary: z.string().min(1), codexHome: ProfileHome.optional(), claudeHome: ProfileHome.optional() }),
  run: z.custom<(context: RecordContext) => Promise<void>>((value) => typeof value === 'function'),
})

const usage = [
  'Usage:',
  '  node tools/record/dist/main.js record <scenario.mjs>',
  '  node tools/record/dist/main.js verify <recording-directory>',
  '  node tools/record/dist/main.js scenarios',
  '  node tools/record/dist/main.js scenario <surface> [name ...] [--model stub|live] [--claude-home isolated|regular] [--fixtures <directory>] [--hook <aang-hook>]',
  '    [--claude <executable>] [--codex <executable>] [--claude-sdk <package-directory>] [--codex-sdk <package-directory>]',
  '    [--claude-desktop <executable>] [--codex-desktop <executable>]',
].join('\n')

const repository = fileURLToPath(new URL('../../../', import.meta.url))

const report = (entries: CreatedEntries): void => {
  process.stderr.write([
    ...entries.sessions.length === 0 && entries.paths.length === 0 ? [] : [
      'Created in the regular profile:',
      ...entries.sessions.map((session) => `  session ${session}`),
      ...entries.paths.map((path) => `  ${path}`),
    ],
    ...entries.unreadable.length === 0 ? [] : [
      'Not checked in the regular profile, unreadable:',
      ...entries.unreadable.map((path) => `  ${path}`),
    ],
  ].map((line) => `${line}\n`).join(''))
}

const listScenarios = (): void => {
  const os = recordingOs()
  for (const scenario of scenarios) {
    const here = supportsOs(scenario, driverOf(scenario), os) ? '' : ` (not on ${os})`
    process.stdout.write(`${scenario.surface} ${scenario.name} [${scenario.models.join(', ')}]${here}\n`)
  }
}

const runScenarios = async (args: readonly string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      'claude-home': { type: 'string' },
      fixtures: { type: 'string' },
      hook: { type: 'string' },
      claude: { type: 'string' },
      codex: { type: 'string' },
      'claude-sdk': { type: 'string' },
      'codex-sdk': { type: 'string' },
      'claude-desktop': { type: 'string' },
      'codex-desktop': { type: 'string' },
    },
  })
  const [surfaceName, ...names] = positionals
  const surface = Surface.parse(surfaceName)
  const model = values.model === undefined ? undefined : ModelMode.parse(values.model)
  const claudeHome = values['claude-home'] === undefined ? undefined : ProfileHome.parse(values['claude-home'])
  const os = recordingOs()
  const available = scenarios.filter((scenario) => scenario.surface === surface)
  const unknown = names.filter((name) => !available.some((scenario) => scenario.name === name))
  if (unknown.length > 0) throw new Error(`Unknown ${surface} scenarios: ${unknown.join(', ')}`)
  const selected = names.length === 0
    ? available.filter((scenario) => scenarioModel(scenario, model) !== undefined && supportsOs(scenario, driverOf(scenario), os))
    : available.filter((scenario) => names.includes(scenario.name))
  if (selected.length === 0) throw new Error(`No ${surface} scenarios for this model and OS`)
  const hookBinary = values.hook ?? resolve(repository, 'packages/hook/bin', os === 'windows' ? 'aang-hook.exe' : 'aang-hook')
  const fixturesRoot = resolve(values.fixtures ?? resolve(repository, 'fixtures/sessions'))
  for (const scenario of selected) {
    process.stdout.write(`${await recordScenario(scenario, driverOf(scenario), {
      fixturesRoot,
      hookBinary,
      model,
      claudeHome,
      created: report,
      selection: {
        claude: values.claude,
        codex: values.codex,
        claudeSdk: values['claude-sdk'],
        codexSdk: values['codex-sdk'],
        claudeDesktop: values['claude-desktop'],
        codexDesktop: values['codex-desktop'],
      },
    })}\n`)
  }
}

const main = async (): Promise<void> => {
  const [operation, ...rest] = process.argv.slice(2)
  if (operation === 'scenarios' && rest.length === 0) {
    listScenarios()
    return
  }
  if (operation === 'scenario' && rest.length > 0) {
    await runScenarios(rest)
    return
  }
  const [path, ...extra] = rest
  if (!path || extra.length || (operation !== 'record' && operation !== 'verify')) {
    throw new Error(usage)
  }
  if (operation === 'verify') {
    await verifyRecording(resolve(path))
    return
  }
  const loaded: unknown = await import(pathToFileURL(resolve(path)).href)
  const scenario = Scenario.parse(loaded)
  process.stdout.write(`${await recordSession({ ...scenario.options, created: report }, scenario.run)}\n`)
}

try { await main() } catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
