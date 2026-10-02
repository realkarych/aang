import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'

export interface TelemetryTap {
  readonly endpoint: string
  readonly bodies: readonly string[]
  readonly close: () => Promise<void>
}

const Value = z.looseObject({ stringValue: z.string().optional(), intValue: z.union([z.string(), z.number()]).optional(), boolValue: z.boolean().optional() })
const Logs = z.looseObject({
  resourceLogs: z.array(z.looseObject({
    scopeLogs: z.array(z.looseObject({
      logRecords: z.array(z.looseObject({ attributes: z.array(z.looseObject({ key: z.string(), value: Value })).optional() })).optional(),
    })).optional(),
  })).optional(),
})

export type LogAttributes = Readonly<Record<string, string>>

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const logRecords = (bodies: readonly string[]): LogAttributes[] =>
  bodies.flatMap((body) => {
    const parsed = Logs.safeParse(parseJson(body))
    if (!parsed.success) return []
    return (parsed.data.resourceLogs ?? []).flatMap((resource) => (resource.scopeLogs ?? []).flatMap((scope) => (scope.logRecords ?? []).map((record) =>
      Object.fromEntries((record.attributes ?? []).map(({ key, value }) => [key, String(value.stringValue ?? value.intValue ?? value.boolValue ?? '')])))))
  })

export const startTelemetryTap = async (target: string): Promise<TelemetryTap> => {
  const bodies: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const type = request.headers['content-type'] ?? 'application/json'
      if (type.startsWith('application/json')) bodies.push(body.toString('utf8'))
      void fetch(target, { method: request.method ?? 'POST', headers: { 'content-type': type }, body })
        .then((forwarded) => forwarded.arrayBuffer())
        .catch(() => undefined)
        .finally(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{}')
        })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const path = new URL(target).pathname
  return {
    endpoint: `http://127.0.0.1:${String(port)}${path}`,
    bodies,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}
