import type { DatabaseSync } from 'node:sqlite'
import { Runtime, ScopeDecision, StreamKey } from '@aang/contract'
import { prepareStatement, upsertInto, type WriteContext } from './context.js'

export interface StreamScope {
  readonly stream: StreamKey
  readonly runtime: Runtime
  readonly scope: ScopeDecision
}

export interface ScopeReader {
  readonly get: (stream: StreamKey) => StreamScope | null
}

export interface ScopeWriter extends ScopeReader {
  readonly decide: (decision: StreamScope) => void
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

export const createScopes = (database: DatabaseSync): ScopeRepository => {
  const selectByStream = prepareStatement(database, 'SELECT stream, runtime, scope FROM streams WHERE stream = ?')
  const upsertScope = prepareStatement(database, upsertInto('streams', 'stream', ['stream', 'runtime', 'scope']))

  const reader: ScopeReader = {
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
  }

  const writer = (context: WriteContext): ScopeWriter => ({
    ...reader,
    decide: ({ stream, runtime, scope }) => {
      context.assertActive()
      upsertScope.run({ stream, runtime, scope })
    },
  })

  return { reader, writer }
}
