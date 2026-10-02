import type { CollectedRecord, RecordOwner } from '@aang/contract'
import { z } from 'zod'
import { sessionEntity } from './facts.js'
import { readJson } from './json.js'
import { readLine } from './line.js'
import { otelOwner } from './otel.js'
import { observerOriginator, observerThreadSource } from './session.js'
import { decodeStream, isRoot, type ThreadStream } from './stream.js'

const name = z.string().min(1)
const sessionStartEvent = 'SessionStart'
const startSources: ReadonlySet<string> = new Set(['startup', 'clear', 'fork'])

const evidence = z.string().optional().catch(undefined)

const HookIdentity = z.looseObject({
  session_id: name,
  agent_id: name.nullish(),
})

const HookEvidence = z.looseObject({
  hook_event_name: evidence,
  cwd: evidence,
  source: evidence,
})

const SessionMetaMarks = z.looseObject({
  cwd: evidence,
  originator: evidence,
  thread_source: evidence,
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
  const payload = readJson(record.payload)
  const hook = HookIdentity.safeParse(payload)
  if (!hook.success) {
    return null
  }
  const { session_id: session, agent_id: agent } = hook.data
  const { hook_event_name: event, cwd, source } = HookEvidence.parse(payload)
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
  if (record.channel === 'otel' && record.position.kind === 'otel') {
    return otelOwner(record)
  }
  const stream = decodeStream(record.stream)
  if (record.channel !== 'rollout' || record.position.kind !== 'line' || stream === null) {
    return null
  }
  return ownedBy(stream, lineStatement(record.payload, stream))
}
