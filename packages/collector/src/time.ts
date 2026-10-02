import type { EpochNs } from '@aang/contract'

const nanosecondsPerMillisecond = 1_000_000n

export const epochNs = (value: bigint): EpochNs => value as EpochNs

export const millisecondsToNs = (milliseconds: number): bigint => BigInt(milliseconds) * nanosecondsPerMillisecond

export const nowNs = (): EpochNs => epochNs(millisecondsToNs(Date.now()))
