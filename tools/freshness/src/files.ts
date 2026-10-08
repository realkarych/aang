import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AdmissionOutcome,
  ChangeAuthor,
  ObserverCallId,
  ObserverCallOutcome,
  ObserverState,
  RunId,
  Runtime,
} from '@aang/contract'
import { MapPredicate } from '@aang/record'
import { z } from 'zod'
import { Digest, FixedProfile, RecordingPath } from './profile.js'

export const measurementFiles = {
  profile: 'profile.json',
  measurement: 'measurement.json',
  annotations: 'annotations.json',
  report: 'report.json',
  summary: 'report.md',
  home: 'home',
  aang: 'aang',
} as const

const epochMs = z.int().nonnegative()
const version = z.int().nonnegative()

export const Candidate = z.strictObject({
  run: RunId,
  version,
  at: epochMs,
  after_ms: z.int(),
  author: ChangeAuthor,
  observer_call: ObserverCallId.nullable(),
  changes: z.array(z.string()),
})
export type Candidate = z.infer<typeof Candidate>

export const Evaluation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unmatched') }),
  z.strictObject({ kind: z.literal('held_before'), run: RunId, version }),
  z.strictObject({
    kind: z.literal('satisfied'),
    run: RunId,
    version,
    at: epochMs,
    author: ChangeAuthor,
    observer_call: ObserverCallId.nullable(),
  }),
  z.strictObject({ kind: z.literal('unsatisfied') }),
  z.strictObject({ kind: z.literal('annotation'), candidates: z.array(Candidate) }),
])
export type Evaluation = z.infer<typeof Evaluation>

export const MeasuredEvent = z.strictObject({
  recording: RecordingPath,
  runtime: Runtime,
  label: z.string().min(1),
  description: z.string().min(1),
  predicate: MapPredicate.nullable(),
  played_at: epochMs,
  observed_at: epochMs.nullable(),
  source_at: epochMs.nullable(),
  runs: z.array(RunId),
  evaluation: Evaluation,
})
export type MeasuredEvent = z.infer<typeof MeasuredEvent>

export const MeasuredCall = z.strictObject({
  id: ObserverCallId,
  run: RunId,
  runtime: Runtime,
  outcome: ObserverCallOutcome,
  result_version: version.nullable(),
  started_at: epochMs,
  ended_at: epochMs.nullable(),
  latency_ms: z.int().nonnegative().nullable(),
  needs_latency_ms: z.int().nonnegative().nullable(),
})
export type MeasuredCall = z.infer<typeof MeasuredCall>

export const StateSample = z.strictObject({
  at: epochMs,
  run: RunId,
  runtime: Runtime,
  state: ObserverState,
  pending_facts: z.int().nonnegative(),
})
export type StateSample = z.infer<typeof StateSample>

export const MeasuredBackend = z.strictObject({
  vendor: Runtime,
  cli_version: z.string().nullable(),
  model: z.string(),
  effort: z.string().nullable(),
  admission: AdmissionOutcome,
})
export type MeasuredBackend = z.infer<typeof MeasuredBackend>

export const PlayedRecording = z.strictObject({
  recording: RecordingPath,
  runtime: Runtime,
  started_at: epochMs,
  finished_at: epochMs,
})
export type PlayedRecording = z.infer<typeof PlayedRecording>

export const Measurement = z.strictObject({
  format: z.literal('aang-freshness-measurement/1'),
  profile_digest: Digest,
  daemon_version: z.string(),
  started_at: epochMs,
  ended_at: epochMs,
  backends: z.array(MeasuredBackend),
  recordings: z.array(PlayedRecording),
  events: z.array(MeasuredEvent),
  calls: z.array(MeasuredCall),
  states: z.array(StateSample),
})
export type Measurement = z.infer<typeof Measurement>

export const Verdict = z.union([
  z.strictObject({ met: z.literal(false) }),
  z.strictObject({ met: z.literal(true), run: RunId, version }),
])
export type Verdict = z.infer<typeof Verdict>

export const AnnotatedEvent = z.strictObject({
  recording: RecordingPath,
  label: z.string().min(1),
  description: z.string().min(1),
  candidates: z.array(Candidate),
  verdict: Verdict.nullable(),
})
export type AnnotatedEvent = z.infer<typeof AnnotatedEvent>

export const Annotations = z.strictObject({
  format: z.literal('aang-freshness-annotations/1'),
  events: z.array(AnnotatedEvent),
})
export type Annotations = z.infer<typeof Annotations>

export const parseJson = <T extends z.ZodType>(schema: T, path: string, text: string): z.output<T> => {
  const parsed = schema.safeParse(JSON.parse(text))
  if (!parsed.success) {
    throw new Error(`${path}: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

const readJson = async <T extends z.ZodType>(schema: T, path: string): Promise<z.output<T>> =>
  parseJson(schema, path, await readFile(path, 'utf8'))

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

export interface Fixed {
  readonly fixed: FixedProfile
  readonly digest: string
}

export const readFixed = async (directory: string): Promise<Fixed> => {
  const path = join(directory, measurementFiles.profile)
  const text = await readFile(path, 'utf8')
  return { fixed: parseJson(FixedProfile, path, text), digest: createHash('sha256').update(text).digest('hex') }
}

export const readMeasurement = (directory: string): Promise<Measurement> =>
  readJson(Measurement, join(directory, measurementFiles.measurement))

export const readAnnotations = (directory: string): Promise<Annotations> =>
  readJson(Annotations, join(directory, measurementFiles.annotations))

export const createOnce = async (create: () => Promise<unknown>, existing: string): Promise<void> => {
  try {
    await create()
  } catch (error) {
    throw error instanceof Error && 'code' in error && error.code === 'EEXIST' ? new Error(existing, { cause: error }) : error
  }
}

export const writeNew = (path: string, value: unknown): Promise<void> =>
  createOnce(() => writeFile(path, json(value), { flag: 'wx' }), `${path} already exists`)
