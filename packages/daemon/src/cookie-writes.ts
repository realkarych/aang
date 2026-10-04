import type { IncomingMessage } from 'node:http'
import type { ApiErrorCode } from '@aang/contract'

export interface Refusal {
  readonly code: ApiErrorCode
  readonly message: string
}

export type CookieWriteCheck = (request: IncomingMessage) => Refusal | null

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

const daemonHosts = ['127.0.0.1', 'localhost']

const isJson = (contentType: string | undefined): boolean =>
  contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json'

export const cookieWriteCheck = (port: number): CookieWriteCheck => {
  const daemonUrls = daemonHosts.map((host) => new URL(`http://${host}:${String(port)}`))
  const origins = new Set(daemonUrls.map((url) => url.origin))
  const hosts = new Set(daemonUrls.map((url) => url.host))

  const fromDaemonPage = ({ headers }: IncomingMessage): boolean =>
    headers.origin === undefined
      ? headers['sec-fetch-site'] === 'same-origin' && hosts.has(headers.host ?? '')
      : origins.has(headers.origin)

  return (request) => {
    if (safeMethods.has(request.method ?? 'GET')) {
      return null
    }
    if (!fromDaemonPage(request)) {
      return {
        code: 'forbidden',
        message: 'a change signed in with the session cookie must come from the aang page itself',
      }
    }
    if (!isJson(request.headers['content-type'])) {
      return {
        code: 'unsupported_media_type',
        message: 'a change signed in with the session cookie must have a JSON body (Content-Type: application/json)',
      }
    }
    return null
  }
}
