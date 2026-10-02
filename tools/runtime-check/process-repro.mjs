import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startAnthropicStub } from './dist/anthropic-stub.js'
import { checkSection } from './dist/checks.js'
import { claudeDelivery } from './dist/claude.js'
import { locateClis } from './dist/clis.js'
import { codexForms } from './dist/codex.js'
import { probeScript } from './dist/context.js'
import { processTrees } from './dist/jobs.js'
import { createProfile, writeJson } from './dist/profile.js'
import { startResponsesStub } from './dist/responses-stub.js'

const out = resolve('runtime-check-report')
await mkdir(out, { recursive: true })
const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'aang process repro '))
const anthropic = await startAnthropicStub()
const responses = await startResponsesStub()
const report = { startedAt: new Date().toISOString(), work, attempts: [] }

try {
  const profile = await createProfile(work, resolve('packages/hook/bin/aang-hook.exe'))
  const clis = await locateClis({ claude: null, codex: null })
  const context = { work, profile, clis, anthropic, responses,
    probe: { node: process.execPath, script: probeScript, log: join(work, 'probe.jsonl') } }
  report.profile = profile
  report.versions = { claude: clis.claude.version, codex: clis.codex.version }
  const delivery = await claudeDelivery(context)
  report['claude hook delivery'] = delivery
  const forms = await codexForms(context)
  report['codex hook command forms'] = forms.report
  report.setupChecks = {
    claude: checkSection('claude hook delivery', delivery),
    codex: checkSection('codex hook command forms', forms.report),
  }
  await writeJson(join(out, 'process-repro.json'), report)
  if (Object.values(report.setupChecks).some(({ status }) => status !== 'passed')) {
    throw new Error('Process reproduction setup did not pass')
  }
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const trees = await processTrees(context, forms.installForm)
    const check = checkSection('process trees in a job object', trees)
    const result = { attempt, check, 'process trees in a job object': trees }
    await writeJson(join(out, `process-repro-${String(attempt)}.json`), result)
    report.attempts.push({ attempt, check })
    await writeJson(join(out, 'process-repro.json'), report)
    process.stdout.write(`${JSON.stringify({ attempt, check })}\n`)
    if (check.status !== 'passed') {
      process.exitCode = 1
      break
    }
  }
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeJson(join(out, 'process-repro.json'), report)
  await anthropic.close()
  await responses.close()
}
