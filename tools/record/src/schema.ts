import {
  AttentionAuthor,
  AttentionKind,
  AttentionResolution,
  compilePattern,
  CriterionStatus,
  ExecutionState,
  OperatingSystem,
  Runtime,
  Surface,
} from '@aang/contract'
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

const compiles = (source: string): boolean => {
  try {
    compilePattern(source)
    return true
  } catch {
    return false
  }
}

const MapPattern = z.string().min(1).refine(compiles, 'invalid regular expression')

const EventEvidence = z.literal('event')

const someOf = <T extends z.ZodType>(item: T) => z.array(item).min(1)

export const StageLifecycleState = z.enum(['active', 'replaced', 'merged', 'split'])
export type StageLifecycleState = z.infer<typeof StageLifecycleState>

export const LinkKind = z.enum(['spawn', 'forked_from', 'common_origin', 'participation', 'assignment', 'artifact', 'dependency'])
export type LinkKind = z.infer<typeof LinkKind>

export const StagePredicate = z.strictObject({
  title: MapPattern.optional(),
  lifecycle: someOf(StageLifecycleState).optional(),
  execution: someOf(ExecutionState).optional(),
  output: MapPattern.optional(),
  evidence: EventEvidence.optional(),
})
export type StagePredicate = z.infer<typeof StagePredicate>

export const CriterionPredicate = z.strictObject({
  text: MapPattern.optional(),
  status: someOf(CriterionStatus).optional(),
  evidence: EventEvidence.optional(),
})
export type CriterionPredicate = z.infer<typeof CriterionPredicate>

export const AttentionPredicate = z.strictObject({
  kind: someOf(AttentionKind).optional(),
  author: someOf(AttentionAuthor).optional(),
  resolution: someOf(AttentionResolution).optional(),
  text: MapPattern.optional(),
  evidence: EventEvidence.optional(),
})
export type AttentionPredicate = z.infer<typeof AttentionPredicate>

export const CardPredicate = z.strictObject({
  text: MapPattern.optional(),
  evidence: EventEvidence.optional(),
})
export type CardPredicate = z.infer<typeof CardPredicate>

export const LinkPredicate = z.strictObject({
  kind: someOf(LinkKind).optional(),
  evidence: EventEvidence.optional(),
})
export type LinkPredicate = z.infer<typeof LinkPredicate>

export type MapPredicate =
  | { readonly stage: StagePredicate }
  | { readonly criterion: CriterionPredicate }
  | { readonly attention: AttentionPredicate }
  | { readonly card: CardPredicate }
  | { readonly link: LinkPredicate }
  | { readonly brief: string }
  | { readonly all: readonly MapPredicate[] }
  | { readonly any: readonly MapPredicate[] }

export const MapPredicate: z.ZodType<MapPredicate> = z.lazy(() =>
  z.union([
    z.strictObject({ stage: StagePredicate }),
    z.strictObject({ criterion: CriterionPredicate }),
    z.strictObject({ attention: AttentionPredicate }),
    z.strictObject({ card: CardPredicate }),
    z.strictObject({ link: LinkPredicate }),
    z.strictObject({ brief: MapPattern }),
    z.strictObject({ all: someOf(MapPredicate) }),
    z.strictObject({ any: someOf(MapPredicate) }),
  ]),
)

export const ExpectedMapChange = z.strictObject({
  description: z.string().min(1),
  predicate: MapPredicate.optional(),
})
export type ExpectedMapChange = z.infer<typeof ExpectedMapChange>

export const ControlEvent = z.strictObject({
  label: z.string().min(1),
  step: z.int().nonnegative(),
  observed_at: z.iso.datetime(),
  expected_map_change: ExpectedMapChange,
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
