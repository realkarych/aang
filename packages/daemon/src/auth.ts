import { createHash, timingSafeEqual } from 'node:crypto'
import { readdir, rm, stat, unlink } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { type AangHomePaths, AuthCode, readUiToken } from '@aang/contract/home'

export const sessionCookie = 'aang_token'

const codeLifetimeMs = 5 * 60_000
const cookieMaxAgeSeconds = 400 * 24 * 60 * 60

export interface Authenticator {
  readonly authorized: (request: IncomingMessage) => Promise<boolean>
  readonly redeem: (code: string) => Promise<string | null>
  readonly pruneExpiredCodes: () => Promise<void>
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

const ignoreMissing = <T>(error: unknown, fallback: T): T => {
  if (isMissing(error)) {
    return fallback
  }
  throw error
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

const bearerToken = (request: IncomingMessage): string | undefined =>
  /^Bearer +(\S+) *$/i.exec(request.headers.authorization ?? '')?.[1]

const cookieToken = (request: IncomingMessage): string | undefined =>
  (request.headers.cookie ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${sessionCookie}=`))
    ?.slice(sessionCookie.length + 1)

const isExpired = (modifiedMs: number): boolean => Date.now() - modifiedMs > codeLifetimeMs

export const createAuthenticator = (paths: AangHomePaths): Authenticator => {
  const authorized = async (request: IncomingMessage): Promise<boolean> => {
    const token = await readUiToken(paths.uiToken)
    const presented = [bearerToken(request), cookieToken(request)].filter((value) => value !== undefined)
    return token !== null && presented.some((value) => timingSafeEqual(digest(value), digest(token)))
  }

  const pruneExpiredCodes = async (): Promise<void> => {
    const names = await readdir(paths.authCodes).catch((error: unknown) => ignoreMissing(error, []))
    await Promise.all(
      names.map(async (name) => {
        const path = join(paths.authCodes, name)
        const modified = await stat(path).then(
          (stats): number | undefined => stats.mtimeMs,
          (error: unknown) => ignoreMissing<number | undefined>(error, undefined),
        )
        if (modified !== undefined && isExpired(modified)) {
          await rm(path, { force: true })
        }
      }),
    )
  }

  const redeem = async (code: string): Promise<string | null> => {
    const parsed = AuthCode.safeParse(code)
    if (!parsed.success) {
      return null
    }
    const path = join(paths.authCodes, parsed.data)
    try {
      const { mtimeMs } = await stat(path)
      await unlink(path)
      if (isExpired(mtimeMs)) {
        return null
      }
    } catch (error) {
      return ignoreMissing(error, null)
    }
    const token = await readUiToken(paths.uiToken)
    return token === null
      ? null
      : `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(cookieMaxAgeSeconds)}`
  }

  return { authorized, redeem, pruneExpiredCodes }
}
