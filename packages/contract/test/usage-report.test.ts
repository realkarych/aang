import { UsageReport, type JournalRates, type JournalTotals, type UsageTotals } from '@aang/contract'
import { describe, test } from 'vitest'

const idle: UsageTotals = {
  tokens: {
    uncached_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: null,
  },
  records: 0,
  output_lower_bound: false,
  cost_usd: null,
}

const totals: JournalTotals = {
  solver: { ...idle, tokens: { ...idle.tokens, uncached_input_tokens: 101 }, records: 3 },
  observer: idle,
  chat: idle,
}

const perActiveHour: JournalRates = {
  solver: { ...idle, tokens: { ...idle.tokens, uncached_input_tokens: 50.5 }, records: 1.5 },
  observer: idle,
  chat: idle,
}

describe.concurrent('usage report', () => {
  test('averages per active hour keep fractions while totals stay whole', ({ expect }) => {
    const report = { from: null, to: null, runs: [], totals, active_hours: 2, per_active_hour: perActiveHour }

    expect(UsageReport.parse(report)).toEqual(report)
    expect(UsageReport.safeParse({ ...report, totals: perActiveHour }).success).toBe(false)
  })
})
