import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface StubExchange {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
  readonly response: ServerResponse
}

interface StubServer {
  readonly origin: string
  readonly close: () => Promise<void>
}

export const startServer = async (handle: (exchange: StubExchange) => void): Promise<StubServer> => {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      handle({ method: request.method ?? 'GET', path: request.url ?? '/', headers: request.headers, body, response })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

export const sendJson = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

export type StreamEvent = { readonly type: string } & Readonly<Record<string, unknown>>

export const sendEvents = (response: ServerResponse, events: readonly StreamEvent[]): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}

export const parseBody = (body: string): unknown => {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}
