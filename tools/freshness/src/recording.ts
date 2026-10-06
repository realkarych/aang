import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { type ExpectedMapChange, RecordingManifest } from '@aang/record'
import { type LoadedManifest, loadManifest, type PlayerStep } from '@aang/testkit'
import type { FixedRecording } from './profile.js'

export type ControlStep = Extract<PlayerStep, { kind: 'hook' | 'append' | 'write' }>

export interface ControlEvent {
  readonly label: string
  readonly index: number
  readonly step: ControlStep
  readonly expected: ExpectedMapChange
}

export interface Recording {
  readonly path: string
  readonly manifest: RecordingManifest
  readonly playback: LoadedManifest
  readonly events: readonly ControlEvent[]
  readonly digest: string
}

const isControlStep = (step: PlayerStep): step is ControlStep =>
  step.kind === 'hook' || step.kind === 'append' || step.kind === 'write'

const digestOf = async (directory: string): Promise<string> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file}\0`)
    hash.update(await readFile(join(directory, ...file.split('/'))))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export const loadRecording = async (fixtures: string, path: string): Promise<Recording> => {
  const directory = join(fixtures, ...path.split('/'))
  const manifest = RecordingManifest.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')))
  const playback = await loadManifest(join(directory, 'playback.json'))
  const events = manifest.control_events.map(({ label, step: index, expected_map_change: expected }): ControlEvent => {
    const step = playback.steps[index]
    if (step?.label !== label) {
      throw new Error(`${path}: control event ${label} does not name step ${String(index)}`)
    }
    if (!isControlStep(step)) {
      throw new Error(`${path}: control event ${label} is a ${step.kind} step; freshness is measured on hook, append and write steps`)
    }
    return { label, index, step, expected }
  })
  return { path, manifest, playback, events, digest: await digestOf(directory) }
}

export const loadFixedRecording = async (fixtures: string, fixed: FixedRecording): Promise<Recording> => {
  const recording = await loadRecording(fixtures, fixed.recording)
  if (recording.digest !== fixed.digest) {
    throw new Error(`${fixed.recording} has changed since the profile was fixed`)
  }
  return recording
}
