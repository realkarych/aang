import { isAbsolute } from 'node:path'
import { Runtime } from '@aang/contract'
import { z } from 'zod'

const positiveMs = z.int().positive()

const segment = /^(?!\.{1,2}$)[^/\\\0:]+$/

export const RecordingPath = z
  .string()
  .refine((path) => path.split('/').every((part) => segment.test(part)), 'must be a relative path with / separators')

export const ObserverSettings = z.strictObject({
  cli: z.string().refine(isAbsolute, 'must be an absolute path').nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  effort: z.string().min(1).nullable().default(null),
  target_p95_ms: positiveMs,
})
export type ObserverSettings = z.infer<typeof ObserverSettings>

export const ChatQuestion = z.strictObject({
  after_ms: z.int().nonnegative(),
  question: z.string().min(1),
})
export type ChatQuestion = z.infer<typeof ChatQuestion>

export const ProfileRun = z.strictObject({
  recording: RecordingPath,
  start_ms: z.int().nonnegative().default(0),
  chat: z.array(ChatQuestion).default([]),
})
export type ProfileRun = z.infer<typeof ProfileRun>

export const LoadProfile = z
  .strictObject({
    format: z.literal('aang-freshness-profile/1'),
    name: z.string().min(1),
    time_scale: z.number().positive().default(1),
    window_ms: positiveMs,
    observer: z.strictObject({
      claude: ObserverSettings.optional(),
      codex: ObserverSettings.optional(),
    }),
    runs: z.array(ProfileRun).min(1),
  })
  .superRefine(({ runs }, context) => {
    const seen = new Set<string>()
    runs.forEach(({ recording }, index) => {
      if (seen.has(recording)) {
        context.addIssue({ code: 'custom', path: ['runs', index, 'recording'], message: 'a recording is played once per profile' })
      }
      seen.add(recording)
    })
  })
export type LoadProfile = z.infer<typeof LoadProfile>

export const Digest = z.string().regex(/^[0-9a-f]{64}$/)

export const FixedRecording = z.strictObject({
  recording: RecordingPath,
  start_ms: z.int().nonnegative(),
  runtime: Runtime,
  digest: Digest,
  control_events: z.int().nonnegative(),
})
export type FixedRecording = z.infer<typeof FixedRecording>

export const FixedProfile = z
  .strictObject({
    format: z.literal('aang-freshness-fixed-profile/1'),
    fixed_at: z.iso.datetime(),
    profile: LoadProfile,
    recordings: z.array(FixedRecording),
  })
  .refine(
    ({ profile, recordings }) =>
      recordings.length === profile.runs.length &&
      recordings.every(({ recording, start_ms: start }, index) => {
        const run = profile.runs[index]
        return run?.recording === recording && run.start_ms === start
      }),
    { path: ['recordings'], message: 'the fixed recordings must follow the runs of the profile' },
  )
export type FixedProfile = z.infer<typeof FixedProfile>

export const observerOf = (profile: LoadProfile, runtime: Runtime): ObserverSettings => {
  const settings = profile.observer[runtime]
  if (settings === undefined) {
    throw new Error(`the profile has no observer settings for ${runtime}`)
  }
  return settings
}
