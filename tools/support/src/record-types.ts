import type { RawRecord } from '@aang/contract'

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

export const unparsedRecords = (records: readonly RawRecord[]): string[] => {
  const counts = new Map<string, number>()
  for (const record of records) {
    if (record.parse_state === 'invalid' || record.parse_state === 'unknown') {
      const text = `${record.runtime ?? '-'} ${record.channel} records of type ${recordType(record)} are ${record.parse_state}`
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
  }
  return [...counts].map(([text, count]) => `${text}: ${String(count)}`).sort()
}
