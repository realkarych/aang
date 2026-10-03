import { randomBytes } from 'node:crypto'
import type { Store } from '@aang/store'
import { z } from 'zod'
import { epochNow } from './spool.js'

const otelTokenSetting = 'otel_token'

const OtelToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const otelToken = (store: Store): string => {
  const saved = store.settings.get(otelTokenSetting)
  if (saved !== undefined) {
    return OtelToken.parse(saved)
  }
  const token = randomBytes(32).toString('base64url')
  store.transaction((transaction) => {
    transaction.settings.save(otelTokenSetting, token, epochNow())
  })
  return token
}
