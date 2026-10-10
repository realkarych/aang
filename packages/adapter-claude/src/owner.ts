import type { CollectedRecord, JsonValue, RecordOwner, RecordThread } from '@aang/contract'
import { parseJson, stringField } from './json.js'
import { sessionKey } from './keys.js'
import { snapshotFile, workflowJournal } from './paths.js'

const observerEntrypoint = 'aang-observer'
const sessionStartEvent = 'SessionStart'
const startSources: ReadonlySet<string> = new Set(['startup', 'clear', 'fork'])

const startsSession = (payload: JsonValue | undefined): boolean =>
  stringField(payload, 'hook_event_name') === sessionStartEvent &&
  startSources.has(stringField(payload, 'source') ?? '')

const hookOwner = (record: CollectedRecord): RecordOwner | null => {
  const payload = parseJson(record.payload)
  const session = stringField(payload, 'session_id')
  if (session === null) {
    return null
  }
  const root = stringField(payload, 'agent_id') === null
  return {
    session: sessionKey(session),
    thread: root ? 'root' : 'agent',
    cwd: stringField(payload, 'cwd'),
    start: root && startsSession(payload),
    observer: record.hook?.env.CLAUDE_CODE_ENTRYPOINT === observerEntrypoint,
  }
}

const lineOwner = (record: CollectedRecord): RecordOwner | null => {
  const line = parseJson(record.payload)
  const session = stringField(line, 'sessionId')
  if (session === null) {
    return null
  }
  return {
    session: sessionKey(session),
    thread: stringField(line, 'agentId') === null ? 'root' : 'agent',
    cwd: stringField(line, 'cwd'),
    start: false,
    observer: stringField(line, 'entrypoint') === observerEntrypoint,
  }
}

const fileOwner = (session: string, thread: RecordThread): RecordOwner => ({
  session: sessionKey(session),
  thread,
  cwd: null,
  start: false,
  observer: false,
})

const snapshotOwner = (record: CollectedRecord, path: string): RecordOwner | null => {
  const file = snapshotFile(path)
  switch (file?.kind) {
    case 'agent_meta':
      return fileOwner(file.session, 'agent')
    case 'workflow':
    case 'tool_result':
      return fileOwner(file.session, 'root')
    case 'team': {
      const lead = stringField(parseJson(record.payload), 'leadSessionId')
      return lead === null ? null : fileOwner(lead, 'root')
    }
    default:
      return null
  }
}

export const owner = (record: CollectedRecord): RecordOwner | null => {
  if (record.channel === 'hook') {
    return hookOwner(record)
  }
  if (record.channel === 'registry' && (record.position.kind === 'file' || record.position.kind === 'process_exited')) {
    const payload = parseJson(record.payload)
    const session = stringField(payload, 'sessionId')
    return session === null ? null : {
      session: sessionKey(session),
      thread: 'root',
      cwd: stringField(payload, 'cwd'),
      start: false,
      observer: stringField(payload, 'entrypoint') === observerEntrypoint,
    }
  }
  const { position } = record
  if (record.channel !== 'transcript') {
    return null
  }
  switch (position.kind) {
    case 'line': {
      const journal = workflowJournal(position.path)
      return journal === null ? lineOwner(record) : fileOwner(journal.session, 'agent')
    }
    case 'file':
    case 'file_removed':
      return snapshotOwner(record, position.path)
    default:
      return null
  }
}
