import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Config, EpochNs } from '@aang/contract'
import {
  type AangHomePaths,
  leaseExpirySeconds,
  leaseFileName,
  readSpoolState,
  revokeLeases,
  type SpoolState,
} from '@aang/contract/home'
import type { GapDraft, Store } from '@aang/store'

export interface OverThreshold {
  readonly detected_at: EpochNs
  readonly bytes: number
}

export interface SpoolSupervisor {
  readonly reconcile: (renew: boolean) => Promise<boolean>
  readonly overThreshold: () => OverThreshold | null
  readonly release: () => Promise<void>
}

interface SpoolSupervisorOptions {
  readonly paths: AangHomePaths
  readonly settings: Config['spool']
  readonly store: Store
  readonly onThresholdChange: (over: OverThreshold | null) => Promise<void>
}

export const epochNow = (): EpochNs => EpochNs.parse(BigInt(Date.now()) * 1_000_000n)

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return false
      }
      throw error
    },
  )

export const prepareSpool = async (paths: AangHomePaths): Promise<void> => {
  await rm(paths.stoppedMarker, { force: true })
  await mkdir(paths.spoolReady, { recursive: true, mode: 0o700 })
  await mkdir(paths.spoolTemporary, { recursive: true, mode: 0o700 })
}

const leaseIsValid = (state: SpoolState): boolean =>
  state.leaseExpiresAt !== null && state.leaseExpiresAt > epochNow()

export const createSpoolSupervisor = ({
  paths,
  settings,
  store,
  onThresholdChange,
}: SpoolSupervisorOptions): SpoolSupervisor => {
  let over: OverThreshold | null = null

  const saveGap = (draft: GapDraft): void => {
    store.transaction((transaction) => transaction.gaps.save(draft))
  }

  const thresholdGap = (episode: OverThreshold, closedAt: EpochNs | null): GapDraft => ({
    key: { kind: 'gap', gap: 'spool_over_threshold', subject: `spool@${String(episode.detected_at)}` },
    run: null,
    session: null,
    stream: null,
    details: `spool held ${String(episode.bytes)} bytes, over the ${String(settings.thresholdBytes)}-byte threshold; hooks did not write while the lease was revoked`,
    detected_at: episode.detected_at,
    closed_at: closedAt,
  })

  const grantLease = async (): Promise<boolean> => {
    const lease = leaseFileName(Math.floor((Date.now() + settings.leaseTtlMs) / 1000))
    await writeFile(join(paths.spool, lease), '')
    const stale = (await readdir(paths.spool)).filter(
      (name) => name !== lease && leaseExpirySeconds(name) !== undefined,
    )
    await Promise.all(stale.map((name) => rm(join(paths.spool, name), { force: true })))
    if (await exists(paths.stoppedMarker)) {
      await revokeLeases(paths.spool)
      return false
    }
    return true
  }

  const reconcile = async (renew: boolean): Promise<boolean> => {
    const state = await readSpoolState(paths.spool)
    if (state.stopped) {
      await revokeLeases(paths.spool)
      return false
    }
    const exceeded = state.bytes > settings.thresholdBytes
    if (exceeded && over === null) {
      await revokeLeases(paths.spool)
      over = { detected_at: epochNow(), bytes: state.bytes }
      saveGap(thresholdGap(over, null))
      await onThresholdChange(over)
      return true
    }
    if (exceeded) {
      return true
    }
    if (over !== null) {
      saveGap(thresholdGap(over, epochNow()))
      over = null
      await onThresholdChange(null)
      return grantLease()
    }
    return renew || !leaseIsValid(state) ? grantLease() : true
  }

  const release = async (): Promise<void> => {
    await revokeLeases(paths.spool)
    if (over !== null) {
      saveGap(thresholdGap(over, epochNow()))
      over = null
    }
  }

  return { reconcile, overThreshold: () => over, release }
}
