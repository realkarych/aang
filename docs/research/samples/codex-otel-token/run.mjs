import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { arch, homedir, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Config } from '../../../../packages/contract/dist/index.js'
import { createCollector } from '../../../../packages/collector/dist/index.js'

const run = promisify(execFile)
const binary = process.argv[2] ?? 'codex'
const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-a5-otel-')))
const profile = join(root, 'codex')
const workspace = join(root, 'workspace')
const originalProfile = join(homedir(), '.codex')
const digest = async (path) => {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
const fingerprints = async () => Object.fromEntries(await Promise.all(
  ['auth.json', 'config.toml', 'hooks.json'].map(async (name) => [name, await digest(join(originalProfile, name))]),
))
const before = await fingerprints()
const token = randomBytes(32).toString('hex')
const callId = 'aang_a5_exec'
const marker = 'aang-a5-otel-token'
const model = 'gpt-6-astra'
const requests = []
const backgroundRequests = []
const httpRequests = []
const records = []
const gaps = []
let collector
let pumping
let pumpError
let stubError
let listener
let summary

const observer = ({ request, response }) => {
  if (request.socket.localPort !== listener?.port) return
  response.once('finish', () => httpRequests.push({
    method: request.method,
    path: request.url.replaceAll(token, '<token>'),
    content_type: request.headers['content-type'],
    status: response.statusCode,
  }))
}
const serverChannel = channel('http.server.request.start')
const stub = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url.split('?', 1)[0] === '/v1/models') {
      backgroundRequests.push({ method: request.method, path: request.url })
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}')
      return
    }
    if (request.method === 'POST' && request.url === '/v1/analytics/codex/turn-costs') {
      backgroundRequests.push({ method: request.method, path: request.url })
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      return
    }
    assert.equal(request.method, 'POST', `Unexpected request: ${request.method} ${request.url}`)
    assert.equal(request.url, '/v1/responses')
    let body = ''
    for await (const chunk of request) {
      body += chunk
      assert.ok(body.length < 2_000_000)
    }
    const input = JSON.parse(body)
    assert.equal(input.model, model)
    assert.equal(input.stream, true)
    assert.ok(requests.length < 2)
    const output = input.input.find((item) => item.type === 'custom_tool_call_output' && item.call_id === callId)
    const round = requests.length + 1
    assert.equal(Boolean(output), round === 2)
    if (output) assert.ok(JSON.stringify(output.output).includes(marker))
    requests.push({ method: request.method, path: request.url, model: input.model, round, tool_output_received: Boolean(output) })
    const items = round === 1 ? [{
      type: 'custom_tool_call', id: callId, call_id: callId, namespace: 'functions', name: 'exec',
      input: `const result = await tools.exec_command({cmd:"printf ${marker}",login:false});text(result)`,
      status: 'completed',
    }] : [{
      type: 'message', id: 'aang_a5_final', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'A5_OK' }],
    }]
    const id = `resp_aang_a5_${round}`
    const events = [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      ...items.map((item, index) => ({ type: 'response.output_item.done', output_index: index, item })),
      { type: 'response.completed', response: { id, status: 'completed', output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  } catch (error) {
    stubError ??= error
    response.writeHead(400).end('A.5 stub rejected request')
  }
})

