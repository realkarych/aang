import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { arch, cpus, homedir, loadavg, platform, release, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { type AgentSdk, installAgentSdk } from './agent-sdk.js'
import { startAnthropicStub } from './anthropic-stub.js'
import { checkSection, type SectionCheck } from './checks.js'
import { claudeDelivery, claudeLaunchers } from './claude.js'
import { inspectExecutables, locateClis } from './clis.js'
import { codexBehaviour, codexForms } from './codex.js'
import { type CheckContext, probeScript } from './context.js'
import {
  aangInstallForm,
  claudeMarketplace,
  claudeRemoval,
  claudeSkillsDirectory,
  codexInstallation,
  compareUserProfile,
  installedLatency,
  snapshotUserProfile,
  trimProbes,
} from './delivery.js'
import { processTrees } from './jobs.js'
import { claudeSeries, codexSeries, hookLatency } from './latency.js'
import { observerAdmission } from './observer.js'
import { pipelineCheck } from './pipeline.js'
import { createProfile } from './profile.js'
import { isWindows } from './process.js'
import { startResponsesStub } from './responses-stub.js'
import { defaultRoots } from './roots.js'

const { values } = parseArgs({
  options: {
    hook: { type: 'string' },
    out: { type: 'string' },
    work: { type: 'string' },
    claude: { type: 'string' },
    codex: { type: 'string' },
    'disposable-profile': { type: 'boolean', default: false },
    suite: { type: 'string', default: 'windows' },
    'agent-sdk': { type: 'string', default: 'latest' },
  },
})

const suites = ['windows', 'delivery'] as const
type Suite = (typeof suites)[number]
const isSuite = (value: string): value is Suite => (suites as readonly string[]).includes(value)
if (!isSuite(values.suite)) {
  throw new Error(`unknown suite ${values.suite}; expected one of ${suites.join(', ')}`)
}
const suite: Suite = values.suite

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const hookBinary = resolve(
  values.hook ?? join(repositoryRoot, 'packages', 'hook', 'bin', isWindows ? 'aang-hook.exe' : 'aang-hook'),
)
const out = resolve(values.out ?? 'runtime-check-report')
const work = resolve(values.work ?? join(process.env.RUNNER_TEMP ?? tmpdir(), `aang check ${String(Date.now())}`))
const reportPath = join(out, 'report.json')
await mkdir(work, { recursive: true })
const workReal = await realpath(work)

const redact = (text: string): string =>
  suite === 'delivery'
    ? [workReal, work, homedir()].reduce((current, path) => current.replaceAll(path, path === homedir() ? '~' : '<work>'), text)
    : text

const writeReport = (): Promise<void> => writeFile(reportPath, redact(`${JSON.stringify(report, null, 2)}\n`))

const defenderRealtime = (): string | null => {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-MpComputerStatus).RealTimeProtectionEnabled'],
      { encoding: 'utf8', windowsHide: true },
    ).trim()
  } catch {
    return null
  }
}

const report: Record<string, unknown> = {
  platform: {
    os: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? null,
    node: process.version,
    ...(isWindows ? { defenderRealTimeProtection: defenderRealtime() } : { loadAverageAtStart: loadavg() }),
  },
  suite,
  startedAt: new Date().toISOString(),
}
const timings: Record<string, string> = {}
const failed: string[] = []
const checks: Record<string, SectionCheck> = {}

const symbol = (name: string): string => checks[name]?.status === 'skipped' ? '↷' : failed.includes(name) ? '✘' : '✔'

const describe = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error))

const section = async <T>(
  name: string,
  body: () => Promise<T>,
  fallback: T,
  present: (value: T) => unknown = (value) => value,
): Promise<T> => {
  process.stdout.write(`▶ ${name}\n`)
  const started = Date.now()
  let value = fallback
  try {
    value = await body()
    report[name] = present(value)
    checks[name] = checkSection(name, report[name])
    if (checks[name].status === 'failed') failed.push(name)
  } catch (error) {
    report[name] = { error: describe(error) }
    checks[name] = { status: 'failed', reasons: [describe(error)] }
    failed.push(name)
  }
  timings[name] = `${String(Math.round((Date.now() - started) / 1000))} s`
  report.checks = checks
  process.stdout.write(`${symbol(name)} ${name} (${timings[name]})\n`)
  if (checks[name].status === 'failed') process.stdout.write(`${checks[name].reasons.join('\n')}\n`)
  await writeReport()
  return value
}

