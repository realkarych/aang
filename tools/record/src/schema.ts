import { OperatingSystem, Runtime, Surface } from '@aang/contract'
import { PlayerManifest } from '@aang/testkit'
import { z } from 'zod'

export const Segment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((value) => !value.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))

export const ModelMode = z.enum(['stub', 'live'])
export type ModelMode = z.infer<typeof ModelMode>

export const ProfileHome = z.enum(['isolated', 'regular'])
export type ProfileHome = z.infer<typeof ProfileHome>

export const RecordMetadata = z.strictObject({
  runtime: Runtime,
  engineVersion: Segment,
  appVersion: z.string().min(1).optional(),
  surface: Surface,
  scenario: Segment,
  model: ModelMode.optional(),
  expectedFacts: z.array(z.string().min(1)).min(1),
}).refine((value) => value.surface.startsWith(`${value.runtime}_`), 'surface must match runtime')

export const Artifact = z.strictObject({
  source: z.string().regex(/^(data|spool|output)\/[0-9]+\.(jsonl|json|spool|txt|toml)$/),
  observed_at: z.iso.datetime(),
  mtime_ns: z.string().regex(/^[0-9]+$/),
})
export type Artifact = z.infer<typeof Artifact>

export const ControlEvent = z.strictObject({
  label: z.string().min(1),
  step: z.int().nonnegative(),
  observed_at: z.iso.datetime(),
  expected_map_change: z.strictObject({ description: z.string().min(1) }),
})
export type ControlEvent = z.infer<typeof ControlEvent>

export const RecordingManifest = z.strictObject({
  format: z.literal('aang-recording/1'),
  runtime: Runtime,
  engine_version: Segment,
  app_version: z.string().min(1).nullable(),
  surface: Surface,
  os: OperatingSystem,
  scenario: Segment,
  model: ModelMode.nullable(),
  recorded_at: z.iso.datetime(),
  expected_facts: z.array(z.string().min(1)).min(1),
  control_events: z.array(ControlEvent),
  artifacts: z.array(Artifact),
  playback: z.literal('playback.json'),
})
export type RecordingManifest = z.infer<typeof RecordingManifest>

export const recordingOs = (): z.infer<typeof OperatingSystem> => {
  switch (process.platform) {
    case 'darwin': return 'macos'
    case 'linux': return 'linux'
    case 'win32': return 'windows'
    default: throw new Error(`Unsupported recording OS: ${process.platform}`)
  }
}

export const validateReferences = (manifest: RecordingManifest, playback: unknown): void => {
  const { steps } = PlayerManifest.parse(playback)
  const sources = new Set(manifest.artifacts.map((artifact) => artifact.source))
  if (sources.size !== manifest.artifacts.length) {
    throw new Error('Duplicate recording artifact')
  }
  for (const step of steps) {
    if ('source' in step && !sources.has(step.source)) {
      throw new Error('Playback references an unlisted artifact')
    }
  }
  const labels = new Set<string>()
  for (const event of manifest.control_events) {
    const step = steps[event.step]
    if (labels.has(event.label) || step?.label !== event.label ||
      Date.parse(event.observed_at) !== Date.parse(manifest.recorded_at) + step.at) {
      throw new Error('Invalid control event reference or timestamp')
    }
    labels.add(event.label)
  }
}
