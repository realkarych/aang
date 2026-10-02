import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type ApiError, type ApiErrorCode, endpoints, type Listener, type ShutdownResponse } from '@aang/contract'
import type { Authenticator } from './auth.js'
import { serveStatic } from './static.js'

export interface ServerOptions {
  readonly listener: Listener
  readonly auth: Authenticator
  readonly staticRoot: string | null
  readonly onShutdown: () => void
}

export interface RunningServer {
  readonly address: Listener
  readonly close: () => Promise<void>
}

const bodyLimitBytes = 64 * 1024
const closeGraceMs = 1_000

const statuses: Readonly<Record<ApiErrorCode, number>> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  unavailable: 503,
  internal: 500,
}

const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

const sendError = (response: ServerResponse, code: ApiErrorCode, message: string): void => {
  const body: ApiError = { error: { code, message } }
  sendJson(
    response,
    statuses[code],
    body,
    code === 'unauthorized' ? { 'www-authenticate': 'Bearer realm="aang"' } : {},
  )
}

const sendText = (response: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers })
  response.end(`${text}\n`)
}

const isApiPath = (pathname: string): boolean => pathname === '/api' || pathname.startsWith('/api/')

const authPrefix = '/auth/'

const signedInPage = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/"><title>aang</title>\n'

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > bodyLimitBytes) {
      throw new SyntaxError('request body is too large')
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export const startServer = async ({ listener, auth, staticRoot, onShutdown }: ServerOptions): Promise<RunningServer> => {
  const shutdown = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(request)
    } catch (error) {
      sendError(response, 'invalid_request', error instanceof Error ? error.message : String(error))
      return
    }
    if (!endpoints.shutdown.body.safeParse(body).success) {
      sendError(response, 'invalid_request', 'shutdown takes an empty JSON object')
      return
    }
    response.on('finish', onShutdown)
    const accepted: ShutdownResponse = { stopping: true }
    sendJson(response, 200, accepted)
  }

  const routeApi = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    if (request.method === endpoints.shutdown.method && pathname === endpoints.shutdown.path) {
      await shutdown(request, response)
      return
    }
    sendError(response, 'not_found', `no route for ${request.method ?? 'GET'} ${pathname}`)
  }

  const redeemLink = async (response: ServerResponse, code: string): Promise<void> => {
    await auth.pruneExpiredCodes()
    const cookie = await auth.redeem(code)
    if (cookie === null) {
      sendText(response, 401, 'This sign-in link has expired or was already used. Run `aang open` for a new one.')
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'set-cookie': cookie,
    })
    response.end(signedInPage)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { pathname } = new URL(request.url ?? '/', 'http://daemon.invalid')
    if (pathname.startsWith(authPrefix) && request.method === 'GET') {
      await redeemLink(response, pathname.slice(authPrefix.length))
      return
    }
    const api = isApiPath(pathname)
    if (!(await auth.authorized(request))) {
      if (api) {
        sendError(response, 'unauthorized', 'a bearer token or the aang session cookie is required')
      } else {
        sendText(response, 401, 'Not signed in. Run `aang open` to get a sign-in link.')
      }
      return
    }
    if (api) {
      await routeApi(request, response, pathname)
      return
    }
    await serveStatic(staticRoot, pathname, request, response)
  }

  const server = createServer((request, response) => {
    response.setHeader('x-content-type-options', 'nosniff')
    handle(request, response).catch((error: unknown) => {
      process.stderr.write(`aang daemon: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      if (response.headersSent) {
        response.destroy()
      } else {
        sendError(response, 'internal', 'internal error')
      }
    })
  })
  server.listen(listener.port, listener.host)
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    address: { host: listener.host, port },
    close: async () => {
      const closed = once(server, 'close')
      server.close()
      server.closeIdleConnections()
      const force = setTimeout(() => {
        server.closeAllConnections()
      }, closeGraceMs)
      await closed
      clearTimeout(force)
    },
  }
}
