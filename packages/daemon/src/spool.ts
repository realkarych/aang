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
import { z } from 'zod'

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

const activeEpisodeSetting = 'spool_over_threshold'

const Episode = z.strictObject({
  detected_at: EpochNs,
  bytes: z.int().nonnegative(),
  threshold_bytes: z.int().nonnegative(),
})
type Episode = z.infer<typeof Episode>

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

const recordedEpisode = (store: Store): Episode | null => {
  const recorded = store.settings.get(activeEpisodeSetting)
  return recorded === undefined ? null : Episode.parse(recorded)
}

const overThresholdOf = (episode: Episode | null): OverThreshold | null =>
  episode === null ? null : { detected_at: episode.detected_at, bytes: episode.bytes }

export const recordedOverThreshold = (store: Store): OverThreshold | null => overThresholdOf(recordedEpisode(store))

const leaseIsValid = (state: SpoolState): boolean =>
  state.leaseExpiresAt !== null && state.leaseExpiresAt > epochNow()

export const createSpoolSupervisor = ({
  paths,
  settings,
  store,
  onThresholdChange,
}: SpoolSupervisorOptions): SpoolSupervisor => {
  let episode = recordedEpisode(store)

  const overThreshold = (): OverThreshold | null => overThresholdOf(episode)

  const thresholdGap = (active: Episode, closedAt: EpochNs | null): GapDraft => ({
    key: { kind: 'gap', gap: 'spool_over_threshold', subject: `spool@${String(active.detected_at)}` },
    run: null,
    session: null,
    stream: null,
    details: `spool held ${String(active.bytes)} bytes, over the ${String(active.threshold_bytes)}-byte threshold; hooks did not write while the lease was revoked`,
    detected_at: active.detected_at,
    closed_at: closedAt,
  })

  const openEpisode = (active: Episode): void => {
    store.transaction((transaction) => {
      transaction.gaps.save(thresholdGap(active, null))
      transaction.settings.save(activeEpisodeSetting, Episode.encode(active), active.detected_at)
    })
  }

  const closeEpisode = (active: Episode): void => {
    const closedAt = epochNow()
    store.transaction((transaction) => {
      transaction.gaps.save(thresholdGap(active, closedAt))
      transaction.settings.remove(activeEpisodeSetting)
    })
  }

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
    if (state.bytes > settings.thresholdBytes) {
      if (state.leaseExpiresAt !== null) {
        await revokeLeases(paths.spool)
      }
      if (episode === null) {
        episode = { detected_at: epochNow(), bytes: state.bytes, threshold_bytes: settings.thresholdBytes }
        openEpisode(episode)
        await onThresholdChange(overThreshold())
      }
      return true
    }
    if (episode !== null) {
      closeEpisode(episode)
      episode = null
      await onThresholdChange(null)
      return grantLease()
    }
    return renew || !leaseIsValid(state) ? grantLease() : true
  }

  const release = async (): Promise<void> => {
    await revokeLeases(paths.spool)
    if (episode !== null) {
      closeEpisode(episode)
      episode = null
    }
  }

  return { reconcile, overThreshold, release }
}
