import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spoolFormat } from '@aang/contract'

export interface SpoolRecord {
  readonly file: string
  readonly receivedNs: bigint
  readonly runtime: string
  readonly registration: string
  readonly env: Readonly<Record<string, string>>
  readonly payload: unknown
  readonly problem: string | null
}

interface ParsedSpoolFile {
  readonly runtime: string
  readonly registration: string
  readonly env: Readonly<Record<string, string>>
  readonly payload: unknown
  readonly problem: string | null
}

const unrecognized = (problem: string): ParsedSpoolFile => ({
  runtime: '',
  registration: '',
  env: {},
  payload: null,
  problem,
})

const parsePayload = (bytes: Buffer): { payload: unknown; problem: string | null } => {
  try {
    return { payload: JSON.parse(bytes.toString('utf8')), problem: null }
  } catch {
    return { payload: null, problem: 'payload is not JSON' }
  }
}

const parseSpoolFile = (bytes: Buffer): ParsedSpoolFile => {
  const lineEnd = bytes.indexOf(spoolFormat.headerLineTerminator)
  if (lineEnd < 0) {
    return unrecognized('no header line')
  }
  const [magic, runtime = '', registration = '', ...extra] = bytes
    .toString('utf8', 0, lineEnd)
    .split(spoolFormat.headerFieldSeparator)
  if (magic !== spoolFormat.magic || extra.length > 0) {
    return unrecognized('unrecognized header line')
  }
  const env: Record<string, string> = {}
  let position = lineEnd + spoolFormat.headerLineTerminator.length
  for (;;) {
    const entryEnd = bytes.indexOf(spoolFormat.envEntryTerminator, position)
    if (entryEnd < 0) {
      return unrecognized('header has no terminating empty entry')
    }
    if (entryEnd === position) {
      position = entryEnd + 1
      break
    }
    const entry = bytes.toString('utf8', position, entryEnd)
    const assignment = entry.indexOf(spoolFormat.envAssignment)
    if (assignment < 1) {
      return unrecognized('header entry without "="')
    }
    env[entry.slice(0, assignment)] = entry.slice(assignment + 1)
    position = entryEnd + 1
  }
  return { runtime, registration, env, ...parsePayload(bytes.subarray(position)) }
}

const namesIn = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory)).sort()
  } catch {
    return []
  }
}

export const readSpool = async (spoolReady: string): Promise<SpoolRecord[]> => {
  const records = await Promise.all(
    (await namesIn(spoolReady)).map(async (file) => {
      const path = join(spoolReady, file)
      const [bytes, stats] = await Promise.all([readFile(path), stat(path, { bigint: true })])
      return { file, receivedNs: stats.mtimeNs, ...parseSpoolFile(bytes) }
    }),
  )
  return records.sort((left, right) =>
    left.receivedNs === right.receivedNs ? left.file.localeCompare(right.file) : left.receivedNs < right.receivedNs ? -1 : 1,
  )
}
