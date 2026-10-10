import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RecordingManifest } from '@aang/record'
import { isMissing } from './files.js'

export interface Recording {
  readonly directory: string
  readonly name: string
  readonly manifest: RecordingManifest
}

const depth = 5

const directoriesIn = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort()
  } catch (error) {
    if (isMissing(error)) {
      return []
    }
    throw error
  }
}

const recordingDirectories = async (root: string, segments: readonly string[] = []): Promise<string[][]> => {
  if (segments.length === depth) {
    return [[...segments]]
  }
  const nested = await Promise.all(
    (await directoriesIn(join(root, ...segments))).map((name) => recordingDirectories(root, [...segments, name])),
  )
  return nested.flat()
}

export const readRecordingManifest = async (directory: string): Promise<RecordingManifest> => {
  const file = join(directory, 'manifest.json')
  const parsed = RecordingManifest.safeParse(JSON.parse(await readFile(file, 'utf8')))
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.message}`)
  }
  return parsed.data
}

export const recordingName = (manifest: Pick<RecordingManifest, 'runtime' | 'engine_version' | 'surface' | 'os' | 'scenario'>): string =>
  [manifest.runtime, manifest.engine_version, manifest.surface, manifest.os, manifest.scenario].join('/')

export const findRecordings = async (sessions: string): Promise<Recording[]> =>
  Promise.all(
    (await recordingDirectories(sessions)).map(async (segments) => {
      const directory = join(sessions, ...segments)
      const manifest = await readRecordingManifest(directory)
      const name = segments.join('/')
      if (recordingName(manifest) !== name) {
        throw new Error(`${directory}: the manifest describes ${recordingName(manifest)}`)
      }
      return { directory, name, manifest }
    }),
  )
