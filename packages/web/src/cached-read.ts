import type { ArtifactVersionId, ArtifactVersionResponse, Fact, FactId } from '@aang/contract'
import { readArtifactVersion, readFact } from './api.js'
import { nowNs } from './format.js'

const readTimeoutMs = 10_000

const retryNs = 5_000_000_000n

const cachedRead = <K, T>(
  read: (key: K, signal: AbortSignal) => Promise<T>,
): ((key: K, now: bigint) => Promise<T | null>) => {
  const reads = new Map<K, Promise<T | null>>()
  const failures = new Map<K, bigint>()
  const usable = (key: K, now: bigint): boolean => {
    const failedAt = failures.get(key)
    return failedAt === undefined || now - failedAt < retryNs
  }
  return (key, now) => {
    const known = reads.get(key)
    if (known !== undefined && usable(key, now)) {
      return known
    }
    failures.delete(key)
    const reading = read(key, AbortSignal.timeout(readTimeoutMs)).catch(() => {
      failures.set(key, nowNs())
      return null
    })
    reads.set(key, reading)
    return reading
  }
}

export const factRead: (id: FactId, now: bigint) => Promise<Fact | null> = cachedRead(readFact)

export const versionRead: (id: ArtifactVersionId, now: bigint) => Promise<ArtifactVersionResponse | null> =
  cachedRead(readArtifactVersion)
