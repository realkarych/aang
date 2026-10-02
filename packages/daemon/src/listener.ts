import type { Listener } from '@aang/contract'

const bracketed = /^\[([^\]]+)\](?::([0-9]+))?$/
const hostAndPort = /^([^:[\]]+):([0-9]+)$/

export class BindAddressError extends Error {
  override readonly name = 'BindAddressError'

  constructor(readonly address: string) {
    super(`invalid --bind address '${address}': expected <host>, <host>:<port> or [<ipv6>]:<port>`)
  }
}

const portOf = (address: string, text: string): number => {
  const port = Number(text)
  if (port > 65_535) {
    throw new BindAddressError(address)
  }
  return port
}

export const resolveListener = (configured: Listener, bind: string | null): Listener => {
  if (bind === null) {
    return configured
  }
  const ipv6 = bracketed.exec(bind)
  if (ipv6?.[1] !== undefined) {
    return { host: ipv6[1], port: ipv6[2] === undefined ? configured.port : portOf(bind, ipv6[2]) }
  }
  const withPort = hostAndPort.exec(bind)
  if (withPort?.[1] !== undefined && withPort[2] !== undefined) {
    return { host: withPort[1], port: portOf(bind, withPort[2]) }
  }
  if (bind.trim() === '' || /[[\]\s/]/.test(bind)) {
    throw new BindAddressError(bind)
  }
  return { host: bind, port: configured.port }
}
