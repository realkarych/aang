import { EpochNs } from '@aang/contract'

const nanosecondsPerMillisecond = 1_000_000n

export const epochFromIso = (iso: string): EpochNs | null => {
  const milliseconds = Date.parse(iso)
  if (Number.isNaN(milliseconds)) {
    return null
  }
  const epoch = EpochNs.safeParse(BigInt(milliseconds) * nanosecondsPerMillisecond)
  return epoch.success ? epoch.data : null
}
