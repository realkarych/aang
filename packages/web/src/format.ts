import type { EpochNs } from '@aang/contract'

const locale = 'en-US'

interface Forms {
  readonly one: string
  readonly other: string
}

const pluralRules = new Intl.PluralRules(locale)

export const plural = (count: number, forms: Forms): string => {
  return `${String(count)} ${pluralRules.select(count) === 'one' ? forms.one : forms.other}`
}

export const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n

const millisecondsOf = (at: EpochNs | bigint): number => Number(at / 1_000_000n)

const absoluteFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' })
const clockFormat = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dayFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

export const absoluteTime = (at: EpochNs): string => absoluteFormat.format(millisecondsOf(at))

export const clockTime = (at: EpochNs | bigint): string => clockFormat.format(millisecondsOf(at))

export const dayTime = (at: EpochNs): string => dayFormat.format(millisecondsOf(at))

export const relativeTime = (at: EpochNs, now: bigint): string => {
  const seconds = Math.round(Number((now - at) / 1_000_000_000n))
  if (seconds < 10) {
    return 'just now'
  }
  if (seconds < 60) {
    return relativeFormat.format(-seconds, 'second')
  }
  if (seconds < 3_600) {
    return relativeFormat.format(-Math.floor(seconds / 60), 'minute')
  }
  if (seconds < 86_400) {
    return relativeFormat.format(-Math.floor(seconds / 3_600), 'hour')
  }
  return dayTime(at)
}

export const duration = (from: EpochNs, to: bigint): string => {
  const seconds = Math.max(0, Math.round(Number((to - from) / 1_000_000_000n)))
  if (seconds < 60) {
    return `${String(seconds)} s`
  }
  if (seconds < 3_600) {
    return `${String(Math.floor(seconds / 60))} min`
  }
  return `${String(Math.floor(seconds / 3_600))} h ${String(Math.floor((seconds % 3_600) / 60))} min`
}

const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB'] as const
const byteFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })

export const bytes = (value: number): string => {
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < byteUnits.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${byteFormat.format(scaled)} ${byteUnits[unit] ?? 'B'}`
}

const wholeFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })

export const whole = (value: number): string => wholeFormat.format(value)
