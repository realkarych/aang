import { type Adapter, type CollectedRecord, NormalizerVersion, type ParseResult } from '@aang/contract'
import { unknown } from './facts.js'
import { parseHook } from './hook.js'
import { rawKey, streamKey } from './keys.js'
import { workflowJournal } from './paths.js'
import { parseSnapshot } from './snapshot.js'
import { parseTranscriptLine } from './transcript.js'
import { parseWorkflowJournalLine } from './workflow-journal.js'

const parse = (record: CollectedRecord): ParseResult => {
  if (record.channel === 'hook') {
    return parseHook(record)
  }
  const { position } = record
  switch (position.kind) {
    case 'line': {
      if (record.channel !== 'transcript') {
        return unknown(null)
      }
      const journal = workflowJournal(position.path)
      return journal === null ? parseTranscriptLine(record) : parseWorkflowJournalLine(record, journal)
    }
    case 'file':
    case 'file_removed':
      return parseSnapshot(record, position)
    default:
      return unknown(null)
  }
}

export const claudeAdapter: Adapter = {
  runtime: 'claude',
  normalizerVersion: NormalizerVersion.parse(1),
  streamKey,
  rawKey,
  parse,
}