try {
  await mkdir(profile, { mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })
  await copyFile(join(originalProfile, 'auth.json'), join(profile, 'auth.json'))
  await chmod(join(profile, 'auth.json'), 0o600)
  collector = createCollector({
    spool: join(root, 'spool'),
    runtimeRoots: { codex: join(root, 'empty-codex'), claude: join(root, 'empty-claude') },
    config: Config.parse({ collector: { fsWatch: false } }),
    adapters: new Map(),
  })
  pumping = (async () => {
    for await (const batch of collector.start([])) {
      records.push(...batch.records)
      gaps.push(...batch.gaps)
      await collector.ack(batch)
    }
  })().catch((error) => { pumpError = error })
  listener = await collector.listenOtel({ port: 0, token })
  assert.equal(listener.host, '127.0.0.1')
  serverChannel.subscribe(observer)
  stub.listen(0, '127.0.0.1')
  await once(stub, 'listening')
  const baseUrl = `http://127.0.0.1:${stub.address().port}/v1`
  const endpoint = `http://${listener.host}:${listener.port}/otel/${token}/v1/logs`
  const overrides = [
    'model_provider="a5_stub"',
    'model_providers.a5_stub.name="A.5 local Responses stub"',
    `model_providers.a5_stub.base_url="${baseUrl}"`,
    'model_providers.a5_stub.wire_api="responses"',
    'model_providers.a5_stub.requires_openai_auth=false',
    'model_providers.a5_stub.supports_websockets=false',
    'model_providers.a5_stub.request_max_retries=0',
    'model_providers.a5_stub.stream_max_retries=0',
    'approval_policy="never"',
    'analytics.enabled=false',
    'check_for_update_on_startup=false',
    'otel.environment="aang-a5-token-live"',
    'otel.log_user_prompt=false',
    `otel.exporter.otlp-http.endpoint="${endpoint}"`,
    'otel.exporter.otlp-http.protocol="json"',
    'otel.trace_exporter="none"',
    'otel.metrics_exporter="none"',
  ]
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--color', 'never', '-C', workspace, '-m', model, '-s', 'read-only',
    ...overrides.flatMap((value) => ['-c', value]), 'Run the supplied local tool call and finish.',
  ]
  const env = {
    PATH: process.env.PATH, HOME: homedir(), TMPDIR: tmpdir(), CODEX_HOME: profile,
    OTEL_BLRP_SCHEDULE_DELAY: '100',
  }
  const version = (await run(binary, ['--version'], { env })).stdout.trim()
  const started = new Date().toISOString()
  const execution = run(binary, args, { env, cwd: workspace, timeout: 60_000, maxBuffer: 2_000_000 })
  execution.child.stdin.end()
  const result = await execution
  const finished = new Date().toISOString()
  if (stubError) throw stubError
  assert.equal(requests.length, 2)
  const stdout = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
  const thread = stdout.find((event) => event.type === 'thread.started')?.thread_id
  assert.ok(thread)
  assert.ok(stdout.some((event) => event.type === 'item.completed' && event.item.type === 'command_execution' && event.item.exit_code === 0 && event.item.aggregated_output === marker))
  assert.ok(stdout.some((event) => event.type === 'item.completed' && event.item.type === 'agent_message' && event.item.text === 'A5_OK'))
  assert.ok(stdout.some((event) => event.type === 'turn.completed'))
  for (let attempt = 0; records.length === 0 && attempt < 50; attempt += 1) await pause(100)
  assert.equal(pumpError, undefined)
  assert.equal(gaps.length, 0)
  assert.equal(records.length, 1)
  const record = records[0]
  assert.equal(record.channel, 'otel')
  assert.equal(record.runtime, 'codex')
  const payload = JSON.parse(record.payload)
  const resource = payload.resourceLogs[0]
  const scope = resource.scopeLogs[0]
  const log = scope.logRecords[0]
  const attributes = Object.fromEntries(log.attributes.map(({ key, value }) => [key, value.stringValue]))
  assert.equal(attributes['event.name'], 'codex.tool_decision')
  assert.equal(attributes.source, 'Config')
  assert.equal(attributes.decision, 'approved')
  assert.equal(attributes['conversation.id'], thread)
  assert.equal(attributes.tool_name, 'exec_command')
  assert.ok(attributes.call_id)
  assert.ok(httpRequests.length > 0)
  assert.ok(httpRequests.every((request) => request.method === 'POST' && request.path === '/otel/<token>/v1/logs' && request.content_type === 'application/json' && request.status === 200))
  const acceptedRequests = [...httpRequests]
  const rejected = await fetch(endpoint.replace(token, `${token}x`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: record.payload,
  })
  await rejected.arrayBuffer()
  assert.equal(rejected.status, 404)
  await pause(200)
  assert.equal(records.length, 1)
  assert.equal(gaps.length, 0)
  const safeKeys = new Set(['event.name', 'source', 'decision', 'tool_name', 'call_id', 'conversation.id'])
  const safeResourceKeys = new Set(['service.name', 'service.version', 'deployment.environment'])
  summary = {
    task: 'A.5', started, finished, repository_commit: (await run('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname })).stdout.trim(),
    platform: { os: process.platform, arch: arch(), release: release(), node: process.version, codex: version },
    isolation: { temporary_profile: true, auth_copied: true, auth_unchanged_in_copy: await digest(join(profile, 'auth.json')) === before['auth.json'], user_files_unchanged: (await fingerprints()), cleanup_complete: false },
    provider_background_requests: backgroundRequests, model_requests: requests, model_usage: 'Synthetic usage from the local stub; no remote model calls.',
    command: { binary, args: args.map((arg) => arg.replaceAll(baseUrl, 'http://127.0.0.1:<responses-port>/v1').replaceAll(endpoint, 'http://127.0.0.1:<otel-port>/otel/<token>/v1/logs').replaceAll(workspace, '<temporary-workspace>')) },
    cli: { exit_code: 0, stdout, stderr: result.stderr.replaceAll(root, '<temporary-root>') },
    otlp_http: acceptedRequests,
    collector: { record_count: records.length, gap_count: gaps.length, channel: record.channel, runtime: record.runtime, position: record.position, observed_at: String(record.observed_at), envelope: { resourceLogs: [{ resource: { attributes: resource.resource.attributes.filter(({ key }) => safeResourceKeys.has(key)) }, scopeLogs: [{ scope: scope.scope, logRecords: [{ timeUnixNano: log.timeUnixNano, attributes: log.attributes.filter(({ key }) => safeKeys.has(key)) }] }] }] } },
    wrong_token: { status: rejected.status, record_count_after: records.length },
  }
  assert.equal(summary.isolation.auth_unchanged_in_copy, true)
  assert.deepEqual(summary.isolation.user_files_unchanged, before)
  summary.isolation.user_files_unchanged = Object.fromEntries(Object.keys(before).map((name) => [name, true]))
} finally {
  serverChannel.unsubscribe(observer)
  try {
    if (collector) await collector.close()
    if (pumping) await pumping
  } finally {
    try {
      if (stub.listening) {
        const closed = once(stub, 'close')
        stub.closeAllConnections()
        stub.close()
        await closed
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
summary.isolation.cleanup_complete = true
console.log(JSON.stringify(summary, null, 2))