const summary = (): string =>
  [
    `# aang runtime check (${suite}) on ${platform()} ${release()} ${arch()}`,
    '',
    ...Object.entries(timings).map(([name, time]) => `- ${symbol(name)} ${name} — ${time}`),
    '',
    ...Object.keys(timings).flatMap((name) => {
      const json = JSON.stringify(report[name], null, 2)
      return [
        `<details><summary>${name}</summary>`,
        '',
        '```json',
        json.length > 6_000 ? `${json.slice(0, 6_000)}\n…` : json,
        '```',
        '',
        '</details>',
        '',
      ]
    }),
  ].join('\n')

await mkdir(out, { recursive: true })
const userProfile = suite === 'delivery' ? await snapshotUserProfile() : null
const anthropic = await startAnthropicStub()
const responses = await startResponsesStub()
const profile = await createProfile(work, hookBinary)
const clis = await locateClis({ claude: values.claude ?? null, codex: values.codex ?? null })
report.versions = { claude: clis.claude.version, codex: clis.codex.version }
report.profile = profile
const context: CheckContext = {
  work,
  profile,
  clis,
  anthropic,
  responses,
  probe: { node: process.execPath, script: probeScript, log: join(work, 'probe.jsonl') },
}

const windowsSuite = async (): Promise<void> => {
  await section('executables', () => inspectExecutables(clis), null)
  await section('claude hook delivery', () => claudeDelivery(context), null)
  const claudeProbes = await section(
    'claude hook launchers',
    () => claudeLaunchers(context),
    { report: {}, probes: [] },
    ({ report: launchers }) => launchers,
  )
  const forms = await section(
    'codex hook command forms',
    () => codexForms(context),
    null,
    (value) => value?.report,
  )
  const installForm = forms?.installForm ?? null
  const probeForm = forms?.probeForm ?? null
  await section('codex hook exit and timeout', () => codexBehaviour(context, probeForm), null)
  await section('collector and adapters on real files', () => pipelineCheck(context, installForm), null)
  await section(
    'hook latency by launcher',
    () =>
      hookLatency(context, {
        claudeProbes: claudeProbes.probes,
        codexProbes: forms?.probes ?? [],
        installForm,
        probeForm,
      }),
    null,
  )
  await section('claude series with and without hooks', () => claudeSeries(context), null)
  await section(
    'codex series with and without hooks',
    async () =>
      installForm === null
        ? { skipped: 'Codex executed no aang-hook command form' }
        : codexSeries(context, installForm),
    null,
  )
  await section('observer admission', () => observerAdmission(context, probeForm), null)
  await section('process trees in a job object', () => processTrees(context, installForm), null)
  await section('default roots', () => defaultRoots(context, values['disposable-profile']), null)
}

const deliverySeriesPairs = 15

const deliverySuite = async (): Promise<void> => {
  await section('executables', () => inspectExecutables(clis), null)
  const sdk = await section<AgentSdk | null>(
    'agent sdk',
    () => installAgentSdk(work, values['agent-sdk']),
    null,
    (value) => (value === null ? null : { requested: values['agent-sdk'], version: value.version }),
  )
  await section('claude plugin from the marketplace', () => claudeMarketplace(context, hookBinary, sdk), null)
  await section('claude plugin from the skills directory', () => claudeSkillsDirectory(context, sdk), null)
  const claudeProbes = await section(
    'claude hook launchers',
    () => claudeLaunchers(context),
    { report: {}, probes: [] },
    ({ report: launchers }) => trimProbes(launchers, 'claude'),
  )
  const codex = await section(
    'codex hooks installed by aang',
    () => codexInstallation(context, hookBinary),
    null,
    (value) => value?.report,
  )
  await section('codex hook exit and timeout', () => codexBehaviour(context, aangInstallForm), null)
  await section(
    'installed hook latency',
    () => installedLatency(context, { claudeProbes: claudeProbes.probes, codexLauncher: codex?.launcher ?? null }),
    null,
  )
  await section('claude series with and without hooks', () => claudeSeries(context, deliverySeriesPairs), null)
  await section(
    'codex series with and without hooks',
    () => codexSeries(context, aangInstallForm, deliverySeriesPairs),
    null,
  )
  await section('claude plugin removal', () => claudeRemoval(context), null)
  await section(
    'user profile untouched',
    () => (userProfile === null ? Promise.resolve(null) : compareUserProfile(userProfile, work)),
    null,
  )
}

try {
  await (suite === 'delivery' ? deliverySuite() : windowsSuite())
} finally {
  report.finishedAt = new Date().toISOString()
  if (!isWindows) {
    report.loadAverageAtFinish = loadavg()
  }
  report.failedSections = failed
  await writeReport()
  await writeFile(join(out, 'summary.md'), redact(summary()))
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, redact(summary()))
  }
  await anthropic.close()
  await responses.close()
}

process.exitCode = failed.length === 0 ? 0 : 1
