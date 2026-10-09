import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { measurementFiles, parseJson, writeNew } from './files.js'
import { type FixedProfile, type FixedRecording, LoadProfile, observerOf } from './profile.js'
import { loadRecording } from './recording.js'

export const fixProfile = async (source: string, directory: string, fixtures: string): Promise<FixedProfile> => {
  const profile = parseJson(LoadProfile, source, await readFile(source, 'utf8'))
  const recordings: FixedRecording[] = []
  for (const { recording: path, start_ms: start } of profile.runs) {
    const recording = await loadRecording(fixtures, path)
    observerOf(profile, recording.manifest.runtime)
    recordings.push({
      recording: path,
      start_ms: start,
      runtime: recording.manifest.runtime,
      digest: recording.digest,
      control_events: recording.events.length,
    })
  }
  if (recordings.every(({ control_events: events }) => events === 0)) {
    throw new Error(`${source}: the recordings of the profile have no control events`)
  }
  const fixed: FixedProfile = { format: 'aang-freshness-fixed-profile/1', fixed_at: new Date().toISOString(), profile, recordings }
  await mkdir(directory, { recursive: true })
  await writeNew(join(directory, measurementFiles.profile), fixed)
  return fixed
}
