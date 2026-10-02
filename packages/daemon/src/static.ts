import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const decodedPath = (pathname: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(pathname)
    return decoded.includes('\0') ? undefined : decoded
  } catch {
    return undefined
  }
}

const locate = (root: string, pathname: string): string | undefined => {
  const decoded = decodedPath(pathname)
  if (decoded === undefined) {
    return undefined
  }
  const file = resolve(root, decoded === '/' ? 'index.html' : `.${decoded}`)
  const inside = relative(root, file)
  return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? undefined : file
}

const regularFileSize = async (file: string): Promise<number | undefined> =>
  stat(file).then(
    (stats) => (stats.isFile() ? stats.size : undefined),
    () => undefined,
  )

const plain = (response: ServerResponse, status: number, text: string): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`${text}\n`)
}

export const serveStatic = async (
  root: string | null,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    plain(response, 405, 'method not allowed')
    return
  }
  const file = root === null ? undefined : locate(root, pathname)
  const size = file === undefined ? undefined : await regularFileSize(file)
  if (file === undefined || size === undefined) {
    plain(response, 404, 'not found')
    return
  }
  response.writeHead(200, {
    'content-type': contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-cache',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  await pipeline(createReadStream(file), response)
}
