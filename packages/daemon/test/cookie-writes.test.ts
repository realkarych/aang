import { request } from 'node:http'
import { ApiError, type ApiErrorCode, endpoints } from '@aang/contract'
import { describe, test, type TestContext } from 'vitest'
import { bearer, createHome, type Home, type RunningDaemon, startDaemon } from './daemon.js'

type Headers = Readonly<Record<string, string>>

interface Answer {
  readonly status: number
  readonly text: string
}

type Outcome = [number, ApiErrorCode | null]

const accepted: Outcome = [200, null]
const forbidden: Outcome = [403, 'forbidden']
const unsupported: Outcome = [415, 'unsupported_media_type']

const json = { 'content-type': 'application/json' }
const shutdown = endpoints.shutdown.path
const reparse = endpoints.reparse.path

const send = (daemon: RunningDaemon, method: string, path: string, headers: Headers, body = '{}'): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(daemon.base)
    const length = { 'content-length': String(Buffer.byteLength(body)) }
    request({ hostname, port, method, path, headers: { ...length, ...headers } }, (response) => {
      let text = ''
      response
        .setEncoding('utf8')
        .on('data', (chunk: string) => {
          text += chunk
        })
        .on('end', () => {
          resolve({ status: response.statusCode ?? 0, text })
        })
    })
      .on('error', reject)
      .end(body)
  })

const outcome = ({ status, text }: Answer): Outcome => {
  const failure = ApiError.safeParse(JSON.parse(text))
  return [status, failure.success ? failure.data.error.code : null]
}

const write = async (daemon: RunningDaemon, path: string, headers: Headers, method = 'POST'): Promise<Outcome> =>
  outcome(await send(daemon, method, path, headers))

interface SignedIn {
  readonly home: Home
  readonly daemon: RunningDaemon
  readonly cookie: Headers
  readonly elsewhere: string
}

const signedIn = async (onTestFinished: TestContext['onTestFinished']): Promise<SignedIn> => {
  const home = await createHome(onTestFinished)
  const daemon = await startDaemon(home, onTestFinished)
  return {
    home,
    daemon,
    cookie: { cookie: `aang_token=${home.token}` },
    elsewhere: `http://127.0.0.1:${String(daemon.ready.api.port + 1)}`,
  }
}

describe.concurrent('a change signed in with the session cookie must come as JSON from the aang page itself', () => {
  test('a change from another origin is refused with 403 before any route runs, and reads stay open', async ({
    expect,
    onTestFinished,
  }) => {
    const { daemon, cookie, elsewhere } = await signedIn(onTestFinished)
    const { port } = daemon.ready.api
    const foreign: readonly Headers[] = [
      { origin: elsewhere },
      { origin: `http://localhost:${String(port)}` },
      { origin: 'null' },
      { origin: elsewhere, 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site' },
      {},
    ]

    for (const headers of foreign) {
      expect(await write(daemon, shutdown, { ...cookie, ...json, ...headers })).toEqual(forbidden)
    }
    for (const [method, path] of [
      ['DELETE', '/api/bindings/b-1'],
      ['PUT', '/api/runs/r-1/view-rules'],
      ['PATCH', '/api/no-such-route'],
    ] as const) {
      expect(await write(daemon, path, { ...cookie, ...json, origin: elsewhere }, method)).toEqual(forbidden)
    }
    const page = await send(daemon, 'POST', '/', { ...cookie, ...json, origin: elsewhere })
    expect(page.status).toBe(403)
    expect(page.text).toContain('must come from the aang page itself')
    const status = await send(daemon, 'GET', endpoints.status.path, { ...cookie, origin: elsewhere }, '')
    expect(outcome(status)).toEqual(accepted)

    expect(await write(daemon, shutdown, { ...cookie, ...json, origin: daemon.base })).toEqual(accepted)
    expect(await daemon.stopped).toBe('shutdown')
  })

  test('a change from the origin the browser addressed the daemon by passes', async ({ expect, onTestFinished }) => {
    const { daemon, cookie } = await signedIn(onTestFinished)
    const { port } = daemon.ready.api
    const own: readonly Headers[] = [
      { origin: daemon.base },
      { origin: daemon.base, 'content-type': 'Application/JSON; charset=utf-8' },
      { 'sec-fetch-site': 'same-origin' },
      { host: `localhost:${String(port)}`, origin: `http://localhost:${String(port)}` },
      { host: '127.0.0.1:9000', origin: 'http://127.0.0.1:9000' },
      { host: 'aang.example.com', origin: 'https://aang.example.com' },
    ]

    for (const headers of own) {
      expect(await write(daemon, reparse, { ...cookie, ...json, ...headers })).toEqual(accepted)
    }
    expect((await send(daemon, 'POST', '/', { ...cookie, ...json, origin: daemon.base })).status).toBe(405)
  })

  test('a change without a JSON body type is refused with 415, a plain-text shutdown included', async ({
    expect,
    onTestFinished,
  }) => {
    const { daemon, cookie, elsewhere } = await signedIn(onTestFinished)
    const own = { ...cookie, origin: daemon.base }
    const types: readonly Headers[] = [
      { 'content-type': 'text/plain' },
      { 'content-type': 'text/plain;charset=UTF-8' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      { 'content-type': 'multipart/form-data; boundary=aang' },
      { 'content-type': 'application/jsonp' },
      {},
    ]

    for (const headers of types) {
      expect(await write(daemon, shutdown, { ...own, ...headers })).toEqual(unsupported)
    }
    expect(await write(daemon, shutdown, { ...cookie, origin: elsewhere, 'content-type': 'text/plain' })).toEqual(
      forbidden,
    )
    const page = await send(daemon, 'POST', '/', { ...own, 'content-type': 'text/plain' })
    expect(page.status).toBe(415)
    expect(page.text).toContain('Content-Type: application/json')
    expect(await write(daemon, reparse, { ...own, ...json })).toEqual(accepted)
  })

  test('a request with the bearer token, as the CLI sends it, is not affected', async ({ expect, onTestFinished }) => {
    const { home, daemon, cookie, elsewhere } = await signedIn(onTestFinished)
    const token = bearer(home.token)
    const unchecked: readonly Headers[] = [
      {},
      { 'content-type': 'text/plain' },
      { origin: elsewhere },
      { ...cookie, origin: elsewhere },
    ]

    for (const headers of unchecked) {
      expect(await write(daemon, reparse, { ...token, ...headers })).toEqual(accepted)
    }
    const forged = bearer('A'.repeat(43))
    expect(await write(daemon, reparse, { ...forged, ...cookie, ...json, origin: elsewhere })).toEqual(forbidden)
    expect(await write(daemon, shutdown, { ...token, 'content-type': 'text/plain' })).toEqual(accepted)
    expect(await daemon.stopped).toBe('shutdown')
  })
})
