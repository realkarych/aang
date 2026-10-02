import { StreamKey } from '@aang/contract'
import { z } from 'zod'
import { readLine } from './line.js'

export interface ThreadStream {
  readonly session: string
  readonly thread: string
}

const runtimePrefix = 'codex'
const separator = ':'

const ThreadId = z.string().regex(/^[^:\s]+$/)

const SessionMetaIds = z.looseObject({
  id: ThreadId,
  session_id: ThreadId.optional(),
})

export const isRoot = (stream: ThreadStream): boolean => stream.session === stream.thread

export const decodeStream = (key: StreamKey | null): ThreadStream | null => {
  if (key === null) {
    return null
  }
  const [runtime, session, thread, ...rest] = key.split(separator)
  if (runtime !== runtimePrefix || session === undefined || thread === undefined || rest.length > 0) {
    return null
  }
  return ThreadId.safeParse(session).success && ThreadId.safeParse(thread).success ? { session, thread } : null
}

export const streamKey = (firstLines: readonly string[]): StreamKey | null => {
  const [first] = firstLines
  const reading = first === undefined ? null : readLine(first)
  if (reading?.kind !== 'line' || reading.line.type !== 'session_meta') {
    return null
  }
  const ids = SessionMetaIds.safeParse(reading.line.payload)
  if (!ids.success) {
    return null
  }
  const { id, session_id: session = id } = ids.data
  return StreamKey.parse([runtimePrefix, session, id].join(separator))
}
