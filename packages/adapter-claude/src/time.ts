import { EpochNs } from '@aang/contract'

const nanosecondsPerMillisecond = 1_000_000n

export const epochFromMilliseconds = (milliseconds: number): EpochNs | null => {
  const epoch = EpochNs.safeParse(BigInt(milliseconds) * nanosecondsPerMillisecond)
  return epoch.success ? epoch.data : null
}

export const epochFromIso = (iso: string): EpochNs | null => {
  const milliseconds = Date.parse(iso)
  return Number.isNaN(milliseconds) ? null : epochFromMilliseconds(milliseconds)
}
