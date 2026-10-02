import { readdir, readFile } from 'node:fs/promises'
import { claudeAdapter } from '@aang/adapter-claude'
import {
  CollectedRecord,
  type JsonValue,
  type ParseResult,
  type SpoolEnv,
  spoolEnvKeys,
  type StreamKey,
} from '@aang/contract'

const samplesRoot = new URL('../../../docs/research/samples/', import.meta.url)

export type JsonObject = { readonly [key: string]: JsonValue }

export const readSample = (path: string): Promise<string> => readFile(new URL(path, samplesRoot), 'utf8')

export const readJsonSample = async (path: string): Promise<JsonObject> =>
  JSON.parse(await readSample(path)) as JsonObject

export const sampleLines = async (path: string): Promise<string[]> =>
  (await readSample(path)).split('\n').filter((line) => line.length > 0)

export const sampleFiles = async (directory: string, pattern: RegExp): Promise<string[]> =>
  (await readdir(new URL(directory, samplesRoot)))
    .filter((file) => pattern.test(file))
    .sort()
    .map((file) => `${directory}${file}`)

export const field = (value: JsonValue | undefined, key: string): JsonValue | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value[key] : undefined

export const spoolEnv = (env: JsonValue | undefined): SpoolEnv =>
  Object.fromEntries(
    spoolEnvKeys.flatMap((key) => {
      const value = field(env, key)
      return typeof value === 'string' ? [[key, value]] : []
    }),
  )

export const observedAt = 1_790_856_592_228_739_000n

export interface HookDelivery {
  readonly payload: string
  readonly file: string
  readonly env?: SpoolEnv
  readonly position?: 'spool' | 'otel'
}

export const hookRecord = ({ payload, file, env = {}, position = 'spool' }: HookDelivery): CollectedRecord =>
  CollectedRecord.parse({
    channel: 'hook',
    runtime: 'claude',
    stream: null,
    position: position === 'spool' ? { kind: 'spool', file } : { kind: 'otel' },
    hook: { registration: 'plugin', env },
    observed_at: observedAt,
    payload,
  })

export interface TranscriptLine {
  readonly payload: string
  readonly line: number
  readonly offset?: number
  readonly path?: string
  readonly stream?: StreamKey | null
}

export const transcriptPath = '/home/user/.claude/projects/-tmp-run/session.jsonl'

export const lineRecord = ({
  payload,
  line,
  offset = 0,
  path = transcriptPath,
  stream = null,
}: TranscriptLine): CollectedRecord =>
  CollectedRecord.parse({
    channel: 'transcript',
    runtime: 'claude',
    stream,
    position: { kind: 'line', path, offset, line },
    hook: null,
    observed_at: observedAt,
    payload,
  })

const streamWindow = 10

export const transcriptRecords = async (path: string): Promise<CollectedRecord[]> => {
  const lines = await sampleLines(path)
  const stream = claudeAdapter.streamKey(lines.slice(0, streamWindow))
  const offsets = lines.map((_, index) =>
    lines.slice(0, index).reduce((total, line) => total + Buffer.byteLength(line) + 1, 0),
  )
  return lines.map((payload, index) =>
    lineRecord({ payload, line: index + 1, offset: offsets[index] ?? 0, path: `/samples/${path}`, stream }),
  )
}

export const factsOf = (result: ParseResult) => {
  if (result.parse_state !== 'parsed') {
    throw new Error(`expected a parsed record, got ${JSON.stringify(result)}`)
  }
  return result.facts
}
