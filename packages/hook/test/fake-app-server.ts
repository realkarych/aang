import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import type { AppServerScenario } from './app-server.ts'

const [state = '', ...argv] = process.argv.slice(2)
const scenario = JSON.parse(readFileSync(state, 'utf8')) as AppServerScenario & {
  readonly template: Record<string, unknown>
}
const codexHome = process.env.CODEX_HOME ?? ''
const hooksFile = join(codexHome, 'hooks.json')
let invocation = 0
for (;;) {
  try {
    closeSync(openSync(`${state}.${String(invocation)}.claim`, 'wx'))
    break
  } catch {
    invocation += 1
  }
}

const emit = (value: unknown): void => {
  const output = `${JSON.stringify(value)}\r\n`
  if (scenario.fragmented === true) {
    for (const byte of Buffer.from(output)) {
      process.stdout.write(Buffer.from([byte]))
    }
  } else {
    process.stdout.write(output)
  }
}

const listingFromFile = (): unknown => {
  let document: { hooks?: Record<string, { hooks: { type: string; command?: string }[] }[]> } = {}
  try {
    document = JSON.parse(readFileSync(hooksFile, 'utf8').replace(/^\uFEFF/, '')) as typeof document
  } catch {
    return { data: [{ cwd: process.cwd(), hooks: [], errors: [], warnings: [] }] }
  }
  const hooks = Object.entries(document.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group, i) => group.hooks.map((handler, j) => ({
      ...scenario.template,
      key: `${hooksFile}:${event.replace(/[A-Z]/g, (value, index: number) => `${index === 0 ? '' : '_'}${value.toLowerCase()}`)}:${String(i)}:${String(j)}`,
      eventName: `${event[0]?.toLowerCase() ?? ''}${event.slice(1)}`,
      sourcePath: hooksFile,
      handlerType: handler.type,
      command: handler.command,
    }))),
  )
  return { data: [{ cwd: process.cwd(), hooks, errors: [], warnings: [] }] }
}

let initialized = false
let ready = false
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { method?: string; id?: number; params?: unknown }
  appendFileSync(`${state}.jsonl`, `${JSON.stringify({ pid: process.pid, ppid: process.ppid, argv, cwd: process.cwd(), codexHome, request })}\n`)
  if (argv.join(' ') !== 'app-server' || request.method === undefined) {
    process.exit(2)
  }
  if (invocation === (scenario.failAt ?? 0) && request.method === (scenario.failMethod ?? 'hooks/list')) {
    switch (scenario.failure) {
      case 'timeout':
        setInterval(() => undefined, 60_000)
        continue
      case 'exit':
        process.exit(7)
        break
      case 'invalid_json':
        process.stdout.write('{broken\n')
        continue
      case 'oversized':
        process.stdout.write('x'.repeat(65 * 1024 * 1024))
        continue
      case 'rpc_error':
        emit({ id: request.id, error: { code: -32603, message: 'cannot list hooks' } })
        continue
    }
  }
  if (request.method === 'initialize' && !initialized) {
    const params = request.params as { capabilities?: { experimentalApi?: boolean } }
    if (params.capabilities?.experimentalApi !== true) {
      process.exit(3)
    }
    emit({ method: 'log', params: { message: 'loading' } })
    emit({ id: request.id, result: { userAgent: 'fake-codex', codexHome } })
    initialized = true
  } else if (request.method === 'initialized' && initialized) {
    ready = true
  } else if (request.method === 'hooks/list' && ready) {
    if (scenario.descendant === true) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 60000)'], { stdio: 'ignore' })
      writeFileSync(`${state}.descendant`, String(child.pid))
    }
    emit({ id: 'server-request', method: 'item/commandExecution/requestApproval', params: {} })
    if (scenario.replaceHooks !== undefined && invocation > 0) {
      writeFileSync(hooksFile, scenario.replaceHooks)
    }
    const answer = { id: request.id, result: scenario.listings?.[Math.min(invocation, scenario.listings.length - 1)] ?? listingFromFile() }
    if (scenario.exitAfterListing === true) {
      writeSync(1, `${JSON.stringify(answer)}\r\n`)
      process.kill(process.pid, 'SIGKILL')
    }
    emit(answer)
  } else {
    process.exit(4)
  }
}
