import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import { createCollector, type CollectorService } from '@aang/collector'
import {
  type Adapter,
  type AdapterRegistry,
  type CollectedGap,
  type CollectorBatch,
  Config,
  EpochNs,
  type Gap,
  type Runtime,
  spoolLayout,
} from '@aang/contract'
import { contentHash } from '@aang/contract/ids'
import { createEngine } from '@aang/engine'
import { openStore, type Store } from '@aang/store'
import type { RecordingManifest } from '@aang/record'
import { createPlayer, leaseSpool, type LoadedManifest, playbackShift, type PlayerStep, type RecordShift, type Target } from '@aang/testkit'

export const adapters: AdapterRegistry = new Map<Runtime, Adapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
])

export interface RecordedTimes {
  readonly startedAt: number
  readonly mtimes: ReadonlyMap<string, bigint>
}

export interface PlayOptions {
  readonly hookBinary: string
  readonly recorded: RecordedTimes
  readonly startsAt?: number
  readonly stepTimeoutMs?: number
}

export interface PlaybackRoots {
  readonly base: string
  readonly home: string
  readonly claude: string
  readonly codex: string
}

export interface Played {
  readonly store: Store
  readonly roots: PlaybackRoots
  readonly restarts: number
  readonly shift: RecordShift
}

interface Ingestion {
  readonly store: Store
  readonly collector: CollectorService
  readonly stop: () => Promise<void>
  readonly close: () => Promise<void>
}

type Collected = 'tail' | 'snapshot' | null

interface Observed {
  otel: number
  readonly reads: Map<string, number>
  readonly offsets: Map<string, number>
  readonly streams: Map<string, string>
  readonly files: Map<string, string | null>
  readonly lost: Set<string>
}

interface Before {
  readonly otel: number
  readonly reads: ReadonlyMap<string, number>
}

const scanIntervalMs = 10
const pollMs = 5
const defaultStepTimeoutMs = 30_000
const otelToken = 'contract-run-otel-token-0123456789'
const otelDirectory = 'otel'
const toolDecisionEvent = 'codex.tool_decision'

const secondMs = 1_000
const nanosecondsPerMs = 1_000_000n
const nanosecondsPerSecond = 1_000_000_000

export const restartLabel = 'daemon-restart'

export const recordedTimes = ({ recorded_at: recordedAt, artifacts }: Pick<RecordingManifest, 'recorded_at' | 'artifacts'>): RecordedTimes => ({
  startedAt: Date.parse(recordedAt),
  mtimes: new Map(artifacts.map(({ source, mtime_ns: mtime }) => [source, BigInt(mtime)])),
})

const wholeSeconds = (ms: number): number => Math.floor(ms / secondMs) * secondMs

const busyCodes: readonly string[] = ['EBUSY', 'EPERM', 'EACCES']
const busyAttempts = 50
const busyRetryMs = 20

const isBusy = (error: unknown): boolean =>
  process.platform === 'win32' && error instanceof Error && 'code' in error && busyCodes.includes(String(error.code))

const touch = async (path: string, seconds: number): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await utimes(path, seconds, seconds)
      return
    } catch (error) {
      if (!isBusy(error) || attempt === busyAttempts) {
        throw error
      }
      await sleep(busyRetryMs)
    }
  }
}

const stepLabel = (index: number): string => `contract-step-${String(index)}`

const stepwise = (manifest: LoadedManifest): LoadedManifest => ({
  ...manifest,
  steps: manifest.steps.map((step, index) => ({ ...step, label: stepLabel(index) })),
})

const collectedGap = ({ key, stream, details, detected_at, closed_at }: Gap): CollectedGap => ({
  key,
  stream,
  details,
  detected_at,
  closed_at,
})

const collectedAs = ({ root, path }: Target): Collected => {
  const segments = path.split('/')
  const [top] = segments
  const name = segments.at(-1) ?? ''
  if (root === 'codex') {
    return (top === 'sessions' || top === 'archived_sessions') && name.endsWith('.jsonl') ? 'tail' : null
  }
  if (root !== 'claude') {
    return null
  }
  if (top === 'sessions') {
    return segments.length === 2 && name.endsWith('.json') ? 'snapshot' : null
  }
  if (top === 'teams') {
    return segments.length === 3 && name === 'config.json' ? 'snapshot' : null
  }
  if (top !== 'projects' || segments.slice(3, -1).includes('tool-results')) {
    return null
  }
  if (name.endsWith('.jsonl') || path.includes('.jsonl.superseded-')) {
    return 'tail'
  }
  const workflow = name.endsWith('.json') && segments.at(-2) === 'workflows'
  return name.endsWith('.meta.json') || workflow ? 'snapshot' : null
}

