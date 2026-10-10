import type { CollectedRecord, EpochNs, ParseResult } from '@aang/contract'
import { z } from 'zod'
import { fact, type FactOrigin, invalid, noRuntimeIds, parsed, schemaViolation, unknown } from './facts.js'
import { name, optionalText } from './fields.js'
import { parseJson, withinNestingLimit } from './json.js'
import { sessionKey } from './keys.js'
import { epochFromMilliseconds } from './time.js'

const registryPath = /(?:^|[\\/])sessions[\\/]\d+\.json$/

const RegistryFile = z.looseObject({
  pid: z.int().positive(),
  sessionId: name,
  kind: optionalText,
  entrypoint: optionalText,
  status: optionalText,
  waitingFor: optionalText,
  cwd: optionalText,
  version: optionalText,
  startedAt: z.int().nonnegative().nullish().catch(null),
  statusUpdatedAt: z.int().nonnegative().nullish(),
})

const timeOf = (milliseconds: number | null | undefined): EpochNs | null =>
  milliseconds === undefined || milliseconds === null ? null : epochFromMilliseconds(milliseconds)

export const parseRegistry = (record: CollectedRecord): ParseResult => {
  const { position } = record
  if (
    (position.kind !== 'file' && position.kind !== 'file_removed' && position.kind !== 'process_exited') ||
    !registryPath.test(position.path)
  ) {
    return unknown(null)
  }
  if (position.kind === 'file_removed') {
    return parsed(null, [])
  }
  const content = parseJson(record.payload)
  if (content === undefined) {
    return invalid('session registry entry is not JSON')
  }
  if (!withinNestingLimit(content)) {
    return unknown(null)
  }
  const file = RegistryFile.safeParse(content)
  if (!file.success) {
    return schemaViolation('session registry entry', file.error)
  }
  const entry = file.data
  const origin: FactOrigin = {
    at: record.observed_at,
    ids: { ...noRuntimeIds, session_id: entry.sessionId },
    env: {
      cwd: entry.cwd ?? null,
      version: entry.version ?? null,
      entrypoint: entry.entrypoint ?? null,
      originator: null,
      git_branch: null,
    },
    redeliveryKey: null,
  }
  if (position.kind === 'process_exited') {
    return parsed(null, [
      fact(origin, {
        kind: 'process_exited',
        entity_key: sessionKey(entry.sessionId),
        speaker: 'runtime',
        urgent: false,
        payload: { pid: position.pid, path: position.path, started_at: timeOf(entry.startedAt) },
      }),
    ])
  }
  return parsed(null, [
    fact(origin, {
      kind: 'json_snapshot',
      entity_key: sessionKey(entry.sessionId),
      speaker: 'runtime',
      urgent: false,
      payload: {
        file: 'registry',
        path: position.path,
        removed: false,
        content: {
          pid: entry.pid,
          session_id: entry.sessionId,
          kind: entry.kind ?? null,
          entrypoint: entry.entrypoint ?? null,
          status: entry.status ?? null,
          waiting_for: entry.waitingFor ?? null,
          cwd: entry.cwd ?? null,
          version: entry.version ?? null,
          status_updated_at: timeOf(entry.statusUpdatedAt),
        },
      },
    }),
  ])
}
