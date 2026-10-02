import { type CollectedRecord, DedupeKey } from '@aang/contract'
import { canonicalJson, contentHash } from '@aang/contract/ids'
import { ordinalOf } from './line.js'
import { decodeStream } from './stream.js'

const separator = ':'

const dedupeKey = (...parts: readonly string[]): DedupeKey => DedupeKey.parse(parts.join(separator))

export const rawKey = (record: CollectedRecord): DedupeKey => {
  const { position } = record
  if (position.kind === 'spool') {
    return dedupeKey('hook', position.file)
  }
  const stream = decodeStream(record.stream)
  if (position.kind === 'line') {
    const ordinal = record.channel === 'rollout' && stream !== null ? ordinalOf(record.payload) : null
    return stream !== null && ordinal !== null
      ? dedupeKey('codex', stream.thread, String(ordinal))
      : dedupeKey('codex', stream?.thread ?? position.path, 'line', String(position.line), contentHash(record.payload))
  }
  const content = canonicalJson({ stream: record.stream, position, payload: record.payload })
  return dedupeKey('codex', record.channel, contentHash(content))
}
