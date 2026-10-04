import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { type CommandResult, createSandbox, type Sandbox } from './sandbox.js'

const otelSection =
  /^\[otel\]\nexporter = \{ otlp-http = \{ endpoint = "(http:\/\/127\.0\.0\.1:[0-9]+\/otel\/([A-Za-z0-9_-]{43})\/v1\/logs)", protocol = "json" \} \}\n$/

const toolDecision = readFile(
  new URL(
    '../../../docs/research/samples/codex-otel/logs.envelope.tool_decision.approved-user.app-server.json',
    import.meta.url,
  ),
  'utf8',
)

interface PrintedSection {
  readonly endpoint: string
  readonly token: string
}

const printedSection = ({ code, stdout, stderr }: CommandResult): PrintedSection => {
  const match = otelSection.exec(stdout)
  if (code !== 0 || match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`aang otel-config did not print the [otel] section: ${String(code)}\n${stdout}${stderr}`)
  }
  return { endpoint: match[1], token: match[2] }
}

const deliver = async (endpoint: string): Promise<number> => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: await toolDecision,
  })
  await response.arrayBuffer()
  return response.status
}

const restart = async (sandbox: Sandbox): Promise<void> => {
  const stopped = await sandbox.aang('stop')
  const started = await sandbox.aang('start')
  if (stopped.code !== 0 || started.code !== 0) {
    throw new Error(`the daemon did not restart: ${stopped.stderr}${started.stderr}`)
  }
}

const daemonBase = async (sandbox: Sandbox): Promise<string> => {
  const state = await sandbox.daemonState()
  if (state === null) {
    throw new Error('the daemon is not running')
  }
  return `http://127.0.0.1:${String(state.api.port)}`
}

describe.concurrent('aang otel-config prints the Codex [otel] section with the ingest endpoint of the running daemon', () => {
  test('the section names the receiver with the ingest token, which stays across calls, UI token rotation and restarts', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await sandbox.aang('start')).code).toBe(0)

    const printed = await sandbox.aang('otel-config')

    const first = printedSection(printed)
    expect(printed.stderr).toBe(
      `aang otel-config: add this section to ${join(sandbox.env.CODEX_HOME ?? '', 'config.toml')} yourself, aang does not change it; then restart the Codex TUI daemon with \`codex app-server daemon restart\` and restart Codex Desktop\n`,
    )
    expect(await deliver(first.endpoint)).toBe(200)
    expect(printedSection(await sandbox.aang('otel-config'))).toEqual(first)
    expect((await sandbox.aang('token', 'rotate')).code).toBe(0)
    expect(printedSection(await sandbox.aang('otel-config'))).toEqual(first)

    await restart(sandbox)

    const restarted = printedSection(await sandbox.aang('otel-config'))
    expect(restarted.token).toBe(first.token)
    expect(await deliver(restarted.endpoint)).toBe(200)
    expect((await sandbox.aang('stop')).code).toBe(0)
  })

  test('--rotate replaces the ingest token: the previous endpoint is refused at once and the new one survives a restart', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await sandbox.aang('start')).code).toBe(0)
    const previous = printedSection(await sandbox.aang('otel-config'))

    const rotated = await sandbox.aang('otel-config', '--rotate')

    const next = printedSection(rotated)
    expect(next.token).not.toBe(previous.token)
    expect(rotated.stderr).toBe(
      `aang otel-config: the OTel ingest token is replaced and the previous endpoint no longer accepts records; replace the [otel] section in ${join(sandbox.env.CODEX_HOME ?? '', 'config.toml')}, then restart the Codex TUI daemon with \`codex app-server daemon restart\` and restart Codex Desktop\n`,
    )
    expect(await deliver(previous.endpoint)).toBe(404)
    expect(await deliver(next.endpoint)).toBe(200)
    expect(printedSection(await sandbox.aang('otel-config'))).toEqual(next)

    await restart(sandbox)

    const restarted = printedSection(await sandbox.aang('otel-config'))
    expect(restarted.token).toBe(next.token)
    expect(await deliver(restarted.endpoint.replace(next.token, previous.token))).toBe(404)
    expect(await deliver(restarted.endpoint)).toBe(200)
    expect((await sandbox.aang('stop')).code).toBe(0)
  })

  test('the endpoint needs the UI token and a body with the rotate flag', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await sandbox.aang('start')).code).toBe(0)
    const base = await daemonBase(sandbox)
    const token = (await readFile(join(sandbox.aangHome, 'token'), 'utf8')).trim()
    const request = (headers: Record<string, string>, body: string): Promise<Response> =>
      fetch(`${base}/api/admin/otel-config`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
      })
    const bearer = { authorization: `Bearer ${token}` }

    const anonymous = await request({}, '{"rotate":true}')
    const empty = await request(bearer, '{}')
    const broken = await request(bearer, '{"rotate":')

    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ error: { code: 'unauthorized' } })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ error: { code: 'invalid_request' } })
    expect(broken.status).toBe(400)
    expect(await broken.json()).toMatchObject({ error: { code: 'invalid_request' } })
    const unchanged = printedSection(await sandbox.aang('otel-config'))
    const answered = await request(bearer, '{"rotate":false}')
    expect(answered.status).toBe(200)
    expect(await answered.json()).toEqual({ endpoint: unchanged.endpoint })
    expect((await sandbox.aang('stop')).code).toBe(0)
  })

  test('otel-config needs a running daemon', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.aang('otel-config')

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'aang otel-config: aang is not running; start it with `aang start`\n',
    })
  })

  test.for([
    { args: ['otel-config', 'now'], message: 'aang otel-config takes no positional arguments' },
    { args: ['otel-config', '--rotate=yes'], message: "Option '--rotate' does not take an argument" },
  ])('aang $args is a usage error', async ({ args, message }, { expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.aang(...args)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
    expect(result.stderr).toContain('otel-config [--rotate]')
  })
})
