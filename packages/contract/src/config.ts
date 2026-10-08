import { z } from 'zod'
import { Runtime } from './primitives.js'
import { Placement } from './support.js'

const name = z.string().min(1)
const path = z.string().min(1)
const milliseconds = z.int().positive()
const port = z.int().min(0).max(65_535)

const second = 1_000
const minute = 60 * second
const hour = 60 * minute

export const compilePattern = (source: string): RegExp => new RegExp(source, 'u')

const compiles = (source: string): boolean => {
  try {
    compilePattern(source)
    return true
  } catch {
    return false
  }
}

const pattern = z.string().min(1).refine(compiles, 'invalid regular expression')

export const CheckContract = z.strictObject({
  name,
  command: pattern,
  successExitCodes: z
    .array(z.int())
    .min(1)
    .default(() => [0]),
  inputMasks: z
    .array(name)
    .min(1)
    .default(() => ['.']),
  commitPattern: pattern.nullable().default(null),
})
export type CheckContract = z.infer<typeof CheckContract>

export const WatchedRoot = z.strictObject({
  path,
  contracts: z.array(CheckContract).default(() => []),
})
export type WatchedRoot = z.infer<typeof WatchedRoot>

export const Config = z.strictObject({
  placement: Placement.nullable().default(null),
  runtimes: z
    .strictObject({
      claude: z.strictObject({ configDir: path.nullable().default(null) }).prefault({}),
      codex: z.strictObject({ home: path.nullable().default(null) }).prefault({}),
    })
    .prefault({}),
  watch: z
    .strictObject({
      all: z.boolean().default(false),
      lookbackDays: z.int().positive().default(7),
      roots: z.array(WatchedRoot).default(() => []),
    })
    .prefault({}),
  collector: z
    .strictObject({
      fsWatch: z.boolean().default(true),
      spoolScanIntervalMs: milliseconds.default(5 * second),
      rootsScanIntervalMs: milliseconds.default(minute),
    })
    .prefault({}),
  spool: z
    .strictObject({
      maxAgeDays: z.int().positive().default(7),
      thresholdBytes: z.int().positive().default(1024 ** 3),
      checkIntervalMs: milliseconds.default(minute),
      leaseTtlMs: milliseconds.default(24 * hour),
      leaseRenewIntervalMs: milliseconds.default(hour),
    })
    .prefault({}),
  observer: z
    .strictObject({
      backend: Runtime.nullable().default(null),
      crossVendor: z.boolean().default(false),
      models: z
        .strictObject({
          claude: name.default('claude-opus-5-5'),
          codex: name.default('gpt-6.1-sol'),
        })
        .prefault({}),
      effort: z
        .strictObject({
          claude: name.nullable().default('low'),
          codex: name.nullable().default(null),
        })
        .prefault({}),
      budgetTokensPerHour: z.int().positive().nullable().default(null),
      timeoutMs: z
        .strictObject({
          claude: milliseconds.default(90 * second),
          codex: milliseconds.default(150 * second),
        })
        .prefault({}),
      inputLimitTokens: z.int().positive().default(24_000),
    })
    .prefault({}),
  cli: z
    .strictObject({
      claude: path.nullable().default(null),
      codex: path.nullable().default(null),
    })
    .prefault({}),
  api: z
    .strictObject({
      host: name.default('127.0.0.1'),
      port: port.default(4280),
    })
    .prefault({}),
  otel: z
    .strictObject({
      port: port.default(4281),
    })
    .prefault({}),
  artifacts: z
    .strictObject({
      maxBlobBytes: z.int().positive().default(5 * 1024 ** 2),
    })
    .prefault({}),
  freshness: z
    .strictObject({
      quietAfterMs: milliseconds.default(5 * minute),
    })
    .prefault({}),
})
export type Config = z.infer<typeof Config>

export const defaultConfig = (): Config => Config.parse({})
