import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [base, variant] = process.argv.slice(2)
if (base === undefined || variant === undefined) throw new Error('Usage: compare.mjs <base measurement> <variant measurement>')
const read = async (directory) => JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
const calls = async (directory) => JSON.parse(await readFile(join(directory, 'measurement.json'), 'utf8')).calls
const [left, right] = await Promise.all([read(base), read(variant)])
const [leftCalls, rightCalls] = await Promise.all([calls(base), calls(variant)])
const rank = (values, share) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]
}
const summary = (values) => ({ n: values.length, p50: rank(values, 0.5), p95: rank(values, 0.95), max: rank(values, 1) })
const keyOf = ({ recording, label }) => `${recording}:${label}`
const recordings = new Set(right.events.map(({ recording }) => recording))
const own = left.events.filter(({ recording }) => recordings.has(recording))
const pairs = own.flatMap((event) => {
  const other = right.events.find((candidate) => keyOf(candidate) === keyOf(event))
  return other === undefined ? [] : [{ key: keyOf(event), base: event, variant: other }]
})
const met = (event) => event.status === 'met' && event.latency_ms !== null
const both = pairs.filter(({ base: a, variant: b }) => met(a) && met(b))
const tokens = (usage) => (usage?.tokens == null ? 0 : usage.tokens.uncached_input_tokens + usage.tokens.cache_read_input_tokens + usage.tokens.cache_write_input_tokens + usage.tokens.output_tokens)
const leftRuns = new Set(own.flatMap(({ run }) => (run === null ? [] : [run])))
const rightRuns = new Set(right.events.flatMap(({ run }) => (run === null ? [] : [run])))
const callSummary = (list, runs) => {
  const ownCalls = list.filter(({ run }) => runs.has(run))
  return {
    calls: ownCalls.length,
    latency_ms: summary(ownCalls.flatMap(({ latency_ms: latency }) => (latency === null ? [] : [latency]))),
    tokens: summary(ownCalls.map(({ usage }) => tokens(usage))),
    cost_usd: ownCalls.reduce((sum, { usage }) => sum + (usage?.cost_usd ?? 0), 0),
  }
}
process.stdout.write(`${JSON.stringify({
  events: pairs.length,
  statuses: {
    base: Object.fromEntries([...new Set(pairs.map(({ base: event }) => event.status))].map((status) => [status, pairs.filter(({ base: event }) => event.status === status).length])),
    variant: Object.fromEntries([...new Set(pairs.map(({ variant: event }) => event.status))].map((status) => [status, pairs.filter(({ variant: event }) => event.status === status).length])),
  },
  met_in_both: both.length,
  latency_ms: { base: summary(both.map(({ base: event }) => event.latency_ms)), variant: summary(both.map(({ variant: event }) => event.latency_ms)) },
  faster_in_variant: both.filter(({ base: a, variant: b }) => b.latency_ms < a.latency_ms).length,
  calls: { base: callSummary(leftCalls, leftRuns), variant: callSummary(rightCalls, rightRuns) },
}, null, 2)}\n`)
