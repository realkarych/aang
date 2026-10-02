import { type Adapter, type CollectedRecord, NormalizerVersion, type ParseResult } from '@aang/contract'
import { unknown } from './facts.js'
import { parseHook } from './hook.js'
import { rawKey, streamKey } from './keys.js'
import { parseTranscriptLine } from './transcript.js'

const parse = (record: CollectedRecord): ParseResult => {
  if (record.channel === 'hook') {
    return parseHook(record)
  }
  if (record.channel === 'transcript' && record.position.kind === 'line') {
    return parseTranscriptLine(record)
  }
  return unknown(null)
}

export const claudeAdapter: Adapter = {
  runtime: 'claude',
  normalizerVersion: NormalizerVersion.parse(1),
  streamKey,
  rawKey,
  parse,
}
