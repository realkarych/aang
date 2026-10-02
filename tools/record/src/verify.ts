import { join, relative } from 'node:path'
import { loadManifest } from '@aang/testkit'
import { assertAnonymous } from './anonymize.js'
import { filesIn, readUtf8 } from './files.js'
import { RecordingManifest, validateReferences } from './schema.js'

export const verifyRecording = async (directory: string): Promise<void> => {
  const files = await filesIn(directory)
  const contents = new Map<string, string>()
  for (const file of files) contents.set(relative(directory, file).replaceAll('\\', '/'), await readUtf8(file))
  assertAnonymous([...contents].flat())
  const manifest = RecordingManifest.parse(JSON.parse(contents.get('manifest.json') ?? 'null'))
  validateReferences(manifest, JSON.parse(contents.get('playback.json') ?? 'null'))
  for (const artifact of manifest.artifacts) {
    if (!contents.has(artifact.source)) throw new Error('Recording artifact is missing')
  }
  await loadManifest(join(directory, 'playback.json'))
}
