import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { RegistrationTag, Runtime } from '@aang/contract'
import { z } from 'zod'

export const PlayerRoot = z.enum(['home', 'claude', 'codex'])
export type PlayerRoot = z.infer<typeof PlayerRoot>

const pathSegment = /^(?!\.{1,2}$)[^/\\\0:]+$/

const insideRoot = (path: string): boolean => path.split('/').every((segment) => pathSegment.test(segment))

const RootPath = z.string().refine(insideRoot, 'must be a relative path with / separators that stays inside its root')

export const Target = z.strictObject({ root: PlayerRoot, path: RootPath })
export type Target = z.infer<typeof Target>

const SourcePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.includes('\\') && !/^[A-Za-z]:/.test(path), {
    message: 'must be a path relative to the manifest with / separators',
  })

const timing = {
  at: z.number().nonnegative(),
  label: z.string().min(1).optional(),
}

export const AppendStep = z.strictObject({
  ...timing,
  kind: z.literal('append'),
  target: Target,
  source: SourcePath,
  lines: z.int().positive().optional(),
  bytes: z.int().positive().optional(),
})
export type AppendStep = z.infer<typeof AppendStep>

export const WriteStep = z.strictObject({ ...timing, kind: z.literal('write'), target: Target, source: SourcePath })
export type WriteStep = z.infer<typeof WriteStep>

export const RemoveStep = z.strictObject({ ...timing, kind: z.literal('remove'), target: Target })
export type RemoveStep = z.infer<typeof RemoveStep>

export const MoveStep = z.strictObject({ ...timing, kind: z.literal('move'), target: Target, to: Target })
export type MoveStep = z.infer<typeof MoveStep>

export const codexSessionsDirectory = 'sessions'
export const codexArchiveDirectory = 'archived_sessions'

export const ArchiveStep = z.strictObject({
  ...timing,
  kind: z.literal('archive'),
  target: z.strictObject({
    root: z.literal('codex'),
    path: RootPath.refine((path) => path.startsWith(`${codexSessionsDirectory}/`), {
      message: `must be a rollout under ${codexSessionsDirectory}/`,
    }),
  }),
})
export type ArchiveStep = z.infer<typeof ArchiveStep>

export const HookStep = z.strictObject({
  ...timing,
  kind: z.literal('hook'),
  runtime: Runtime,
  registration: RegistrationTag,
  env: z.record(z.string().min(1), z.string()).default({}),
  source: SourcePath,
})
export type HookStep = z.infer<typeof HookStep>

export const OtlpStep = z.strictObject({ ...timing, kind: z.literal('otlp'), source: SourcePath })
export type OtlpStep = z.infer<typeof OtlpStep>

export const PlayerStep = z.discriminatedUnion('kind', [
  AppendStep,
  WriteStep,
  RemoveStep,
  MoveStep,
  ArchiveStep,
  HookStep,
  OtlpStep,
])
export type PlayerStep = z.infer<typeof PlayerStep>

export const PlayerManifest = z.strictObject({ steps: z.array(PlayerStep) }).superRefine(({ steps }, context) => {
  const labels = new Set<string>()
  steps.forEach((step, index) => {
    const previous = steps[index - 1]
    if (previous !== undefined && step.at < previous.at) {
      context.addIssue({ code: 'custom', path: ['steps', index, 'at'], message: 'steps must be ordered by time' })
    }
    if (step.label !== undefined) {
      if (labels.has(step.label)) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'label'], message: 'labels must be unique' })
      }
      labels.add(step.label)
    }
    if (step.kind === 'append' && step.lines !== undefined && step.bytes !== undefined) {
      context.addIssue({ code: 'custom', path: ['steps', index], message: 'lines and bytes are exclusive' })
    }
  })
})
export type PlayerManifest = z.infer<typeof PlayerManifest>

export interface LoadedManifest {
  readonly file: string
  readonly steps: readonly PlayerStep[]
  readonly sources: ReadonlyMap<string, Buffer>
}

export class ManifestError extends Error {
  override readonly name = 'ManifestError'
}

const sourcesOf = (steps: readonly PlayerStep[]): string[] => [
  ...new Set(steps.flatMap((step) => ('source' in step ? [step.source] : []))),
]

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const readSource = async (directory: string, source: string, file: string): Promise<Buffer> => {
  try {
    return await readFile(resolve(directory, ...source.split('/')))
  } catch (error) {
    throw new ManifestError(`${file}: cannot read source ${source}: ${reason(error)}`)
  }
}

const readDocument = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new ManifestError(`${file}: ${reason(error)}`)
  }
}

export const loadManifest = async (file: string): Promise<LoadedManifest> => {
  const parsed = PlayerManifest.safeParse(await readDocument(file))
  if (!parsed.success) {
    throw new ManifestError(`${file}: ${z.prettifyError(parsed.error)}`)
  }
  const { steps } = parsed.data
  const directory = dirname(file)
  const sources = new Map(
    await Promise.all(
      sourcesOf(steps).map(async (source): Promise<[string, Buffer]> => [
        source,
        await readSource(directory, source, file),
      ]),
    ),
  )
  return { file, steps, sources }
}
