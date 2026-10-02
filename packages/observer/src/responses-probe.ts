import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { json, LaunchError, object, type JsonObject } from './backend.js'

const calls = [
  { type: 'custom_tool_call', namespace: 'functions', name: 'exec', input: 'text("aang-admission")', call_id: 'probe_exec' },
  { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', arguments: '{"task_name":"probe","message":"Finish immediately","fork_turns":"none"}', call_id: 'probe_spawn' },
  { type: 'function_call', namespace: 'functions', name: 'request_user_input', arguments: '{"questions":[]}', call_id: 'probe_input' },
  { type: 'function_call', namespace: 'functions', name: 'request_user_input_async', arguments: '{"questions":[]}', call_id: 'probe_async' },
]

export const startResponsesProbe = async () => {
  let problem: string | null = null
  let completed = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
      if (body.length > 1024 * 1024) request.destroy()
    })
    request.on('end', () => {
      try {
        const value = json(body)
        if (request.method !== 'POST' || request.url !== '/v1/responses' || !object(value) || !Array.isArray(value.input)) throw new Error('Invalid Responses request')
        const additional = value.input.filter((item) => object(item) && item.type === 'additional_tools') as JsonObject[]
        if (value.tools === undefined && additional.length === 0) throw new Error('Responses tool inventory is absent')
        for (const inventory of [value, ...additional]) {
          if (inventory === value && inventory.tools === undefined) continue
          if (!Array.isArray(inventory.tools) || inventory.tools.length !== 0) throw new Error('Responses advertised tools')
        }
        const outputs = value.input.filter((item) => object(item) && (item.type === 'function_call_output' || item.type === 'custom_tool_call_output')) as JsonObject[]
        const answered = outputs.length > 0
        if (answered) {
          for (const call of calls) {
            const output = outputs.find((item) => item.call_id === call.call_id)
            if (typeof output?.output !== 'string' || !/^unsupported (?:custom tool )?call:/.test(output.output) || !output.output.includes(call.name)) throw new Error(`Probe ${call.name} was not rejected as unsupported`)
          }
          completed += 1
        }
        const items = answered ? [{ type: 'message', id: 'msg_admission', role: 'assistant', content: [{ type: 'output_text', text: '{"base_version":0,"ops":[],"needs":[]}' }] }] : calls.map((call) => ({ ...call, id: call.call_id, status: 'completed' }))
        const events = [
          { type: 'response.created', response: { id: 'resp_admission', status: 'in_progress', output: [] } },
          ...items.map((item, index) => ({ type: 'response.output_item.done', output_index: index, item })),
          { type: 'response.completed', response: { id: 'resp_admission', status: 'completed', output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      } catch (error) {
        problem ??= String(error)
        response.writeHead(400)
        response.end('Admission probe rejected the request')
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    verify: (expected: number): void => {
      if (problem !== null || completed !== expected) throw new LaunchError('isolation', problem ?? 'Responses tool probes did not complete')
    },
    close: async (): Promise<void> => {
      server.closeAllConnections()
      const closed = once(server, 'close')
      server.close()
      await closed
    },
  }
}
