import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type ApiError,
  type ApiErrorCode,
  endpoints,
  type Listener,
  type ReparseResponse,
  type ShutdownResponse,
  streamPath,
} from '@aang/contract'
import { z } from 'zod'
import { AdminError } from './admin-error.js'
import type { Authenticator } from './auth.js'
import { type CookieWriteCheck, cookieWriteCheck } from './cookie-writes.js'
import type { Admin } from './ingestion.js'
import { ApiFailure, type ApiRoute, matchRoute } from './routes.js'
import { serveStatic } from './static.js'
import type { Streams } from './stream.js'

export interface ServerOptions {
  readonly listener: Listener
  readonly auth: Authenticator
  readonly staticRoot: string | null
  readonly routes: (address: Listener) => readonly ApiRoute[]
  readonly streams: Streams
  readonly reparse: () => Promise<ReparseResponse | null>
  readonly admin: Admin
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
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  unsupported_media_type: 415,
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

export const startServer = async ({
  listener,
  auth,
  staticRoot,
  routes,
  streams,
  reparse,
  admin,
  onShutdown,
}: ServerOptions): Promise<RunningServer> => {
  const acceptsBody = async (
    request: IncomingMessage,
    response: ServerResponse,
    schema: z.ZodType,
    refusal: string,
  ): Promise<boolean> => {
    let body: unknown
    try {
      body = await readJson(request)
    } catch (error) {
      sendError(response, 'invalid_request', error instanceof Error ? error.message : String(error))
      return false
    }
    if (!schema.safeParse(body).success) {
      sendError(response, 'invalid_request', refusal)
      return false
    }
    return true
  }

  const shutdown = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!(await acceptsBody(request, response, endpoints.shutdown.body, 'shutdown takes an empty JSON object'))) {
      return
    }
    response.on('finish', onShutdown)
    const accepted: ShutdownResponse = { stopping: true }
    sendJson(response, 200, accepted)
  }

  const reparseRecords = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!(await acceptsBody(request, response, endpoints.reparse.body, 'reparse takes an empty JSON object'))) {
      return
    }
    const result = await reparse()
    if (result === null) {
      sendError(response, 'unavailable', 'the daemon is stopping')
      return
    }
    sendJson(response, 200, endpoints.reparse.response.encode(result))
  }

  const serveAdmin = async <S extends z.ZodType, R extends z.ZodType>(
    request: IncomingMessage,
    response: ServerResponse,
    spec: { readonly body: S; readonly response: R },
    handle: (body: z.output<S>) => Promise<z.output<R>>,
  ): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(request)
    } catch (error) {
      sendError(response, 'invalid_request', error instanceof Error ? error.message : String(error))
      return
    }
    const parsed = spec.body.safeParse(body)
    if (!parsed.success) {
      sendError(response, 'invalid_request', z.prettifyError(parsed.error))
      return
    }
    try {
      sendJson(response, 200, spec.response.encode(await handle(parsed.data)))
    } catch (error) {
      if (error instanceof AdminError) {
        sendError(response, error.code, error.message)
        return
      }
      throw error
    }
  }

  const adminRoute = <S extends z.ZodType, R extends z.ZodType>(
    spec: { readonly method: string; readonly path: string; readonly body: S; readonly response: R },
    handle: (body: z.output<S>) => Promise<z.output<R>>,
  ) => ({
    method: spec.method,
    path: spec.path,
    serve: (request: IncomingMessage, response: ServerResponse) => serveAdmin(request, response, spec, handle),
  })

  const adminRoutes = [
    adminRoute(endpoints.watch, admin.watch),
    adminRoute(endpoints.unwatch, admin.unwatch),
    adminRoute(endpoints.prune, admin.prune),
  ]

  const routeApi = async (
    table: readonly ApiRoute[],
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    const { pathname, searchParams: search } = url
    const method = request.method ?? 'GET'
    if (method === endpoints.shutdown.method && pathname === endpoints.shutdown.path) {
      await shutdown(request, response)
      return
    }
    if (method === endpoints.reparse.method && pathname === endpoints.reparse.path) {
      await reparseRecords(request, response)
      return
    }
    if (method === 'GET' && pathname === streamPath) {
      const refusal = streams.open(request, response, search)
      if (refusal !== null) {
        sendError(response, refusal.code, refusal.message)
      }
      return
    }
    const adminMatch = adminRoutes.find((route) => route.method === method && route.path === pathname)
    if (adminMatch !== undefined) {
      await adminMatch.serve(request, response)
      return
    }
    const match = matchRoute(table, method, pathname)
    if (match === null) {
      sendError(response, 'not_found', `no route for ${method} ${pathname}`)
      return
    }
    const body = async (): Promise<unknown> => {
      try {
        return await readJson(request)
      } catch (error) {
        throw new ApiFailure('invalid_request', error instanceof Error ? error.message : String(error))
      }
    }
    try {
      sendJson(response, 200, await match.route.serve({ pathname, params: match.params, search, body }))
    } catch (error) {
      if (error instanceof ApiFailure) {
        sendError(response, error.code, error.message)
        return
      }
      throw error
    }
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

  const handle = async (
    table: readonly ApiRoute[],
    checkCookieWrite: CookieWriteCheck,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://daemon.invalid')
    const { pathname } = url
    if (pathname.startsWith(authPrefix) && request.method === 'GET') {
      await redeemLink(response, pathname.slice(authPrefix.length))
      return
    }
    const api = isApiPath(pathname)
    const credential = await auth.credential(request)
    if (credential === null) {
      if (api) {
        sendError(response, 'unauthorized', 'a bearer token or the aang session cookie is required')
      } else {
        sendText(response, 401, 'Not signed in. Run `aang open` to get a sign-in link.')
      }
      return
    }
    const refusal = credential === 'cookie' ? checkCookieWrite(request) : null
    if (refusal !== null) {
      if (api) {
        sendError(response, refusal.code, refusal.message)
      } else {
        sendText(response, statuses[refusal.code], refusal.message)
      }
      return
    }
    if (api) {
      await routeApi(table, request, response, url)
      return
    }
    await serveStatic(staticRoot, pathname, request, response)
  }

  const server = createServer()
  server.listen(listener.port, listener.host)
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const address: Listener = { host: listener.host, port }
  const table = routes(address)
  const checkCookieWrite = cookieWriteCheck(port)
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('x-content-type-options', 'nosniff')
    handle(table, checkCookieWrite, request, response).catch((error: unknown) => {
      process.stderr.write(`aang daemon: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      if (response.headersSent) {
        response.destroy()
      } else {
        sendError(response, 'internal', 'internal error')
      }
    })
  })
  return {
    address,
    close: async () => {
      const closed = once(server, 'close')
      streams.close()
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
