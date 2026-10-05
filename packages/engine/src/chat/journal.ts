import type { JournalEntry, ModelChange } from '@aang/contract'
import { jsonOf } from '../input/batch.js'
import { clipNotes } from '../input/fit.js'

export const journalEntry = (change: ModelChange): JournalEntry => ({
  version: change.version,
  op: change.op,
  author: change.author,
  target: change.target,
  before: jsonOf(change.before?.value ?? null),
  after: jsonOf(change.after?.value ?? null),
  evidence: change.evidence,
})

const clipEntry = (entry: JournalEntry, limit: number): JournalEntry => ({
  ...entry,
  before: clipNotes(entry.before, limit),
  after: clipNotes(entry.after, limit),
})

export const clipEntries = (entries: readonly JournalEntry[], limit: number): JournalEntry[] =>
  entries.map((entry) => clipEntry(entry, limit))
