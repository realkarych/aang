import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChangeAuthor, ObserverCallId, RunId, Runtime } from '@aang/contract'
import { z } from 'zod'
import {
  type AnnotatedEvent,
  json,
  type MeasuredCall,
  type MeasuredEvent,
  type Measurement,
  measurementFiles,
  readAnnotations,
  readFixed,
  readMeasurement,
  type StateSample,
} from './files.js'
import { renderReport } from './markdown.js'
import { type FixedProfile, observerOf, RecordingPath } from './profile.js'

export const EventStatus = z.enum(['met', 'late', 'missed', 'unmatched', 'held_before', 'unassessed'])
export type EventStatus = z.infer<typeof EventStatus>

const count = z.int().nonnegative()
const share = z.number().min(0).max(1)

export const ReportedEvent = z.strictObject({
  recording: RecordingPath,
  label: z.string().min(1),
  runtime: Runtime,
  description: z.string().min(1),
  method: z.enum(['predicate', 'annotation']),
  status: EventStatus,
  latency_ms: z.int().nullable(),
  full_latency_ms: z.int().nullable(),
  needs_ms: count.nullable(),
  run: RunId.nullable(),
  version: count.nullable(),
  author: ChangeAuthor.nullable(),
  observer_call: ObserverCallId.nullable(),
})
export type ReportedEvent = z.infer<typeof ReportedEvent>

export const Percentile = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('latency'), ms: z.int() }),
  z.strictObject({ kind: z.literal('violation') }),
])
export type Percentile = z.infer<typeof Percentile>

export const StateShare = z.strictObject({ state: z.string().min(1), ms: count, share })
export type StateShare = z.infer<typeof StateShare>

export const BackendReport = z.strictObject({
  runtime: Runtime,
  cli_version: z.string().nullable(),
  model: z.string(),
  effort: z.string().nullable(),
  target_p95_ms: z.int().positive(),
  events: count,
  assessed: count,
  met: count,
  violations: count,
  unassessed: count,
  held_before: count,
  within_target: share.nullable(),
  p95: Percentile.nullable(),
  target_met: z.boolean().nullable(),
  full_latency: z.strictObject({ events: count, p95_ms: z.int().nullable() }),
  needs: z.strictObject({ events: count, ms: count, share: share.nullable() }),
  calls: z.strictObject({ total: count, accepted: count, rejected: count, failed: count, with_needs: count }),
  states: z.array(StateShare),
})
export type BackendReport = z.infer<typeof BackendReport>

export const Report = z.strictObject({
  format: z.literal('aang-freshness-report/1'),
  profile: z.string().min(1),
  fixed_at: z.iso.datetime(),
  measured_at: z.iso.datetime(),
  duration_ms: count,
  window_ms: z.int().positive(),
  time_scale: z.number().positive(),
  daemon_version: z.string(),
  recordings: z.array(z.strictObject({ recording: RecordingPath, runtime: Runtime, start_ms: count })),
  backends: z.array(BackendReport),
  events: z.array(ReportedEvent),
})
export type Report = z.infer<typeof Report>

const violations: ReadonlySet<EventStatus> = new Set(['late', 'missed', 'unmatched'])
const assessed: ReadonlySet<EventStatus> = new Set(['met', 'late', 'missed', 'unmatched'])

interface Reached {
  readonly run: RunId
  readonly version: number
  readonly at: number
  readonly author: ChangeAuthor
  readonly observer_call: ObserverCallId | null
}

