import type { RawChannel, RawRecord, Runtime } from '@aang/contract'

interface UncoveredType {
  readonly runtime: Runtime
  readonly channel: RawChannel
  readonly type: string
  readonly parsedBy: string
}

const uncoveredTypes: readonly UncoveredType[] = [
  { runtime: 'claude', channel: 'transcript', type: 'system:stop_hook_summary', parsedBy: 'F.7d' },
]

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export const recordType = (record: RawRecord): string => {
  let payload: unknown
  try {
    payload = JSON.parse(record.payload)
  } catch {
    return '-'
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return '-'
  }
  const fields = payload as Readonly<Record<string, unknown>>
  const nested = fields.payload
  const detail =
    textOf(fields.subtype) ??
    (typeof nested === 'object' && nested !== null && !Array.isArray(nested) ? textOf((nested as Readonly<Record<string, unknown>>).type) : null)
  const name = textOf(fields.hook_event_name) ?? textOf(fields.type) ?? '-'
  return detail === null ? name : `${name}:${detail}`
}

const isUncovered = (record: RawRecord, type: string): boolean =>
  uncoveredTypes.some(({ runtime, channel, type: uncovered }) => runtime === record.runtime && channel === record.channel && uncovered === type)

export const unparsedRecords = (records: readonly RawRecord[]): string[] => {
  const counts = new Map<string, number>()
  for (const record of records) {
    const type = recordType(record)
    if (record.parse_state === 'invalid' || (record.parse_state === 'unknown' && !isUncovered(record, type))) {
      const text = `${record.runtime ?? '-'} ${record.channel} records of type ${type} are ${record.parse_state}`
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
  }
  return [...counts].map(([text, count]) => `${text}: ${String(count)}`).sort()
}
