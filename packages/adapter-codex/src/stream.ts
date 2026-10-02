import { StreamKey } from '@aang/contract'
import { z } from 'zod'
import { readLine } from './line.js'

export interface ThreadStream {
  readonly session: string
  readonly thread: string
}

const runtimePrefix = 'codex'
const separator = ':'
const rootChildDepth = 1

const ThreadId = z.string().regex(/^[^:\s]+$/)

const SessionMetaIds = z.looseObject({
  id: ThreadId,
  session_id: ThreadId.optional(),
  source: z.unknown().optional(),
})
type SessionMetaIds = z.infer<typeof SessionMetaIds>

const SubagentSource = z.looseObject({ subagent: z.looseObject({ thread_spawn: z.unknown().optional() }) })

const RootChildSpawn = z.looseObject({ parent_thread_id: ThreadId, depth: z.literal(rootChildDepth) })

const rootSession = ({ id, session_id: session, source }: SessionMetaIds): string | null => {
  if (session !== undefined && session !== id) {
    return session
  }
  const subagent = SubagentSource.safeParse(source)
  if (!subagent.success) {
    return id
  }
  return RootChildSpawn.safeParse(subagent.data.subagent.thread_spawn).data?.parent_thread_id ?? null
}

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
  const session = rootSession(ids.data)
  return session === null ? null : StreamKey.parse([runtimePrefix, session, ids.data.id].join(separator))
}
