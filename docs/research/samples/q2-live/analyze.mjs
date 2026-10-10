import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [directory] = process.argv.slice(2)
if (directory === undefined) throw new Error('Usage: analyze.mjs <measurement directory>')
const measurement = JSON.parse(await readFile(join(directory, 'measurement.json'), 'utf8'))
const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
const hourMs = 3_600_000

const rank = (values, share) => {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)]
}
const distribution = (values) => ({ n: values.length, p50: rank(values, 0.5), p95: rank(values, 0.95), max: rank(values, 1) })
const tokensOf = (usage) => {
  const tokens = usage?.tokens
  return tokens === null || tokens === undefined ? 0 : tokens.uncached_input_tokens + tokens.cache_read_input_tokens + tokens.cache_write_input_tokens + tokens.output_tokens
}
const slidingMax = (calls) => {
  const ended = calls.filter(({ ended_at: end }) => end !== null).toSorted((left, right) => left.ended_at - right.ended_at)
  let best = { tokens: 0, cost: 0, from: null }
  for (const [index, call] of ended.entries()) {
    const window = ended.slice(index).filter(({ ended_at: end }) => end < call.ended_at + hourMs)
    const tokens = window.reduce((sum, { usage }) => sum + tokensOf(usage), 0)
    if (tokens > best.tokens) best = { tokens, cost: window.reduce((sum, { usage }) => sum + (usage?.cost_usd ?? 0), 0), from: call.ended_at }
  }
  return { ...best, covered_ms: ended.length === 0 ? 0 : Math.min(hourMs, ended.at(-1).ended_at - (best.from ?? ended[0].ended_at)) }
}

const backends = measurement.backends.map(({ vendor }) => {
  const calls = measurement.calls.filter(({ runtime }) => runtime === vendor)
  const completed = calls.filter(({ latency_ms: latency }) => latency !== null)
  const runs = [...new Set(calls.map(({ run }) => run))]
  const recordings = measurement.recordings.filter(({ runtime }) => runtime === vendor)
  const chats = measurement.spent.filter(({ kind, backend }) => kind === 'chat' && backend === vendor)
  const reported = report.events.filter(({ runtime }) => runtime === vendor)
  const latencies = reported.flatMap(({ status, latency_ms: latency }) => (status === 'met' && latency !== null ? [latency] : []))
  return {
    vendor,
    calls: {
      total: calls.length,
      by_outcome: Object.fromEntries(['accepted', 'rejected', 'failed', 'running'].map((outcome) => [outcome, calls.filter((call) => call.outcome === outcome).length])),
      errors: Object.fromEntries([...new Set(calls.flatMap(({ error }) => (error === null ? [] : [error])))].map((error) => [error, calls.filter((call) => call.error === error).length])),
      latency_ms: distribution(completed.map(({ latency_ms: latency }) => latency)),
      needs_ms: distribution(calls.flatMap(({ needs_latency_ms: needs }) => (needs === null ? [] : [needs]))),
      facts: distribution(calls.map(({ facts }) => facts)),
      tokens: distribution(calls.map(({ usage }) => tokensOf(usage))),
      cost_usd: distribution(calls.flatMap(({ usage }) => (usage?.cost_usd == null ? [] : [usage.cost_usd]))),
      per_run: runs.map((run) => ({ run, calls: calls.filter((call) => call.run === run).length })),
    },
    sliding_hour: slidingMax(calls),
    chat_calls: { total: chats.length, latency_ms: distribution(chats.map(({ started_at: started, ended_at: ended }) => ended - started)), tokens: distribution(chats.map(({ usage }) => tokensOf(usage))) },
    met_latency_ms: distribution(latencies),
    statuses: Object.fromEntries([...new Set(reported.map(({ status }) => status))].map((status) => [status, reported.filter((event) => event.status === status).length])),
    by_method: Object.fromEntries(['predicate', 'annotation'].map((method) => [method, Object.fromEntries([...new Set(reported.filter((event) => event.method === method).map(({ status }) => status))].map((status) => [status, reported.filter((event) => event.method === method && event.status === status).length]))])),
    by_author: Object.fromEntries([...new Set(reported.flatMap(({ author }) => (author === null ? [] : [author])))].map((author) => [author, reported.filter((event) => event.author === author).length])),
    recordings: recordings.map(({ recording, started_at: started, finished_at: finished }) => ({ recording, minutes: Number(((finished - started) / 60_000).toFixed(1)) })),
  }
})
process.stdout.write(`${JSON.stringify({ duration_ms: measurement.ended_at - measurement.started_at, backends }, null, 2)}\n`)
