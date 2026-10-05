import type { EpochNs } from '@aang/contract'

const locale = 'ru'

export interface Forms {
  readonly one: string
  readonly few: string
  readonly many: string
}

const pluralRules = new Intl.PluralRules(locale)

export const plural = (count: number, forms: Forms): string => {
  const rule = pluralRules.select(count)
  return `${String(count)} ${rule === 'one' ? forms.one : rule === 'few' ? forms.few : forms.many}`
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
    return 'только что'
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
    return `${String(seconds)} с`
  }
  if (seconds < 3_600) {
    return `${String(Math.floor(seconds / 60))} мин`
  }
  return `${String(Math.floor(seconds / 3_600))} ч ${String(Math.floor((seconds % 3_600) / 60))} мин`
}

const byteUnits = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] as const
const byteFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })

export const bytes = (value: number): string => {
  let scaled = value
  let unit = 0
  while (scaled >= 1024 && unit < byteUnits.length - 1) {
    scaled /= 1024
    unit += 1
  }
  return `${byteFormat.format(scaled)} ${byteUnits[unit] ?? 'Б'}`
}

const wholeFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
const rateFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
const secondsFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const moneyFormat = new Intl.NumberFormat(locale, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

export const whole = (value: number): string => wholeFormat.format(value)

export const rate = (value: number): string => rateFormat.format(value)

export const money = (usd: number): string => moneyFormat.format(usd)

export const elapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1_000)
  const parts = [
    [Math.floor(seconds / 3_600), 'ч'],
    [Math.floor((seconds % 3_600) / 60), 'мин'],
    [seconds % 60, 'с'],
  ] as const
  const shown = parts.filter(([value]) => value > 0).map(([value, unit]) => `${String(value)} ${unit}`)
  return shown.length === 0 ? '0 с' : shown.join(' ')
}

export const wait = (ms: number): string => (ms < 60_000 ? `${secondsFormat.format(ms / 1_000)} с` : elapsed(ms))
