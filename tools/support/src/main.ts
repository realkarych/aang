import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkCodexIsolation, importIsolation, isolationSummary, recordIsolation } from './isolation.js'
import { contractRun, runProblems, updateSupport } from './run.js'

const usage = [
  'Usage:',
  '  node tools/support/dist/main.js check [--fixtures <directory>] [--support <directory>] [--hook <aang-hook>]',
  '  node tools/support/dist/main.js update [--fixtures <directory>] [--support <directory>] [--hook <aang-hook>]',
  '  node tools/support/dist/main.js isolation codex [--support <directory>] [--hook <aang-hook>] [--cli <codex>]',
  '  node tools/support/dist/main.js isolation import <matrix.json>... [--support <directory>]',
].join('\n')

const repository = fileURLToPath(new URL('../../../', import.meta.url))

const rejected = (): number => {
  process.stderr.write(`${usage}\n`)
  return 2
}

interface IsolationOptions {
  readonly support: string
  readonly hookBinary: string
  readonly cli: string | undefined
}

const isolation = async ([target, ...files]: readonly string[], options: IsolationOptions): Promise<number> => {
  if (target === 'import' && files.length > 0) {
    await importIsolation(options.support, files.map((file) => resolve(file)))
    process.stdout.write(`observer isolation of ${String(files.length)} matrices written to ${options.support}\n`)
    return 0
  }
  if (target !== 'codex' || files.length > 0) {
    return rejected()
  }
  const check = await checkCodexIsolation({ cli: options.cli ?? 'codex', windowsLauncher: options.hookBinary })
  await recordIsolation(options.support, check)
  process.stdout.write(`${isolationSummary(check)}\n`)
  return check.observer.admission === 'passed' ? 0 : 1
}

const main = async (args: readonly string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      fixtures: { type: 'string' },
      support: { type: 'string' },
      hook: { type: 'string' },
      cli: { type: 'string' },
    },
  })
  const [command, ...rest] = positionals
  const support = resolve(values.support ?? resolve(repository, 'support'))
  const hookBinary = resolve(values.hook ?? resolve(repository, 'packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook'))
  if (command === 'isolation') {
    return isolation(rest, { support, hookBinary, cli: values.cli })
  }
  if ((command !== 'check' && command !== 'update') || rest.length > 0) {
    return rejected()
  }
  const run = await contractRun({
    sessions: resolve(values.fixtures ?? resolve(repository, 'fixtures/sessions')),
    support,
    hookBinary,
  })
  if (command === 'update') {
    await updateSupport(run, support)
    process.stdout.write(`${String(run.checks.length)} recordings, snapshots and matrix written to ${support}\n`)
    return 0
  }
  const problems = runProblems(run, support)
  for (const problem of problems) {
    process.stdout.write(`${problem}\n`)
  }
  process.stdout.write(`${String(run.checks.length)} recordings, ${String(problems.length)} problems\n`)
  return problems.length === 0 ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  return 1
})
