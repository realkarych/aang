import { readdirSync, readFileSync } from 'node:fs'
import { codexAdapter } from '@aang/adapter-codex'
import {
  type CollectedPosition,
  type CollectedRecord,
  type CollectorChannel,
  EpochNs,
  FactDraft,
  type ParseResult,
  StreamKey,
} from '@aang/contract'
import { expect } from 'vitest'

const rolloutSamples = new URL('../../../docs/research/samples/codex-cli/rollout/', import.meta.url)

export const realThread = '01a0f752-40a7-76b2-9df9-5b374f75f98f'
export const realRollout = 'rollout-real-exec-then-resume-with-compaction.jsonl'

export const sessionsPath = `/home/u/.codex/sessions/2026/10/01/rollout-2026-10-01T14-55-58-${realThread}.jsonl`
export const archivedPath = `/home/u/.codex/archived_sessions/rollout-2026-10-01T14-55-58-${realThread}.jsonl`

export const sampleFiles = (): string[] =>
  readdirSync(rolloutSamples)
    .filter((name) => name.endsWith('.json'))
    .sort()

export const readSample = (name: string): string => readFileSync(new URL(name, rolloutSamples), 'utf8')

export const sampleLine = (name: string): string => JSON.stringify(JSON.parse(readSample(name)))

const objectValue = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return { ...value }
}

export const sampleObject = (name: string): Record<string, unknown> => objectValue(JSON.parse(readSample(name)))

export const rolloutLines = (name: string): string[] => readSample(name).split('\n').filter((line) => line !== '')

export const millis = (value: number): EpochNs => EpochNs.parse(BigInt(value) * 1_000_000n)

export const iso = (value: string): EpochNs => millis(Date.parse(value))

export const streamFrom = (sessionMetaLine: string): StreamKey => {
  const stream = codexAdapter.streamKey([sessionMetaLine])
  if (stream === null) {
    throw new Error('session_meta line did not yield a stream')
  }
  return stream
}

export const threadStream = (session: string, thread: string = session): StreamKey => {
  const meta = sampleObject('session_meta.exec.real.json')
  return streamFrom(
    JSON.stringify({ ...meta, payload: { ...objectValue(meta['payload']), id: thread, session_id: session } }),
  )
}

export const record = (
  payload: string,
  stream: StreamKey | null,
  overrides: { readonly channel?: CollectorChannel; readonly position?: CollectedPosition } = {},
): CollectedRecord => ({
  channel: overrides.channel ?? 'rollout',
  runtime: 'codex',
  stream,
  position: overrides.position ?? { kind: 'line', path: sessionsPath, offset: 0, line: 1 },
  hook: null,
  observed_at: EpochNs.parse(1_790_855_800_000_000_000n),
  payload,
})

export const factsOf = (result: ParseResult): FactDraft[] => {
  if (result.parse_state !== 'parsed') {
    throw new Error(`expected a parsed record, got ${result.parse_state}`)
  }
  return result.facts.map((fact) => FactDraft.parse(fact))
}

export const parseFacts = (payload: string, stream: StreamKey | null): FactDraft[] =>
  factsOf(codexAdapter.parse(record(payload, stream)))

export const expectUnknown = (payload: string, stream: StreamKey | null): void => {
  expect(codexAdapter.parse(record(payload, stream))).toMatchObject({ parse_state: 'unknown' })
}

export const withPayload = (name: string, changes: Record<string, unknown>): string => {
  const sample = sampleObject(name)
  return JSON.stringify({ ...sample, payload: { ...objectValue(sample['payload']), ...changes } })
}

export const withItem = (name: string, changes: Record<string, unknown>): string => {
  const sample = sampleObject(name)
  const payload = objectValue(sample['payload'])
  return JSON.stringify({ ...sample, payload: { ...payload, item: { ...objectValue(payload['item']), ...changes } } })
}