const createRoots = async (): Promise<PlaybackRoots> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aang-contract-')))
  const home = join(base, 'home')
  const roots = { base, home, claude: join(home, '.claude'), codex: join(home, '.codex') }
  await Promise.all([roots.claude, roots.codex].map((directory) => mkdir(directory, { recursive: true })))
  return roots
}

export const removeRoots = (roots: PlaybackRoots): Promise<void> =>
  rm(roots.base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const namesIn = async (directory: string): Promise<string[]> => {
  try {
    return await readdir(directory)
  } catch (error) {
    if (isMissing(error)) {
      return []
    }
    throw error
  }
}

const sizeOf = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

const hashOf = async (path: string): Promise<string | null> => {
  try {
    return contentHash(await readFile(path))
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

const observe = (observed: Observed, batch: CollectorBatch): void => {
  for (const cursor of batch.cursors) {
    observed.offsets.set(cursor.path, cursor.offset)
    if (cursor.stream !== null) {
      observed.streams.set(cursor.path, cursor.stream)
    }
  }
  for (const { position } of batch.records) {
    if (position.kind === 'line' && position.offset === 0) {
      observed.reads.set(position.path, (observed.reads.get(position.path) ?? 0) + 1)
    } else if (position.kind === 'otel') {
      observed.otel += 1
    } else if (position.kind === 'file') {
      observed.files.set(position.path, position.content_hash)
    } else if (position.kind === 'file_removed') {
      observed.files.set(position.path, null)
    }
  }
  for (const gap of batch.gaps) {
    if (gap.key.gap === 'source_lost' && gap.stream !== null) {
      if (gap.closed_at === null) {
        observed.lost.add(gap.stream)
      } else {
        observed.lost.delete(gap.stream)
      }
    }
  }
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const members = (value: unknown, key: string): unknown[] => {
  const member = isObject(value) ? value[key] : undefined
  return Array.isArray(member) ? member : []
}

const isToolDecision = (logRecord: unknown): boolean =>
  members(logRecord, 'attributes').some(
    (attribute) => isObject(attribute) && attribute.key === 'event.name' && isObject(attribute.value) && attribute.value.stringValue === toolDecisionEvent,
  )

const toolDecisions = (body: Buffer | undefined): number => {
  const request: unknown = body === undefined ? null : JSON.parse(body.toString('utf8'))
  return members(request, 'resourceLogs')
    .flatMap((resourceLog) => members(resourceLog, 'scopeLogs'))
    .flatMap((scopeLog) => members(scopeLog, 'logRecords'))
    .filter(isToolDecision).length
}

const stepName = (index: number, step: PlayerStep): string =>
  `step ${String(index)} (${step.kind}${'target' in step ? ` ${step.target.root}/${step.target.path}` : ''})`

export const playRecording = async (manifest: LoadedManifest, options: PlayOptions): Promise<Played> => {
  const roots = await createRoots()
  const spool = join(roots.base, 'spool')
  const ready = join(spool, spoolLayout.readyDirectory)
  await leaseSpool(spool)
  const observed: Observed = { otel: 0, reads: new Map(), offsets: new Map(), streams: new Map(), files: new Map(), lost: new Set() }
  const state = { failure: null as Error | null }
  const startsAt = options.startsAt ?? Date.now()
  const shift = playbackShift(manifest.sources.values(), startsAt)
  const shiftNs = BigInt(shift.to === 0 ? wholeSeconds(startsAt - options.recorded.startedAt) : shift.ms) * nanosecondsPerMs
  const stepTime = (step: PlayerStep): bigint => BigInt(options.recorded.startedAt + step.at) * nanosecondsPerMs + shiftNs
  const modifiedAt = (step: PlayerStep): bigint => {
    const recorded = 'source' in step ? options.recorded.mtimes.get(step.source) : undefined
    return recorded === undefined ? stepTime(step) : recorded + shiftNs
  }
  const clock = { now: EpochNs.parse(manifest.steps[0] === undefined ? BigInt(startsAt) * nanosecondsPerMs : stepTime(manifest.steps[0])) }

  const startIngestion = (): Ingestion => {
    const store = openStore({ home: join(roots.base, 'aang') })
    const engine = createEngine({ store, adapters, watch: { all: true, roots: [] }, now: () => clock.now })
    const collector = createCollector({
      spool,
      runtimeRoots: { claude: roots.claude, codex: roots.codex },
      config: Config.parse({ collector: { spoolScanIntervalMs: scanIntervalMs, rootsScanIntervalMs: scanIntervalMs } }),
      adapters,
      openGaps: store.gaps.open('source_lost').map(collectedGap),
    })
    const loop = (async () => {
      for await (const batch of collector.start(store.cursors.list())) {
        const { settled, rescan } = await engine.ingest(batch)
        for (const acknowledged of settled) {
          await collector.ack(acknowledged)
        }
        if (rescan.length > 0) {
          collector.rescan(rescan)
        }
        observe(observed, batch)
      }
    })().catch((error: unknown) => {
      state.failure = error instanceof Error ? error : new Error(String(error))
    })
    let stopping: Promise<void> | null = null
    let closed = false
    const stop = (): Promise<void> => (stopping ??= collector.close().then(() => loop))
    const close = async (): Promise<void> => {
      await stop()
      if (!closed) {
        closed = true
        store.close()
      }
    }
    return { store, collector, stop, close }
  }

  const pathOf = (target: Target): string => join(roots[target.root], ...target.path.split('/'))

  const emptyDirectory = async (directory: string, matches: (name: string) => boolean): Promise<boolean> =>
    (await namesIn(directory)).every((name) => !matches(name))

  const reread = (path: string, stream: string, before: Before): boolean =>
    [...observed.streams].some(
      ([other, otherStream]) => other !== path && otherStream === stream && (observed.reads.get(other) ?? 0) > (before.reads.get(other) ?? 0),
    )

  const reflected = async (target: Target, removed: boolean, before: Before): Promise<boolean> => {
    const path = pathOf(target)
    switch (collectedAs(target)) {
      case 'tail': {
        if (removed) {
          const stream = observed.streams.get(path)
          return stream === undefined || observed.lost.has(stream) || reread(path, stream, before)
        }
        return observed.offsets.get(path) === (await sizeOf(path))
      }
      case 'snapshot':
        return (observed.files.get(path) ?? null) === (removed ? null : await hashOf(path))
      case null:
        return true
    }
  }

  const settled = async (step: PlayerStep, before: Before): Promise<boolean> => {
    switch (step.kind) {
      case 'hook':
        return emptyDirectory(join(spool, spoolLayout.readyDirectory), () => true)
      case 'otlp':
        return (
          observed.otel >= before.otel + toolDecisions(manifest.sources.get(step.source)) &&
          emptyDirectory(join(spool, otelDirectory), (name) => name.endsWith('.json'))
        )
      case 'append':
      case 'write':
        return reflected(step.target, false, before)
      case 'remove':
        return reflected(step.target, true, before)
      case 'move':
        return (await reflected(step.target, true, before)) && (await reflected(step.to, false, before))
      case 'archive':
        return reflected({ root: 'codex', path: `archived_sessions/${basename(step.target.path)}` }, false, before)
    }
  }

  const awaitStep = async (index: number, step: PlayerStep, before: Before): Promise<void> => {
    const deadline = performance.now() + (options.stepTimeoutMs ?? defaultStepTimeoutMs)
    for (;;) {
      if (state.failure !== null) {
        throw state.failure
      }
      if (await settled(step, before)) {
        return
      }
      if (performance.now() > deadline) {
        throw new Error(`${manifest.file}: the collector did not reflect ${stepName(index, step)}`)
      }
      await sleep(pollMs)
    }
  }

  const retime = async (step: PlayerStep, spooled: ReadonlySet<string>): Promise<void> => {
    const seconds = Number(modifiedAt(step)) / nanosecondsPerSecond
    switch (step.kind) {
      case 'hook':
        await Promise.all((await namesIn(ready)).filter((name) => !spooled.has(name)).map((name) => touch(join(ready, name), seconds)))
        return
      case 'append':
      case 'write':
        await touch(pathOf(step.target), seconds)
        return
      case 'remove':
      case 'move':
      case 'archive':
      case 'otlp':
        return
    }
  }

  let ingestion = startIngestion()
  let restarts = 0
  let failure: Error | null = null
  try {
    const listener = await ingestion.collector.listenOtel({ port: 0, token: otelToken })
    const player = createPlayer(stepwise(manifest), {
      roots,
      hook: { binary: options.hookBinary, spool },
      otlp: `http://${listener.host}:${String(listener.port)}/otel/${otelToken}/v1/logs`,
      timeScale: 0,
      recordTime: { startsAt },
    })
    for (const [index, step] of manifest.steps.entries()) {
      const next = index + 1
      const before: Before = { otel: observed.otel, reads: new Map(observed.reads) }
      clock.now = EpochNs.parse(stepTime(step) > clock.now ? stepTime(step) : clock.now)
      await ingestion.collector.paused(async () => {
        const spooled = new Set(await namesIn(ready))
        await player.play(next < manifest.steps.length ? { until: stepLabel(next) } : {})
        await retime(step, spooled)
      })
      await awaitStep(index, step, before)
      if (step.label === restartLabel) {
        await ingestion.close()
        ingestion = startIngestion()
        await ingestion.collector.listenOtel({ port: listener.port, token: otelToken })
        restarts += 1
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  }
  await ingestion.stop()
  failure ??= state.failure
  if (failure !== null) {
    await ingestion.close()
    await removeRoots(roots)
    throw failure
  }
  return { store: ingestion.store, roots, restarts, shift }
}
