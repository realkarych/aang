import type { DatabaseSync } from 'node:sqlite'
import { Runtime, ScopeDecision, type SessionKey, StreamKey } from '@aang/contract'
import { prepareStatement, upsertInto, type WriteContext } from './context.js'

export interface StreamScope {
  readonly stream: StreamKey
  readonly runtime: Runtime
  readonly scope: ScopeDecision
}

export interface SessionScope {
  readonly session: SessionKey
  readonly scope: ScopeDecision
}

export interface ScopeReader {
  readonly list: () => StreamScope[]
  readonly get: (stream: StreamKey) => StreamScope | null
  readonly ofSession: (session: SessionKey) => SessionScope | null
}

export interface ScopeWriter extends ScopeReader {
  readonly decide: (decision: StreamScope) => void
  readonly decideSession: (decision: SessionScope) => void
}

export interface ScopeRepository {
  readonly reader: ScopeReader
  readonly writer: (context: WriteContext) => ScopeWriter
}

type ScopeRow = {
  readonly stream: string
  readonly runtime: string
  readonly scope: string
}

type SessionScopeRow = {
  readonly scope: string
}

export const createScopes = (database: DatabaseSync): ScopeRepository => {
  const selectByStream = prepareStatement(database, 'SELECT stream, runtime, scope FROM streams WHERE stream = ?')
  const upsertScope = prepareStatement(database, upsertInto('streams', 'stream', ['stream', 'runtime', 'scope']))
  const selectBySession = prepareStatement(
    database,
    'SELECT scope FROM session_scopes WHERE runtime = ? AND session = ?',
  )
  const upsertSessionScope = prepareStatement(
    database,
    `INSERT INTO session_scopes (runtime, session, scope) VALUES (:runtime, :session, :scope)
     ON CONFLICT (runtime, session) DO UPDATE SET scope = excluded.scope`,
  )

  const selectAll = prepareStatement(database, 'SELECT stream, runtime, scope FROM streams ORDER BY stream')
  const reader: ScopeReader = {
    list: () => (selectAll.all() as ScopeRow[]).map((row) => ({ stream: StreamKey.parse(row.stream), runtime: Runtime.parse(row.runtime), scope: ScopeDecision.parse(row.scope) })),
    get: (stream) => {
      const row = selectByStream.get(stream) as ScopeRow | undefined
      return row === undefined
        ? null
        : {
            stream: StreamKey.parse(row.stream),
            runtime: Runtime.parse(row.runtime),
            scope: ScopeDecision.parse(row.scope),
          }
    },
    ofSession: (session) => {
      const row = selectBySession.get(session.runtime, session.session) as SessionScopeRow | undefined
      return row === undefined ? null : { session, scope: ScopeDecision.parse(row.scope) }
    },
  }

  const writer = (context: WriteContext): ScopeWriter => ({
    ...reader,
    decide: ({ stream, runtime, scope }) => {
      context.assertActive()
      upsertScope.run({ stream, runtime, scope })
    },
    decideSession: ({ session, scope }) => {
      context.assertActive()
      upsertSessionScope.run({ runtime: session.runtime, session: session.session, scope })
    },
  })

  return { reader, writer }
}
