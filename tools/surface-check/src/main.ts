#!/usr/bin/env node
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { type OperatingSystem, Placement, Surface } from '@aang/contract'
import { checkAccess } from './access.js'
import { aangCommand } from './aang.js'
import { anonymized, type Anonymizer, anonymizer, identity, leaks } from './anonymous.js'
import { type CheckReport, coreScenarios, dockerDetected, type KeptDaemon, runCheck } from './check.js'
import { summary } from './summary.js'

const usage = [
  'Usage:',
  '  node tools/surface-check/dist/main.js run [--placement local|docker|vm|desktop_ssh] [--surfaces <surface,...>] [--require <surface,...>]',
  '    [--scenarios core|all|<name,...>] [--emulate-desktop] [--out <directory>] [--work <directory>] [--support <directory>]',
  '    [--aang <main.js|command>] [--hook <aang-hook>] [--bind <address>] [--port <port>] [--keep-daemon <file>]',
  '    [--claude <executable>] [--codex <executable>] [--claude-sdk <package>] [--codex-sdk <package>]',
  '  node tools/surface-check/dist/main.js access --link <sign-in link> [--origin <origin>] [--expect-write <status>] [--out <file>] [--into <report.json>]',
  '  node tools/surface-check/dist/main.js anonymous <directory>...',
].join('\n')

const repository = fileURLToPath(new URL('../../../', import.meta.url))

const hostOs = (): OperatingSystem =>
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

const defaultSurfaces: readonly Surface[] = ['claude_cli', 'claude_sdk', 'codex_exec', 'codex_sdk', 'codex_tui']

const list = (value: string | undefined): string[] => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)

const surfacesOf = (value: string | undefined): Surface[] =>
  value === undefined ? [...defaultSurfaces] : list(value).map((surface) => Surface.parse(surface))

const anonymizerOf = async (work: string | null): Promise<Anonymizer> => {
  const { home, host } = identity()
  const workPaths = work === null ? [] : [work, await realpath(work).catch(() => work)]
  return anonymizer([...workPaths.map((path) => [path, '<work>'] as const), [home, '~']], host)
}

const writeReport = async (out: string, checked: CheckReport, anonymize: Anonymizer): Promise<void> => {
  const report = anonymized(checked, anonymize)
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const text = summary(report)
  await writeFile(join(out, 'summary.md'), text)
  if (process.env['GITHUB_STEP_SUMMARY'] !== undefined) {
    await appendFile(process.env['GITHUB_STEP_SUMMARY'], text)
  }
}

const writeKept = async (file: string, kept: KeptDaemon): Promise<void> => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(kept, null, 2)}\n`)
}

const run = async (args: readonly string[]): Promise<number> => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      placement: { type: 'string', default: 'local' },
      surfaces: { type: 'string' },
      require: { type: 'string' },
      scenarios: { type: 'string', default: 'core' },
      'emulate-desktop': { type: 'boolean', default: false },
      out: { type: 'string', default: 'surface-check-report' },
      work: { type: 'string' },
      support: { type: 'string' },
      aang: { type: 'string' },
      hook: { type: 'string' },
      bind: { type: 'string' },
      port: { type: 'string' },
      'keep-daemon': { type: 'string' },
      claude: { type: 'string' },
      codex: { type: 'string' },
      'claude-sdk': { type: 'string' },
      'codex-sdk': { type: 'string' },
    },
  })
  const placement = Placement.parse(values.placement)
  if (placement === 'docker' && !dockerDetected()) {
    throw new Error('--placement docker runs inside a container, but /.dockerenv is missing')
  }
  const names = values.scenarios === 'all' ? 'all' : values.scenarios === 'core' ? coreScenarios : list(values.scenarios)
  const work = resolve(values.work ?? join(tmpdir(), 'aang-surface-check'))
  const keptFile = values['keep-daemon'] === undefined ? null : resolve(values['keep-daemon'])
  const { report, kept } = await runCheck({
    os: hostOs(),
    placement,
    surfaces: surfacesOf(values.surfaces),
    required: new Set(list(values.require).map((surface) => Surface.parse(surface))),
    scenarioNames: names,
    emulateDesktop: values['emulate-desktop'],
    selection: {
      claude: values.claude ?? process.env['AANG_RECORD_CLAUDE'],
      codex: values.codex ?? process.env['AANG_RECORD_CODEX'],
      claudeSdk: values['claude-sdk'] ?? process.env['AANG_RECORD_CLAUDE_SDK'],
      codexSdk: values['codex-sdk'] ?? process.env['AANG_RECORD_CODEX_SDK'],
    },
    aang: aangCommand(values.aang ?? join(repository, 'packages', 'aang', 'dist', 'main.js')),
    hookBinary: resolve(values.hook ?? join(repository, 'packages', 'hook', 'bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook')),
    support: resolve(values.support ?? join(repository, 'support')),
    bind: values.bind ?? null,
    port: values.port === undefined ? null : Number(values.port),
    keepDaemon: keptFile !== null,
    work,
    progress: (line) => {
      process.stdout.write(`${line}\n`)
    },
  })
  if (keptFile !== null && kept !== null) {
    await writeKept(keptFile, kept)
  }
  await writeReport(resolve(values.out), report, await anonymizerOf(work))
  const passed = report.results.every(({ result }) => result !== 'failed') && report.access.result === 'passed'
  process.stdout.write(`${passed ? 'passed' : 'failed'}: ${resolve(values.out, 'report.json')}\n`)
  return passed ? 0 : 1
}

const access = async (args: readonly string[]): Promise<number> => {
  const { values } = parseArgs({
    args: [...args],
    options: {
      link: { type: 'string' },
      origin: { type: 'string' },
      'expect-write': { type: 'string', default: '200' },
      out: { type: 'string' },
      into: { type: 'string' },
    },
  })
  if (values.link === undefined) {
    process.stderr.write(`${usage}\n`)
    return 2
  }
  const link = new URL(values.link)
  const report = await checkAccess(link, values.origin ?? link.origin, Number(values['expect-write']))
  const text = `${JSON.stringify(report, null, 2)}\n`
  process.stdout.write(text)
  if (values.out !== undefined) {
    await mkdir(dirname(resolve(values.out)), { recursive: true })
    await writeFile(resolve(values.out), text)
  }
  if (values.into !== undefined) {
    const path = resolve(values.into)
    const checked: CheckReport = { ...(JSON.parse(await readFile(path, 'utf8')) as CheckReport), access: report }
    await writeReport(dirname(path), checked, await anonymizerOf(null))
  }
  return report.result === 'passed' ? 0 : 1
}

const anonymous = async (directories: readonly string[]): Promise<number> => {
  if (directories.length === 0) {
    process.stderr.write(`${usage}\n`)
    return 2
  }
  const who = identity()
  const found = (await Promise.all(directories.map((directory) => leaks(resolve(directory), who)))).flat()
  for (const { file, kind } of found) {
    process.stderr.write(`${file} names ${kind} of this machine\n`)
  }
  return found.length === 0 ? 0 : 1
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'run') {
  process.exitCode = await run(rest)
} else if (command === 'access') {
  process.exitCode = await access(rest)
} else if (command === 'anonymous') {
  process.exitCode = await anonymous(rest)
} else {
  process.stderr.write(`${usage}\n`)
  process.exitCode = 2
}
