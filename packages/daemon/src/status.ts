import { stat } from 'node:fs/promises'
import {
  type Config,
  type Gap,
  GapKind,
  type HookInstallation,
  NotObservableSurface,
  type ObserverBackendStatus,
  type OperatingSystem,
  type Placement,
  type Runtime,
  type RuntimeStatus,
  runtimes,
  type Session,
  type SpoolStatus,
  type StatusResponse,
  type SupportMatrix,
  type SupportStatus,
  supportStatusOf,
  type VersionKey,
  type VersionStatus,
} from '@aang/contract'
import { type AangHomePaths, readSpoolState } from '@aang/contract/home'
import type { Store } from '@aang/store'
import { ignoreMissing } from './missing.js'
import { type OverThreshold, recordedOverThreshold } from './spool.js'
import { loadWatch } from './watch.js'

export interface SupportHost {
  readonly os: OperatingSystem
  readonly placement: Placement
}

export interface StatusSources {
  readonly daemon: StatusResponse['daemon']
  readonly store: Store
  readonly config: Config
  readonly runtimeRoots: Readonly<Record<Runtime, string>>
  readonly paths: AangHomePaths
  readonly hooks: () => Readonly<Record<Runtime, HookInstallation>>
  readonly matrix: SupportMatrix
  readonly host: SupportHost
  readonly observer: () => ObserverBackendStatus[]
}

const sizeOf = (path: string): Promise<number> =>
  stat(path).then(
    ({ size }) => size,
    (error: unknown) => ignoreMissing(error, 0),
  )

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (stats) => stats.isDirectory(),
    (error: unknown) => ignoreMissing(error, false),
  )

const sessionIds = (sessions: readonly Session[], matches: (session: Session) => boolean) =>
  sessions.filter(matches).map(({ id }) => id)

const runtimeStatus = async (
  runtime: Runtime,
  root: string,
  hooks: HookInstallation,
  sessions: readonly Session[],
): Promise<RuntimeStatus> => {
  const own = sessions.filter(({ key }) => key.runtime === runtime)
  return {
    runtime,
    root,
    root_exists: await isDirectory(root),
    hooks,
    hooks_inactive_sessions: sessionIds(own, ({ support_mode: mode }) => mode === 'files_only'),
    double_registration_sessions: sessionIds(own, ({ double_registration: double }) => double),
  }
}

const isSourceGap = ({ run, session }: Gap): boolean => run === null && session === null

const order = <T extends bigint | string>(left: T, right: T): number => (left < right ? -1 : left > right ? 1 : 0)

const byDetection = (left: Gap, right: Gap): number =>
  order(left.detected_at, right.detected_at) || order(left.id, right.id)

const versionKeyText = ({ runtime, surface, os, placement, engine_version: version }: VersionKey): string =>
  JSON.stringify([runtime, surface, os, placement, version])

const supportOf = (matrix: SupportMatrix, key: VersionKey): SupportStatus =>
  key.surface === null ? 'unverified' : supportStatusOf(matrix, { ...key, surface: key.surface })

const versionsOf = (sessions: readonly Session[], matrix: SupportMatrix, host: SupportHost): VersionStatus[] => {
  const versions = new Map<string, VersionStatus>()
  for (const { key: session, surface, version, last_event_at: seen } of sessions) {
    if (version === null) {
      continue
    }
    const key: VersionKey = { runtime: session.runtime, surface: surface?.surface ?? null, ...host, engine_version: version }
    const known = versions.get(versionKeyText(key))
    versions.set(versionKeyText(key), {
      key,
      status: supportOf(matrix, key),
      sessions: (known?.sessions ?? 0) + 1,
      last_seen_at: known === undefined || seen > known.last_seen_at ? seen : known.last_seen_at,
    })
  }
  return [...versions].sort(([left], [right]) => order(left, right)).map(([, status]) => status)
}

const spoolStatus = async (
  paths: AangHomePaths,
  thresholdBytes: number,
  over: OverThreshold | null,
): Promise<SpoolStatus> => {
  const spool = await readSpoolState(paths.spool)
  return {
    files: spool.files,
    bytes: spool.bytes,
    lease_expires_at: spool.leaseExpiresAt,
    stopped: spool.stopped,
    threshold_bytes: thresholdBytes,
    over_threshold: over !== null,
    growth_since_threshold_bytes: over === null ? null : Math.max(0, spool.bytes - over.bytes),
  }
}

export const createStatus =
  ({ daemon, store, config, runtimeRoots, paths, hooks, matrix, host, observer }: StatusSources) =>
  async (): Promise<StatusResponse> => {
    const installations = hooks()
    const recorded = store.read(() => ({
      changeSeq: store.changes.head(),
      sessions: store.observations.sessions(),
      gaps: GapKind.options.flatMap((kind) => store.gaps.open(kind)),
      overThreshold: recordedOverThreshold(store),
      watch: loadWatch(store, config),
    }))
    const [databaseBytes, logBytes, runtimeStatuses, spool] = await Promise.all([
      sizeOf(store.file.path),
      sizeOf(`${store.file.path}-wal`),
      Promise.all(
        runtimes.map((runtime) =>
          runtimeStatus(runtime, runtimeRoots[runtime], installations[runtime], recorded.sessions),
        ),
      ),
      spoolStatus(paths, config.spool.thresholdBytes, recorded.overThreshold),
    ])
    return {
      daemon,
      database: {
        path: store.file.path,
        size_bytes: databaseBytes + logBytes,
        schema_version: store.file.schemaVersion,
        change_seq: recorded.changeSeq,
      },
      runtimes: runtimeStatuses,
      watch: recorded.watch,
      spool,
      observer: { cross_vendor: config.observer.crossVendor, backends: observer() },
      versions: versionsOf(recorded.sessions, matrix, host),
      unknown_records: recorded.sessions.reduce((total, { unknown_records: unknown }) => total + unknown, 0),
      gaps: recorded.gaps.filter(isSourceGap).sort(byDetection),
      not_observable: NotObservableSurface.options,
    }
  }
