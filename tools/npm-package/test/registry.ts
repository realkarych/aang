import { readFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename } from 'node:path'
import type { PackedPackage } from '../dist/index.js'

export interface Registry {
  readonly url: string
  readonly close: () => Promise<void>
}

const tarballPath = (packed: PackedPackage): string => `/${packed.name}/-/${basename(packed.tarball)}`

const packument = (packed: PackedPackage, url: string): unknown => ({
  name: packed.name,
  'dist-tags': { latest: packed.version },
  versions: {
    [packed.version]: {
      ...packed.manifest,
      _id: `${packed.name}@${packed.version}`,
      dist: { tarball: `${url}${tarballPath(packed)}`, integrity: packed.integrity, shasum: packed.shasum },
    },
  },
})

const send = (response: ServerResponse, status: number, type: string, body: string | Buffer): void => {
  response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

export const startRegistry = async (packages: readonly PackedPackage[]): Promise<Registry> => {
  const tarballs = new Map(
    await Promise.all(packages.map(async (packed) => [tarballPath(packed), await readFile(packed.tarball)] as const)),
  )
  const byName = new Map(packages.map((packed) => [`/${packed.name}`, packed]))
  let url = ''
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://registry.invalid').pathname)
    const packed = byName.get(path)
    const tarball = tarballs.get(path)
    if (packed !== undefined) {
      send(response, 200, 'application/json', JSON.stringify(packument(packed, url)))
    } else if (tarball !== undefined) {
      send(response, 200, 'application/octet-stream', tarball)
    } else {
      send(response, 404, 'application/json', JSON.stringify({ error: 'Not found' }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => {
          if (error === undefined) {
            resolve()
          } else {
            reject(error)
          }
        })
      }),
  }
}
