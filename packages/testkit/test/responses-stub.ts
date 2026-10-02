import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface StubRequest {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: Record<string, unknown>
}

export interface ResponsesStub {
  readonly baseUrl: string
  readonly requests: StubRequest[]
}

export const stubUsage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 10 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 120,
}

export interface StubOptions {
  readonly completes?: boolean
}

const streamOf = (round: number, items: readonly unknown[], completes: boolean): string =>
  [
    { type: 'response.created', response: { id: `resp_${String(round)}` } },
    ...items.map((item, index) => ({ type: 'response.output_item.done', output_index: index, item })),
    ...(completes ? [{ type: 'response.completed', response: { id: `resp_${String(round)}`, usage: stubUsage } }] : []),
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')

export const startResponsesStub = async (
  register: (cleanup: () => Promise<void>) => void,
  rounds: readonly (readonly unknown[])[],
  { completes = true }: StubOptions = {},
): Promise<ResponsesStub> => {
  const requests: StubRequest[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      const round = requests.length
      requests.push({
        path: request.url ?? '',
        headers: request.headers,
        body: JSON.parse(body) as Record<string, unknown>,
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(streamOf(round, rounds[Math.min(round, rounds.length - 1)] ?? [], completes))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  register(async () => {
    server.closeAllConnections()
    server.close()
    await once(server, 'close')
  })
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${String(port)}/v1`, requests }
}

export const assistantMessage = (text: string) => ({
  type: 'message',
  role: 'assistant',
  id: 'msg_stub',
  content: [{ type: 'output_text', text }],
})
