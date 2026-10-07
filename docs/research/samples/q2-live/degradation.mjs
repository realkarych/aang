import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const [directory] = process.argv.slice(2)
if (directory === undefined) throw new Error('Usage: degradation.mjs <measurement directory>')
const measurement = JSON.parse(await readFile(join(directory, 'measurement.json'), 'utf8'))
const database = new DatabaseSync(join(directory, 'aang', 'aang.db'), { readOnly: true, readBigInts: true })
const nanoseconds = 1_000_000n
const ms = (value) => Number(BigInt(value) / nanoseconds)
const label = ({ state }) => (state.reason === undefined ? state.state : `${state.state}:${state.reason}`)

const runs = [...new Set(measurement.states.map(({ run }) => run))]
const outages = runs.flatMap((run) => {
  const samples = measurement.states.filter((sample) => sample.run === run)
  const spans = []
  let open
  for (const sample of samples) {
    if (sample.state.state !== 'ok' && open === undefined) open = { run, state: label(sample), from: sample.at, peak: sample.pending_facts }
    if (open !== undefined) open.peak = Math.max(open.peak, sample.pending_facts)
    if (sample.state.state === 'ok' && open !== undefined) {
      const drained = samples.find((later) => later.at >= sample.at && later.pending_facts <= 30)
      spans.push({ ...open, to: sample.at, pending_at_recovery: sample.pending_facts, drained_after_ms: drained === undefined ? null : drained.at - sample.at })
      open = undefined
    }
  }
  if (open !== undefined) spans.push({ ...open, to: measurement.ended_at, pending_at_recovery: null, drained_after_ms: null })
  return spans
})

const versions = database.prepare('SELECT run_id, author, created_at FROM model_versions').all().map((row) => ({ run: row.run_id, author: row.author, at: ms(row.created_at) }))
const calls = database.prepare('SELECT kind, run_id, verdict, error_class, started_at FROM observer_calls').all()
const within = (at, { from, to }) => at >= from && at < to

const summary = outages.map((outage) => ({
  run: outage.run,
  state: outage.state,
  duration_ms: outage.to - outage.from,
  pending_peak: outage.peak,
  pending_at_recovery: outage.pending_at_recovery,
  drained_after_ms: outage.drained_after_ms,
  versions_during: Object.fromEntries(
    ['rule', 'observer', 'user'].map((author) => [author, versions.filter((version) => version.run === outage.run && version.author === author && within(version.at, outage)).length]),
  ),
  failed_calls: calls.filter((call) => call.run_id === outage.run && call.verdict === 'failed').map((call) => call.error_class),
}))
const checks = calls.filter(({ kind }) => kind === 'probe' || kind === 'auth_status').map((call) => ({ kind: call.kind, verdict: call.verdict, error: call.error_class, at: new Date(ms(call.started_at)).toISOString() }))
const questions = measurement.questions.map((question) => ({
  status: question.status,
  during_outage: outages.some((outage) => question.asked_at !== null && within(question.asked_at, outage)),
  answer_ms: question.answered_at === null || question.asked_at === null ? null : question.answered_at - question.asked_at,
}))
process.stdout.write(`${JSON.stringify({ outages: summary, checks, questions }, null, 2)}\n`)
