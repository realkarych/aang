import { EpochNs } from '@aang/contract'
import { z } from 'zod'

const isoInstant = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/
const nanosPerMilli = 1_000_000n
const fractionDigits = 9

const toEpoch = (nanos: bigint): EpochNs | null => {
  const parsed = EpochNs.safeParse(nanos)
  return parsed.success ? parsed.data : null
}

export const instantFromIso = (value: string): EpochNs | null => {
  const match = isoInstant.exec(value)
  const seconds = match?.[1]
  if (seconds === undefined) {
    return null
  }
  const millis = Date.parse(`${seconds}Z`)
  if (Number.isNaN(millis)) {
    return null
  }
  const fraction = (match?.[2] ?? '').padEnd(fractionDigits, '0')
  return toEpoch(BigInt(millis) * nanosPerMilli + BigInt(fraction))
}

export const instantFromMillis = (millis: number): EpochNs | null =>
  Number.isSafeInteger(millis) ? toEpoch(BigInt(millis) * nanosPerMilli) : null

const Envelope = z.looseObject({
  timestamp: z.string(),
  ordinal: z.int().nonnegative(),
  type: z.string().min(1),
  payload: z.unknown(),
})

const Timestamped = z.looseObject({ timestamp: z.string() })

const Ordinal = z.looseObject({ ordinal: z.int().nonnegative() })

export interface RolloutLine {
  readonly at: EpochNs
  readonly ordinal: number
  readonly type: string
  readonly payload: unknown
}

export type LineReading =
  | { readonly kind: 'line'; readonly line: RolloutLine }
  | { readonly kind: 'unrecognized'; readonly at: EpochNs | null }
  | { readonly kind: 'malformed'; readonly reason: string }

const readObject = (text: string): Record<string, unknown> | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return z.record(z.string(), z.unknown()).safeParse(value).data ?? null
}

const timestampOf = (value: Record<string, unknown>): EpochNs | null => {
  const timestamped = Timestamped.safeParse(value)
  return timestamped.success ? instantFromIso(timestamped.data.timestamp) : null
}

export const readLine = (text: string): LineReading => {
  const value = readObject(text)
  if (value === null) {
    return { kind: 'malformed', reason: 'rollout line is not a JSON object' }
  }
  const envelope = Envelope.safeParse(value)
  const at = timestampOf(value)
  if (!envelope.success || at === null) {
    return { kind: 'unrecognized', at }
  }
  const { ordinal, type, payload } = envelope.data
  return { kind: 'line', line: { at, ordinal, type, payload } }
}

export const ordinalOf = (text: string): number | null => {
  const value = readObject(text)
  return value === null ? null : (Ordinal.safeParse(value).data?.ordinal ?? null)
}
