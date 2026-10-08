import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { measurementFiles } from './files.js'
import { fixProfile } from './fix.js'
import { measure } from './measure.js'
import { type Report, writeReport } from './report.js'

const usage = [
  'Usage:',
  '  node tools/freshness/dist/main.js fix <profile.json> <directory> [--fixtures <directory>]',
  '  node tools/freshness/dist/main.js run <directory> [--fixtures <directory>] [--daemon <aang main.js>] [--hook <aang-hook>]',
  '  node tools/freshness/dist/main.js report <directory>',
].join('\n')

const repository = fileURLToPath(new URL('../../../', import.meta.url))

const rejected = (): number => {
  process.stderr.write(`${usage}\n`)
  return 2
}

const summarize = (directory: string, report: Report): number => {
  for (const backend of report.backends) {
    const p95 = backend.p95 === null ? 'none' : backend.p95.kind === 'latency' ? `${String(backend.p95.ms)} ms` : 'beyond the window'
    process.stdout.write(
      `${backend.runtime}: p95 ${p95} (target ${String(backend.target_p95_ms)} ms), ${String(backend.violations)} violations, ${String(backend.unassessed)} awaiting the annotator\n`,
    )
  }
  process.stdout.write(`report written to ${join(directory, measurementFiles.summary)}\n`)
  return 0
}

const main = async (args: readonly string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      fixtures: { type: 'string' },
      daemon: { type: 'string' },
      hook: { type: 'string' },
    },
  })
  const [command, ...rest] = positionals
  const fixtures = resolve(values.fixtures ?? resolve(repository, 'fixtures/sessions'))
  if (command === 'fix' && rest.length === 2) {
    const [source = '', directory = ''] = rest
    const fixed = await fixProfile(resolve(source), resolve(directory), fixtures)
    process.stdout.write(`profile ${fixed.profile.name} fixed in ${resolve(directory)}\n`)
    return 0
  }
  const [directory] = rest
  if (directory === undefined || rest.length > 1) {
    return rejected()
  }
  if (command === 'run') {
    await measure({
      directory: resolve(directory),
      fixtures,
      daemonEntry: resolve(values.daemon ?? resolve(repository, 'packages/aang/dist/main.js')),
      hookBinary: resolve(
        values.hook ?? resolve(repository, 'packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook'),
      ),
    })
    return summarize(resolve(directory), await writeReport(resolve(directory)))
  }
  if (command === 'report') {
    return summarize(resolve(directory), await writeReport(resolve(directory)))
  }
  return rejected()
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  return 1
})
