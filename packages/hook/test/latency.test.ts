import { arch, cpus, platform, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import { type ExpectStatic, test } from 'vitest'
import {
  cleanExit,
  createSpool,
  type HookResult,
  runHook,
  type Spool,
  typicalEnv,
  typicalPayload,
  withoutNames,
} from './hook.js'

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

const describeReport = ({ p50, p95, max, results }: LatencyReport, { warmup, runs }: LatencySeries): string =>
  [
    `${platform()} ${release()} ${arch()}, ${cpus()[0]?.model ?? 'unknown CPU'}, Node ${process.version}`,
    `${String(runs)} runs after ${String(warmup)} warmup, ${String(results.length)} events`,
    `p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`,
  ].join('; ')

const expectEveryRunDelivered = async (
  expect: ExpectStatic,
  spool: Spool,
  { results }: LatencyReport,
): Promise<void> => {
  expect(results).toEqual(results.map(() => cleanExit))
  expect(withoutNames(await spool.events())).toEqual(
    results.map(() => ({ header: { runtime: 'claude', registration: 'plugin', env: typicalEnv }, payload: typicalPayload })),
  )
  expect((await spool.entries()).pending).toEqual([])
}

const ciSeries: LatencySeries = { warmup: 5, runs: 60 }

const benchmarkSeries: LatencySeries = { warmup: 20, runs: 500 }

test('every typical event is delivered intact exactly once without pending files', { timeout: 120_000 }, async ({
  expect,
  onTestFinished,
  annotate,
}) => {
  const spool = await createSpool(onTestFinished)

  const report = await measure(spool.args(), ciSeries)

  await annotate(describeReport(report, ciSeries))
  await expectEveryRunDelivered(expect, spool, report)
})

test('typical event round trip p95 is at most 10 ms', { tags: ['benchmark'], timeout: 600_000 }, async ({
  expect,
  onTestFinished,
  annotate,
}) => {
  const spool = await createSpool(onTestFinished)

  const report = await measure(spool.args(), benchmarkSeries)

  await annotate(describeReport(report, benchmarkSeries))
  await expectEveryRunDelivered(expect, spool, report)
  expect(report.p95).toBeLessThanOrEqual(10)
})
