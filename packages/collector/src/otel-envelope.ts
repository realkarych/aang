type JsonObject = Readonly<Record<string, unknown>>

export interface OtelEnvelope {
  readonly observedAt: string
  readonly resourceLogs: readonly JsonObject[]
}

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const objects = (value: JsonObject, key: string): JsonObject[] => {
  const member = value[key]
  return Array.isArray(member) ? member.filter(isObject) : []
}

const isToolDecision = (logRecord: JsonObject): boolean =>
  objects(logRecord, 'attributes').some(
    ({ key, value }) => key === 'event.name' && isObject(value) && value.stringValue === 'codex.tool_decision',
  )

export const filterOtel = (request: unknown, observedAt: string): OtelEnvelope => ({
  observedAt,
  resourceLogs: (isObject(request) ? objects(request, 'resourceLogs') : []).flatMap((resourceLog) => {
    const scopeLogs = objects(resourceLog, 'scopeLogs').flatMap((scopeLog) => {
      const logRecords = objects(scopeLog, 'logRecords').filter(isToolDecision)
      return logRecords.length === 0 ? [] : [{ ...scopeLog, logRecords }]
    })
    return scopeLogs.length === 0 ? [] : [{ ...resourceLog, scopeLogs }]
  }),
})

export function* otelPayloads(envelope: OtelEnvelope): Generator<string> {
  for (const resourceLog of envelope.resourceLogs) {
    for (const scopeLog of objects(resourceLog, 'scopeLogs')) {
      for (const logRecord of objects(scopeLog, 'logRecords')) {
        yield JSON.stringify({ resourceLogs: [{ ...resourceLog, scopeLogs: [{ ...scopeLog, logRecords: [logRecord] }] }] })
      }
    }
  }
}
