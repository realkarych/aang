import { mkdir, writeFile } from 'node:fs/promises'
import { arch, homedir, platform, release, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { type Clis, locateCli } from './clis.js'
import { createJournal, type ScenarioReport } from './journal.js'
import { createLab } from './lab.js'
import { scenarios } from './scenarios/index.js'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'resilience-report' },
    only: { type: 'string', multiple: true },
    claude: { type: 'string' },
    codex: { type: 'string' },
    aang: { type: 'string' },
    list: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
})

const qualified = (scenario: { readonly area: string; readonly name: string }): string =>
  `${scenario.area}/${scenario.name}`

if (values.list) {
  for (const scenario of scenarios) process.stdout.write(`${qualified(scenario)}\n`)
  process.exit(0)
}

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const aangEntry = resolve(values.aang ?? join(repository, 'packages', 'aang', 'dist', 'main.js'))
const out = resolve(values.out)
const selected = scenarios.filter(
  (scenario) =>
    values.only === undefined ||
    values.only.some((filter) => qualified(scenario) === filter || scenario.area === filter),
)
if (selected.length === 0) {
  throw new Error(`no scenario matches ${String(values.only)}`)
}

const versionEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(?:CLAUDE|CODEX_|AANG_|AI_AGENT$)/i.test(name)),
)
const clis: Clis = {
  claude: locateCli('claude', values.claude ?? null, versionEnv),
  codex: locateCli('codex', values.codex ?? null, versionEnv),
}

const redactions: readonly (readonly [string, string])[] = [
  [tmpdir(), '<tmp>'],
  [homedir(), '~'],
]

const redact = (text: string): string =>
  redactions.reduce(
    (current, [path, placeholder]) =>
      current.replaceAll(path, placeholder).replaceAll(JSON.stringify(path).slice(1, -1), placeholder),
    text.replace(/\/private\/var\/folders\/[^"\s/]+\/[^"\s/]+\/T/g, '<tmp>'),
  )

const marks: Readonly<Record<ScenarioReport['status'], string>> = { passed: '✔', known: '⚑', failed: '✘' }

const reports: ScenarioReport[] = []
const startedAt = new Date().toISOString()

const writeReport = async (): Promise<void> => {
  await mkdir(out, { recursive: true })
  const report = {
    platform: { os: platform(), release: release(), arch: arch(), node: process.version },
    versions: { claude: clis.claude.version, codex: clis.codex.version },
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios: reports,
    failed: reports.filter(({ status }) => status === 'failed').map(qualified),
    known: reports.filter(({ status }) => status === 'known').map(qualified),
  }
  await writeFile(join(out, 'report.json'), redact(`${JSON.stringify(report, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`))
  const lines = [
    `# aang Q.4 resilience on ${platform()} ${release()} ${arch()}`,
    '',
    `claude ${clis.claude.version}, codex ${clis.codex.version}`,
    '',
    ...reports.flatMap((scenario) => [
      `- ${marks[scenario.status]} ${qualified(scenario)} (${String(Math.round(scenario.durationMs / 1000))} s)`,
      ...scenario.checks
        .filter(({ ok }) => !ok)
        .map(({ name, known }) => `  - ${known === null ? '✘' : '⚑'} ${name}${known === null ? '' : ` (known: ${known})`}`),
      ...(scenario.error === null ? [] : [`  - ${scenario.error.split('\n')[0] ?? ''}`]),
    ]),
    '',
  ]
  await writeFile(join(out, 'summary.md'), redact(lines.join('\n')))
}

for (const scenario of selected) {
  process.stdout.write(`▶ ${qualified(scenario)}\n`)
  const journal = createJournal()
  let error: unknown = null
  const lab = await createLab({
    clis,
    aangEntry,
    journal,
    ...(scenario.scripts === undefined ? {} : { scripts: scenario.scripts }),
    ...(scenario.config === undefined ? {} : { config: scenario.config }),
  })
  try {
    await scenario.run(lab)
  } catch (caught) {
    error = caught
  } finally {
    await lab.dispose(values.keep).catch((disposal: unknown) => {
      error ??= disposal
    })
  }
  const report = journal.report(scenario, error)
  reports.push(report)
  process.stdout.write(`${marks[report.status]} ${qualified(scenario)}\n`)
  if (report.error !== null) process.stdout.write(`${report.error}\n`)
  await writeReport()
}

process.exitCode = reports.some(({ status }) => status === 'failed') ? 1 : 0
