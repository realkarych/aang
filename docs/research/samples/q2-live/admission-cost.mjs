import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const { admitClaude } = await import(join(repository, 'packages/observer/dist/admission-probes.js'))
const { cleanEnvironment, resolveCli } = await import(join(repository, 'packages/observer/dist/environment.js'))

const { values } = parseArgs({ options: { cli: { type: 'string', default: 'claude' }, model: { type: 'string', default: 'claude-opus-5-5' }, out: { type: 'string' } } })
const cli = resolveCli('claude', values.cli, process.env)
const environment = cleanEnvironment('claude', process.env)
const directory = await realpath(await mkdtemp(join(tmpdir(), 'aang-admission-cost-')))
const calls = []

const execute = (args, input, cwd, env) =>
  new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(cli.command, [...(cli.args ?? []), ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (exitCode) => {
      const result = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)).find((event) => event.type === 'result')
      if (result !== undefined) {
        calls.push({
          wall_ms: Math.round(performance.now() - started),
          duration_ms: result.duration_ms,
          total_cost_usd: result.total_cost_usd,
          usage: result.usage,
          model_usage: result.modelUsage,
        })
      }
      resolve({ exitCode, stdout, stderr, failure: null, stopped: Promise.resolve() })
    })
    child.stdin.end(input)
  })

try {
  const plugins = await admitClaude(
    { directory, env: environment, run: (args, input = '', cwd = directory, env = environment) => execute(args, input, cwd, env) },
    { cli: values.cli, model: values.model, environment: process.env },
  )
  const summary = {
    model: values.model,
    admitted_plugins: plugins,
    calls,
    total_cost_usd: calls.reduce((sum, call) => sum + (call.total_cost_usd ?? 0), 0),
  }
  const text = `${JSON.stringify(summary, null, 2)}\n`
  if (values.out === undefined) process.stdout.write(text)
  else await writeFile(values.out, text)
} finally {
  await rm(directory, { recursive: true, force: true })
}
