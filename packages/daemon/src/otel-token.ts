import { randomBytes } from 'node:crypto'
import type { Listener } from '@aang/contract'
import type { Store } from '@aang/store'
import { z } from 'zod'
import { epochNow } from './spool.js'

const otelTokenSetting = 'otel_token'

const OtelToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

const saveOtelToken = (store: Store): string => {
  const token = randomBytes(32).toString('base64url')
  store.transaction((transaction) => {
    transaction.settings.save(otelTokenSetting, token, epochNow())
  })
  return token
}

export const otelToken = (store: Store): string => {
  const saved = store.settings.get(otelTokenSetting)
  return saved === undefined ? saveOtelToken(store) : OtelToken.parse(saved)
}

export const rotateOtelToken = (store: Store): string => saveOtelToken(store)

export const otelEndpoint = ({ host, port }: Listener, token: string): string =>
  `http://${host}:${String(port)}/otel/${token}/v1/logs`
