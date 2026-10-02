import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface OtlpReceiver {
  readonly endpoint: string
  readonly listen: (deliver: (body: string, receivedAt: number) => void) => void
  readonly check: () => void
  readonly close: () => Promise<void>
}

const logsPath = '/v1/logs'

export const startOtlpReceiver = async (): Promise<OtlpReceiver> => {
  const state: { deliver?: (body: string, receivedAt: number) => void; failure?: Error } = {}
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const receivedAt = Date.now()
      const body = Buffer.concat(chunks).toString('utf8')
      const json = (request.headers['content-type'] ?? '').startsWith('application/json')
      if (request.method === 'POST' && request.url === logsPath && json) {
        try {
          state.deliver?.(body, receivedAt)
        } catch (error) {
          state.failure ??= error instanceof Error ? error : new Error('Invalid OTLP body', { cause: error })
        }
      } else if (request.method === 'POST' && request.url === logsPath) {
        state.failure ??= new Error('OTLP logs must use the JSON protocol')
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${String(port)}${logsPath}`,
    listen: (deliver) => {
      state.deliver = deliver
    },
    check: () => {
      if (state.failure !== undefined) throw state.failure
    },
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}
