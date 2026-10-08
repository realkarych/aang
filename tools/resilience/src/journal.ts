export type Area = 'restart' | 'sources' | 'hooks' | 'divergence' | 'lineage'

export interface Check {
  readonly name: string
  readonly ok: boolean
  readonly observed: unknown
  readonly expected: unknown
  readonly known: string | null
}

export interface Step {
  readonly atMs: number
  readonly event: string
  readonly details?: unknown
}

export interface ScenarioReport {
  readonly name: string
  readonly area: Area
  readonly runtimes: readonly string[]
  readonly summary: string
  readonly status: 'passed' | 'known' | 'failed'
  readonly durationMs: number
  readonly steps: readonly Step[]
  readonly checks: readonly Check[]
  readonly observations: Readonly<Record<string, unknown>>
  readonly error: string | null
}

export interface Journal {
  readonly step: (event: string, details?: unknown) => void
  readonly check: (name: string, ok: boolean, observed: unknown, expected?: unknown, known?: string) => boolean
  readonly equal: (name: string, observed: unknown, expected: unknown, known?: string) => boolean
  readonly observe: (key: string, value: unknown) => void
  readonly report: (fields: Pick<ScenarioReport, 'name' | 'area' | 'runtimes' | 'summary'>, error: unknown) => ScenarioReport
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint'
      ? item.toString()
      : item !== null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
        : item,
  )

const describe = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error))

export const createJournal = (): Journal => {
  const started = performance.now()
  const steps: Step[] = []
  const checks: Check[] = []
  const observations: Record<string, unknown> = {}
  const elapsed = (): number => Math.round(performance.now() - started)
  const check = (name: string, ok: boolean, observed: unknown, expected: unknown = null, known?: string): boolean => {
    checks.push({ name, ok, observed, expected, known: known ?? null })
    const mark = ok ? '✔' : known === undefined ? '✘' : '⚑'
    process.stdout.write(`    ${mark} ${name}${ok ? '' : ` — observed ${canonical(observed)}${known === undefined ? '' : ` (known: ${known})`}`}\n`)
    return ok
  }
  return {
    step: (event, details) => {
      steps.push(details === undefined ? { atMs: elapsed(), event } : { atMs: elapsed(), event, details })
    },
    check,
    equal: (name, observed, expected, known) =>
      check(name, canonical(observed) === canonical(expected), observed, expected, known),
    observe: (key, value) => {
      observations[key] = value
    },
    report: ({ name, area, runtimes, summary }, error) => ({
      name,
      area,
      runtimes,
      summary,
      status:
        error !== null || checks.some(({ ok, known }) => !ok && known === null)
          ? 'failed'
          : checks.every(({ ok }) => ok)
            ? 'passed'
            : 'known',
      durationMs: elapsed(),
      steps,
      checks,
      observations,
      error: error === null ? null : describe(error),
    }),
  }
}
