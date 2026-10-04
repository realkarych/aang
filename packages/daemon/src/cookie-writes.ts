import type { IncomingMessage } from 'node:http'
import type { ApiErrorCode } from '@aang/contract'

export interface Refusal {
  readonly code: ApiErrorCode
  readonly message: string
}

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])

const fromDaemonOrigin = ({ headers }: IncomingMessage): boolean => {
  if (headers.origin === undefined) {
    return headers['sec-fetch-site'] === 'same-origin'
  }
  return URL.canParse(headers.origin) && new URL(headers.origin).host === headers.host?.toLowerCase()
}

const isJson = (contentType: string | undefined): boolean =>
  contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json'

export const cookieWriteRefusal = (request: IncomingMessage): Refusal | null => {
  if (safeMethods.has(request.method ?? 'GET')) {
    return null
  }
  if (!fromDaemonOrigin(request)) {
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
