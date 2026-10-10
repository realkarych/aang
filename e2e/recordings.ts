import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { OperatingSystem, Runtime } from '@aang/contract'
import type { LoadedManifest, PlayerStep } from '@aang/testkit'
import type { SurfaceVariant } from './variants.js'

const recordingOs: Readonly<Partial<Record<NodeJS.Platform, OperatingSystem>>> = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
}

export const runnerOs: OperatingSystem | null = recordingOs[process.platform] ?? null

const fallbackOs = 'macos'

const playback = (runtime: Runtime, version: string, surface: string, os: OperatingSystem, scenario: string): string =>
  fileURLToPath(new URL(`../fixtures/sessions/${runtime}/${version}/${surface}/${os}/${scenario}/playback.json`, import.meta.url))

export const recording = (runtime: Runtime, version: string, surface: string, scenario: string): string => {
  const native = runnerOs === null ? null : playback(runtime, version, surface, runnerOs, scenario)
  return native !== null && existsSync(native) ? native : playback(runtime, version, surface, fallbackOs, scenario)
}

export const variantRecordingOn = ({ runtime, version, surface }: SurfaceVariant, os: OperatingSystem, scenario: string): string =>
  playback(runtime, version, surface, os, scenario)

export const variantRecording = (variant: SurfaceVariant, scenario: string): string =>
  variantRecordingOn(variant, runnerOs !== null && variant.recordedOn.includes(runnerOs) ? runnerOs : variant.recordedOn[0], scenario)

export const codexRecording = (surface: string, scenario: string): string => recording('codex', '0.160.0', surface, scenario)

const labelled = ({ file, steps }: LoadedManifest, label: string): number => {
  const index = steps.findIndex((step) => step.label === label)
  if (index < 0) {
    throw new Error(`${file} has no step labelled "${label}"`)
  }
  return index
}

const withSteps = (manifest: LoadedManifest, steps: readonly PlayerStep[]): LoadedManifest => {
  const used = new Set(steps.flatMap((step) => ('source' in step ? [step.source] : [])))
  return {
    file: manifest.file,
    steps,
    sources: new Map([...manifest.sources].filter(([source]) => used.has(source))),
  }
}

export const through = (manifest: LoadedManifest, label: string): LoadedManifest =>
  withSteps(manifest, manifest.steps.slice(0, labelled(manifest, label) + 1))

export const after = (manifest: LoadedManifest, label: string): LoadedManifest =>
  withSteps(manifest, manifest.steps.slice(labelled(manifest, label) + 1))

export const startingAt = (manifest: LoadedManifest, label: string): LoadedManifest =>
  withSteps(manifest, manifest.steps.slice(labelled(manifest, label)))

export const tornAt = (manifest: LoadedManifest, label: string, head: string, bytes: number): LoadedManifest => {
  const index = labelled(manifest, label)
  const step = manifest.steps[index]
  if (step?.kind !== 'append') {
    throw new Error(`${manifest.file}: step "${label}" does not append to a file`)
  }
  const { at, target, source } = step
  return withSteps(manifest, [
    ...manifest.steps.slice(0, index),
    { at, label: head, kind: 'append', target, source, bytes },
    ...manifest.steps.slice(index),
  ])
}

const rolloutThread = /rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

export const threadsOf = ({ steps }: LoadedManifest): string[] => [
  ...new Set(
    steps.flatMap((step) => {
      const thread = 'target' in step ? rolloutThread.exec(step.target.path)?.[1] : undefined
      return thread === undefined ? [] : [thread]
    }),
  ),
]

export const filesOnly = (manifest: LoadedManifest): LoadedManifest =>
  withSteps(
    manifest,
    manifest.steps.filter(({ kind }) => kind !== 'hook' && kind !== 'otlp'),
  )

export const hooksOnly = (manifest: LoadedManifest): LoadedManifest =>
  withSteps(
    manifest,
    manifest.steps.filter(({ kind }) => kind === 'hook'),
  )
