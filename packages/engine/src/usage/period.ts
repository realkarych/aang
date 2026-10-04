import type { EpochNs } from '@aang/contract'

export interface UsagePeriod {
  readonly from: EpochNs | null
  readonly to: EpochNs | null
}

const nanosPerHour = 3_600_000_000_000n

export const wholeTime: UsagePeriod = { from: null, to: null }

export const within = ({ from, to }: UsagePeriod, at: EpochNs): boolean =>
  (from === null || at >= from) && (to === null || at < to)

export const hoursOf = (instants: readonly EpochNs[]): number[] =>
  [...new Set(instants.map((at) => Number(at / nanosPerHour)))].sort((left, right) => left - right)
