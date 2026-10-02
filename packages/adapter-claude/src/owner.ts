import type { CollectedRecord, JsonValue, RecordOwner } from '@aang/contract'
import { parseJson, stringField } from './json.js'
import { sessionKey } from './keys.js'

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

export const owner = (record: CollectedRecord): RecordOwner | null => {
  if (record.channel === 'hook') {
    return hookOwner(record)
  }
  return record.channel === 'transcript' && record.position.kind === 'line' ? lineOwner(record) : null
}
