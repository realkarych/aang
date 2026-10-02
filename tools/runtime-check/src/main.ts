import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { startAnthropicStub } from './anthropic-stub.js'
import { claudeDelivery, claudeLaunchers } from './claude.js'
import { inspectExecutables, locateClis } from './clis.js'
import { codexBehaviour, codexForms } from './codex.js'
import { type CheckContext, probeScript } from './context.js'
import { processTrees } from './jobs.js'
import { claudeSeries, codexSeries, hookLatency } from './latency.js'
import { observerAdmission } from './observer.js'
import { pipelineCheck } from './pipeline.js'
import { createProfile, writeJson } from './profile.js'
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
  },
})

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const hookBinary = resolve(
  values.hook ?? join(repositoryRoot, 'packages', 'hook', 'bin', isWindows ? 'aang-hook.exe' : 'aang-hook'),
)
const out = resolve(values.out ?? 'runtime-check-report')
const work = resolve(values.work ?? join(process.env.RUNNER_TEMP ?? tmpdir(), `aang check ${String(Date.now())}`))
const reportPath = join(out, 'report.json')

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
    ...(isWindows ? { defenderRealTimeProtection: defenderRealtime() } : {}),
  },
  startedAt: new Date().toISOString(),
}
const timings: Record<string, string> = {}
const failed: string[] = []

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
  } catch (error) {
    report[name] = { error: describe(error) }
    failed.push(name)
  }
  timings[name] = `${String(Math.round((Date.now() - started) / 1000))} s`
  process.stdout.write(`${failed.includes(name) ? '✘' : '✔'} ${name} (${timings[name]})\n`)
  await writeJson(reportPath, report)
  return value
}

const summary = (): string =>
  [
    `# aang runtime check on ${platform()} ${release()} ${arch()}`,
    '',
    ...Object.entries(timings).map(([name, time]) => `- ${failed.includes(name) ? '✘' : '✔'} ${name} — ${time}`),
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
await mkdir(work, { recursive: true })
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

try {
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
  await section('default roots', () => defaultRoots(context), null)
} finally {
  report.finishedAt = new Date().toISOString()
  report.failedSections = failed
  await writeJson(reportPath, report)
  await writeFile(join(out, 'summary.md'), summary())
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary())
  }
  await anthropic.close()
  await responses.close()
}

process.exitCode = failed.length === 0 ? 0 : 1
