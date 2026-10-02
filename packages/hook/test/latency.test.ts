import { performance } from 'node:perf_hooks'
import { test } from 'vitest'
import { cleanExit, createSpool, type HookResult, runHook, typicalEnv, typicalPayload } from './hook.js'

interface LatencySeries {
  readonly warmup: number
  readonly runs: number
}

interface LatencyReport {
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly results: readonly HookResult[]
}

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? Number.NaN

const measure = async (spoolArgs: readonly string[], { warmup, runs }: LatencySeries): Promise<LatencyReport> => {
  const durations: number[] = []
  const results: HookResult[] = []
  for (let index = 0; index < warmup + runs; index += 1) {
    const started = performance.now()
    results.push(await runHook(spoolArgs, { binary: 'plain', env: typicalEnv, stdin: typicalPayload }))
    if (index >= warmup) {
      durations.push(performance.now() - started)
    }
  }
  const sorted = durations.sort((left, right) => left - right)
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? Number.NaN, results }
}

const describeReport = ({ p50, p95, max }: LatencyReport): string =>
  `p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`

const ciBudgetMs: Readonly<Partial<Record<NodeJS.Platform, number>>> = { linux: 50, darwin: 100, win32: 150 }

test('typical event round trip stays within the CI latency budget of the platform', { timeout: 120_000 }, async ({
  expect,
  onTestFinished,
  annotate,
}) => {
  const spool = await createSpool(onTestFinished)

  const report = await measure(spool.args(), { warmup: 5, runs: 60 })

  await annotate(describeReport(report))
  expect(report.results).toEqual(report.results.map(() => cleanExit))
  expect(await spool.events()).toHaveLength(report.results.length)
  expect(report.p95).toBeLessThanOrEqual(ciBudgetMs[process.platform] ?? 150)
})

test('typical event round trip p95 is at most 10 ms', { tags: ['benchmark'], timeout: 600_000 }, async ({
  expect,
  onTestFinished,
  annotate,
}) => {
  const spool = await createSpool(onTestFinished)

  const report = await measure(spool.args(), { warmup: 20, runs: 500 })

  await annotate(describeReport(report))
  expect(report.results).toEqual(report.results.map(() => cleanExit))
  expect(report.p95).toBeLessThanOrEqual(10)
})
