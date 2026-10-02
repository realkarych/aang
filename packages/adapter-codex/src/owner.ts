import type { CollectedRecord, RecordOwner } from '@aang/contract'
import { z } from 'zod'
import { sessionEntity } from './facts.js'
import { readJson } from './json.js'
import { readLine } from './line.js'
import { observerOriginator, observerThreadSource } from './session.js'
import { decodeStream, isRoot, type ThreadStream } from './stream.js'

const name = z.string().min(1)
const sessionStartEvent = 'SessionStart'
const startSources: ReadonlySet<string> = new Set(['startup', 'clear', 'fork'])

const HookIdentity = z.looseObject({
  hook_event_name: name.optional(),
  session_id: name,
  agent_id: name.nullish(),
  cwd: z.string().nullish(),
  source: z.string().nullish(),
})

const SessionMetaMarks = z.looseObject({
  cwd: z.string().optional(),
  originator: z.string().optional(),
  thread_source: z.string().optional(),
})

const TurnContextCwd = z.looseObject({ cwd: z.string().optional() })

interface Statement {
  readonly cwd: string | null
  readonly start: boolean
  readonly observer: boolean
}

const directory = (cwd: string | null | undefined): string | null => (cwd === undefined || cwd === '' ? null : cwd)

const silent: Statement = { cwd: null, start: false, observer: false }

const ownedBy = (stream: ThreadStream, statement: Statement): RecordOwner => ({
  session: sessionEntity(stream),
  thread: isRoot(stream) ? 'root' : 'agent',
  ...statement,
})

const hookOwner = (record: CollectedRecord): RecordOwner | null => {
  const hook = HookIdentity.safeParse(readJson(record.payload))
  if (!hook.success) {
    return null
  }
  const { hook_event_name: event, session_id: session, agent_id: agent, cwd, source } = hook.data
  const stream = { session, thread: agent ?? session }
  return ownedBy(stream, {
    cwd: directory(cwd),
    start: isRoot(stream) && event === sessionStartEvent && startSources.has(source ?? ''),
    observer: record.hook?.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE === observerOriginator,
  })
}

const lineStatement = (payload: string, stream: ThreadStream): Statement => {
  const reading = readLine(payload)
  if (reading.kind !== 'line') {
    return silent
  }
  const { type, payload: content } = reading.line
  if (type === 'session_meta') {
    const meta = SessionMetaMarks.safeParse(content).data ?? {}
    return {
      cwd: directory(meta.cwd),
      start: isRoot(stream),
      observer: meta.thread_source === observerThreadSource || meta.originator === observerOriginator,
    }
  }
  if (type === 'turn_context') {
    return { ...silent, cwd: directory(TurnContextCwd.safeParse(content).data?.cwd) }
  }
  return silent
}

export const owner = (record: CollectedRecord): RecordOwner | null => {
  if (record.channel === 'hook') {
    return hookOwner(record)
  }
  const stream = decodeStream(record.stream)
  if (record.channel !== 'rollout' || record.position.kind !== 'line' || stream === null) {
    return null
  }
  return ownedBy(stream, lineStatement(record.payload, stream))
}
