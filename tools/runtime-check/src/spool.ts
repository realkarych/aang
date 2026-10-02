import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spoolFormat } from '@aang/contract'
import { spoolReady } from './profile.js'

interface DeliveredEvent {
  readonly runtime: string
  readonly registration: string
  readonly env: Readonly<Record<string, string>>
  readonly payload: unknown
  readonly event: string | null
}

const parseDelivered = (bytes: Buffer): DeliveredEvent => {
  const lineEnd = bytes.indexOf(spoolFormat.headerLineTerminator)
  const [, runtime = '', registration = ''] = bytes.toString('utf8', 0, lineEnd).split(spoolFormat.headerFieldSeparator)
  const env: Record<string, string> = {}
  let position = lineEnd + 1
  let entryEnd = bytes.indexOf(spoolFormat.envEntryTerminator, position)
  while (entryEnd > position) {
    const entry = bytes.toString('utf8', position, entryEnd)
    const separator = entry.indexOf(spoolFormat.envAssignment)
    env[entry.slice(0, separator)] = entry.slice(separator + 1)
    position = entryEnd + 1
    entryEnd = bytes.indexOf(spoolFormat.envEntryTerminator, position)
  }
  let payload: unknown
  try {
    payload = JSON.parse(bytes.toString('utf8', entryEnd + 1))
  } catch {
    payload = null
  }
  const event =
    typeof payload === 'object' &&
    payload !== null &&
    'hook_event_name' in payload &&
    typeof payload.hook_event_name === 'string'
      ? payload.hook_event_name
      : null
  return { runtime, registration, env, payload, event }
}

export const deliveredNames = async (spool: string): Promise<string[]> => {
  try {
    return (await readdir(spoolReady(spool))).sort()
  } catch {
    return []
  }
}

export const readDelivered = async (spool: string): Promise<DeliveredEvent[]> =>
  Promise.all(
    (await deliveredNames(spool)).map(async (name) => parseDelivered(await readFile(join(spoolReady(spool), name)))),
  )

export const clearDelivered = async (spool: string): Promise<void> => {
  await Promise.all((await deliveredNames(spool)).map((name) => rm(join(spoolReady(spool), name), { force: true })))
}

export const countByEvent = (events: readonly DeliveredEvent[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const { event } of events) {
    const key = event ?? '(unparsed payload)'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}