const nearestRank = (values: readonly number[]): number | undefined =>
  values.toSorted((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]

const annotated = (event: MeasuredEvent, annotation: AnnotatedEvent | undefined): Reached | 'missed' | null => {
  const verdict = annotation?.verdict ?? null
  if (verdict === null || event.evaluation.kind !== 'annotation') {
    return null
  }
  if (!verdict.met) {
    return 'missed'
  }
  const candidate = event.evaluation.candidates.find(({ run, version }) => run === verdict.run && version === verdict.version)
  if (candidate === undefined) {
    throw new Error(
      `the annotation of ${event.recording} ${event.label} names version ${String(verdict.version)} of ${verdict.run}, which is not among its candidates`,
    )
  }
  return candidate
}

const reportEvent = (
  event: MeasuredEvent,
  annotation: AnnotatedEvent | undefined,
  calls: readonly MeasuredCall[],
  windowMs: number,
): ReportedEvent => {
  const { evaluation } = event
  const reached = evaluation.kind === 'satisfied' ? evaluation : annotated(event, annotation)
  const latency = reached === null || reached === 'missed' || event.observed_at === null ? null : reached.at - event.observed_at
  const status: EventStatus =
    evaluation.kind === 'unmatched'
      ? 'unmatched'
      : evaluation.kind === 'held_before'
        ? 'held_before'
        : evaluation.kind === 'unsatisfied' || reached === 'missed'
          ? 'missed'
          : latency === null
            ? 'unassessed'
            : latency <= windowMs
              ? 'met'
              : 'late'
  const found = reached === null || reached === 'missed' ? null : reached
  const call = found?.observer_call ?? null
  return {
    recording: event.recording,
    label: event.label,
    runtime: event.runtime,
    description: event.description,
    method: event.predicate === null ? 'annotation' : 'predicate',
    status,
    latency_ms: latency,
    full_latency_ms: found === null || event.source_at === null ? null : found.at - event.source_at,
    needs_ms: found === null ? null : (calls.find(({ id }) => id === call)?.needs_latency_ms ?? 0),
    run: found?.run ?? (evaluation.kind === 'held_before' ? evaluation.run : null),
    version: found?.version ?? (evaluation.kind === 'held_before' ? evaluation.version : null),
    author: found?.author ?? null,
    observer_call: call,
  }
}

const stateLabel = ({ state }: StateSample): string =>
  'reason' in state ? `${state.state}:${state.reason}` : state.state

const stateShares = (samples: readonly StateSample[], endedAt: number): StateShare[] => {
  const durations = new Map<string, number>()
  for (const run of Map.groupBy(samples, ({ run: id }) => id).values()) {
    run.forEach((sample, index) => {
      const label = stateLabel(sample)
      durations.set(label, (durations.get(label) ?? 0) + (run[index + 1]?.at ?? endedAt) - sample.at)
    })
  }
  const total = [...durations.values()].reduce((sum, ms) => sum + ms, 0)
  return [...durations]
    .map(([state, ms]) => ({ state, ms, share: total === 0 ? 0 : ms / total }))
    .toSorted((left, right) => right.ms - left.ms)
}

const backendReport = (
  measurement: Measurement,
  fixed: FixedProfile,
  events: readonly ReportedEvent[],
  backend: Measurement['backends'][number],
): BackendReport => {
  const { vendor: runtime } = backend
  const target = observerOf(fixed.profile, runtime).target_p95_ms
  const own = events.filter((event) => event.runtime === runtime)
  const judged = own.filter(({ status }) => assessed.has(status))
  const reached = own.filter(({ latency_ms: latency }) => latency !== null)
  const ranked = nearestRank(judged.map(({ status, latency_ms: latency }) => (latency === null || status === 'missed' ? Infinity : latency)))
  const p95: Percentile | null =
    ranked === undefined ? null : Number.isFinite(ranked) ? { kind: 'latency', ms: ranked } : { kind: 'violation' }
  const full = own.flatMap(({ full_latency_ms: latency }) => (latency === null ? [] : [latency]))
  const needs = reached.reduce((sum, { needs_ms: ms }) => sum + (ms ?? 0), 0)
  const total = reached.reduce((sum, { latency_ms: latency }) => sum + (latency ?? 0), 0)
  const calls = measurement.calls.filter((call) => call.runtime === runtime)
  return {
    runtime,
    cli_version: backend.cli_version,
    model: backend.model,
    effort: backend.effort,
    target_p95_ms: target,
    events: own.length,
    assessed: judged.length,
    met: own.filter(({ status }) => status === 'met').length,
    violations: own.filter(({ status }) => violations.has(status)).length,
    unassessed: own.filter(({ status }) => status === 'unassessed').length,
    held_before: own.filter(({ status }) => status === 'held_before').length,
    within_target:
      judged.length === 0
        ? null
        : judged.filter(({ status, latency_ms: latency }) => status === 'met' && latency !== null && latency <= target).length /
          judged.length,
    p95,
    target_met: p95 === null ? null : p95.kind === 'latency' && p95.ms <= target,
    full_latency: { events: full.length, p95_ms: nearestRank(full) ?? null },
    needs: {
      events: reached.filter(({ needs_ms: ms }) => (ms ?? 0) > 0).length,
      ms: needs,
      share: total === 0 ? null : Math.min(1, needs / total),
    },
    calls: {
      total: calls.length,
      accepted: calls.filter(({ outcome }) => outcome === 'accepted').length,
      rejected: calls.filter(({ outcome }) => outcome === 'rejected').length,
      failed: calls.filter(({ outcome }) => outcome === 'failed').length,
      with_needs: calls.filter(({ needs_latency_ms: ms }) => ms !== null).length,
    },
    states: stateShares(
      measurement.states.filter((sample) => sample.runtime === runtime),
      measurement.ended_at,
    ),
  }
}

export const buildReport = (fixed: FixedProfile, measurement: Measurement, annotations: readonly AnnotatedEvent[]): Report => {
  const keyOf = ({ recording, label }: { readonly recording: string; readonly label: string }): string => `${recording}\0${label}`
  const measured = new Map(measurement.events.map((event) => [keyOf(event), event]))
  for (const annotation of annotations) {
    if (measured.get(keyOf(annotation))?.evaluation.kind !== 'annotation') {
      throw new Error(`the annotation of ${annotation.recording} ${annotation.label} matches no annotated event of the measurement`)
    }
  }
  const byKey = new Map(annotations.map((annotation) => [keyOf(annotation), annotation]))
  const events = measurement.events.map((event) =>
    reportEvent(event, byKey.get(keyOf(event)), measurement.calls, fixed.profile.window_ms),
  )
  return {
    format: 'aang-freshness-report/1',
    profile: fixed.profile.name,
    fixed_at: fixed.fixed_at,
    measured_at: new Date(measurement.started_at).toISOString(),
    duration_ms: measurement.ended_at - measurement.started_at,
    window_ms: fixed.profile.window_ms,
    time_scale: fixed.profile.time_scale,
    daemon_version: measurement.daemon_version,
    recordings: measurement.recordings.map(({ recording, runtime, started_at: started }) => ({
      recording,
      runtime,
      start_ms: started - measurement.started_at,
    })),
    backends: measurement.backends.map((backend) => backendReport(measurement, fixed, events, backend)),
    events,
  }
}

export const writeReport = async (directory: string): Promise<Report> => {
  const { fixed, digest } = await readFixed(directory)
  const measurement = await readMeasurement(directory)
  if (measurement.profile_digest !== digest) {
    throw new Error(`${join(directory, measurementFiles.measurement)} was measured with another profile`)
  }
  const { events } = await readAnnotations(directory)
  const report = buildReport(fixed, measurement, events)
  await writeFile(join(directory, measurementFiles.report), json(report))
  await writeFile(join(directory, measurementFiles.summary), renderReport(report))
  return report
}
