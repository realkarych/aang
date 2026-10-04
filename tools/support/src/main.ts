import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { contractRun, runProblems, updateSupport } from './run.js'

const usage = [
  'Usage:',
  '  node tools/support/dist/main.js check [--fixtures <directory>] [--support <directory>] [--hook <aang-hook>]',
  '  node tools/support/dist/main.js update [--fixtures <directory>] [--support <directory>] [--hook <aang-hook>]',
].join('\n')

const repository = fileURLToPath(new URL('../../../', import.meta.url))

const main = async (args: readonly string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      fixtures: { type: 'string' },
      support: { type: 'string' },
      hook: { type: 'string' },
    },
  })
  const [command, ...rest] = positionals
  if ((command !== 'check' && command !== 'update') || rest.length > 0) {
    process.stderr.write(`${usage}\n`)
    return 2
  }
  const support = resolve(values.support ?? resolve(repository, 'support'))
  const options = {
    sessions: resolve(values.fixtures ?? resolve(repository, 'fixtures/sessions')),
    support,
    hookBinary: resolve(values.hook ?? resolve(repository, 'packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook')),
  }
  const run = await contractRun(options)
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
