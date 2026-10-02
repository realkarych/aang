import { z } from 'zod'
import { ContentHash, DedupeKey, EpochNs, RawSeq, Runtime, SpoolFileName, StreamKey } from './primitives.js'
import { RegistrationTag, SpoolEnv } from './spool.js'

export const CollectorChannel = z.enum(['hook', 'transcript', 'rollout', 'otel', 'registry'])
export type CollectorChannel = z.infer<typeof CollectorChannel>

export const DaemonChannel = z.enum(['snapshot', 'context'])
export type DaemonChannel = z.infer<typeof DaemonChannel>

export const RawChannel = z.enum([...CollectorChannel.options, ...DaemonChannel.options])
export type RawChannel = z.infer<typeof RawChannel>

export const ParseState = z.enum(['parsed', 'unknown', 'invalid'])
export type ParseState = z.infer<typeof ParseState>

export const LinePosition = z.strictObject({
  kind: z.literal('line'),
  path: z.string().min(1),
  offset: z.int().nonnegative(),
  line: z.int().positive(),
})
export type LinePosition = z.infer<typeof LinePosition>

export const FilePosition = z.strictObject({
  kind: z.literal('file'),
  path: z.string().min(1),
  content_hash: ContentHash,
})
export type FilePosition = z.infer<typeof FilePosition>

export const FileRemovedPosition = z.strictObject({
  kind: z.literal('file_removed'),
  path: z.string().min(1),
  last_content_hash: ContentHash.nullable(),
})
export type FileRemovedPosition = z.infer<typeof FileRemovedPosition>

export const StreamLostPosition = z.strictObject({
  kind: z.literal('stream_lost'),
  path: z.string().min(1),
})
export type StreamLostPosition = z.infer<typeof StreamLostPosition>

export const SpoolPosition = z.strictObject({
  kind: z.literal('spool'),
  file: SpoolFileName,
})
export type SpoolPosition = z.infer<typeof SpoolPosition>

export const OtelPosition = z.strictObject({
  kind: z.literal('otel'),
})
export type OtelPosition = z.infer<typeof OtelPosition>

export const DaemonPosition = z.strictObject({
  kind: z.literal('daemon'),
})
export type DaemonPosition = z.infer<typeof DaemonPosition>

export const CollectedPosition = z.discriminatedUnion('kind', [
  LinePosition,
  FilePosition,
  FileRemovedPosition,
  StreamLostPosition,
  SpoolPosition,
  OtelPosition,
])
export type CollectedPosition = z.infer<typeof CollectedPosition>

export const RawPosition = z.discriminatedUnion('kind', [...CollectedPosition.options, DaemonPosition])
export type RawPosition = z.infer<typeof RawPosition>

export const HookEnvelope = z.strictObject({
  registration: RegistrationTag,
  env: SpoolEnv,
})
export type HookEnvelope = z.infer<typeof HookEnvelope>

export const CollectedRecord = z.strictObject({
  channel: CollectorChannel,
  runtime: Runtime,
  stream: StreamKey.nullable(),
  position: CollectedPosition,
  hook: HookEnvelope.nullable(),
  observed_at: EpochNs,
  payload: z.string(),
})
export type CollectedRecord = z.infer<typeof CollectedRecord>

export const RawRecord = z.strictObject({
  seq: RawSeq,
  dedupe_key: DedupeKey,
  channel: RawChannel,
  runtime: Runtime.nullable(),
  stream: StreamKey.nullable(),
  position: RawPosition,
  hook: HookEnvelope.nullable(),
  observed_at: EpochNs,
  source_ts: EpochNs.nullable(),
  payload: z.string(),
  parse_state: ParseState,
})
export type RawRecord = z.infer<typeof RawRecord>

export const RawRecordDraft = RawRecord.omit({ seq: true })
export type RawRecordDraft = z.infer<typeof RawRecordDraft>

export const FileCursor = z.strictObject({
  path: z.string().min(1),
  dev: z.bigint().nonnegative(),
  ino: z.bigint().nonnegative(),
  stream: StreamKey.nullable(),
  offset: z.int().nonnegative(),
  line: z.int().nonnegative(),
  size: z.int().nonnegative(),
  last_ordinal: z.int().nonnegative().nullable(),
})
export type FileCursor = z.infer<typeof FileCursor>

export const ScopeDecision = z.enum(['watched', 'external', 'observer'])
export type ScopeDecision = z.infer<typeof ScopeDecision>
