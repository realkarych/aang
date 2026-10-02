import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { isAlive } from './processes.js'
import { createSandbox, type Sandbox, startedPid } from './sandbox.js'

const signInLink = /^(http:\/\/127\.0\.0\.1:[0-9]+)\/auth\/[A-Za-z0-9_-]{43}$/

const openLink = async (sandbox: Sandbox): Promise<{ link: string; base: string }> => {
  const opened = await sandbox.aang('open')
  const link = opened.stdout.trim()
  const base = signInLink.exec(link)?.[1]
  if (opened.code !== 0 || base === undefined) {
    throw new Error(`aang open failed: ${opened.stdout}${opened.stderr}`)
  }
  return { link, base }
}

const uiToken = async (sandbox: Sandbox): Promise<string> =>
  (await readFile(join(sandbox.aangHome, 'token'), 'utf8')).trim()

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

const sessionCookie = (response: Response): string => {
  const cookie = response.headers.get('set-cookie') ?? ''
  return cookie.split(';')[0] ?? ''
}

describe.concurrent('UI access needs the token; aang open hands it out through a one-time link', () => {
  test('requests without a valid token are refused, the one-time link works once and its cookie authorizes', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const pid = startedPid(await sandbox.aang('start'))
    const { link, base } = await openLink(sandbox)
    const route = `${base}/api/admin/no-such-route`

    const anonymous = await fetch(route)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer realm="aang"')
    expect(await anonymous.json()).toMatchObject({ error: { code: 'unauthorized' } })
    expect((await fetch(route, { headers: bearer('A'.repeat(43)) })).status).toBe(401)
    expect((await fetch(`${base}/`)).status).toBe(401)

    const signIn = await fetch(link, { redirect: 'manual' })
    expect(signIn.status).toBe(200)
    expect(signIn.headers.get('set-cookie')).toMatch(/^aang_token=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\//)
    expect(await signIn.text()).toContain('<meta http-equiv="refresh" content="0; url=/">')
    const cookie = sessionCookie(signIn)

    expect((await fetch(link, { redirect: 'manual' })).status).toBe(401)
    const withCookie = await fetch(route, { headers: { cookie } })
    expect(withCookie.status).toBe(404)
    expect(await withCookie.json()).toMatchObject({ error: { code: 'not_found' } })
    expect((await fetch(route, { headers: bearer(await uiToken(sandbox)) })).status).toBe(404)

    const shutdown = await fetch(`${base}/api/admin/shutdown`, { method: 'POST', body: '{}' })
    expect(shutdown.status).toBe(401)
    expect(isAlive(pid)).toBe(true)
    expect((await fetch(route, { headers: { cookie } })).status).toBe(404)
  })

  test('token rotate replaces the token, revokes cookies and pending links, and prints the new token', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    await sandbox.aang('start')
    const first = await openLink(sandbox)
    const cookie = sessionCookie(await fetch(first.link, { redirect: 'manual' }))
    const pending = await openLink(sandbox)
    const previous = await uiToken(sandbox)
    const route = `${first.base}/api/admin/no-such-route`

    const rotated = await sandbox.aang('token', 'rotate')

    expect(rotated.code).toBe(0)
    const token = rotated.stdout.trim()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token).not.toBe(previous)
    expect(await uiToken(sandbox)).toBe(token)
    expect((await fetch(route, { headers: { cookie } })).status).toBe(401)
    expect((await fetch(route, { headers: bearer(previous) })).status).toBe(401)
    expect((await fetch(route, { headers: bearer(token) })).status).toBe(404)
    expect((await fetch(pending.link, { redirect: 'manual' })).status).toBe(401)
    expect(await sandbox.aang('stop')).toMatchObject({ code: 0 })
  })

  test('pending links are revoked before a new token is published, even when publication fails', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    await sandbox.aang('start')
    const signedIn = await openLink(sandbox)
    const cookie = sessionCookie(await fetch(signedIn.link, { redirect: 'manual' }))
    const pending = await openLink(sandbox)
    const previous = await uiToken(sandbox)
    const tokenPath = join(sandbox.aangHome, 'token')
    const savedToken = join(sandbox.aangHome, 'saved-token')
    await rename(tokenPath, savedToken)
    await mkdir(tokenPath)
    await writeFile(join(tokenPath, 'block-replacement'), '')

    try {
      const failed = await sandbox.aang('token', 'rotate')

      expect(failed.code).toBe(1)
      expect(failed.stdout).toBe('')
      expect(failed.stderr).toContain('token')
      expect((await readFile(savedToken, 'utf8')).trim()).toBe(previous)
      await expect(readdir(join(sandbox.aangHome, 'auth'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(tokenPath, { recursive: true })
      await rename(savedToken, tokenPath)
    }

    expect((await fetch(pending.link, { redirect: 'manual' })).status).toBe(401)
    const route = `${signedIn.base}/api/admin/no-such-route`
    expect((await fetch(route, { headers: { cookie } })).status).toBe(404)
    const fresh = await openLink(sandbox)
    expect((await fetch(fresh.link, { redirect: 'manual' })).headers.get('set-cookie')).toContain(previous)

    const rotated = await sandbox.aang('token', 'rotate')

    expect(rotated.code).toBe(0)
    const token = rotated.stdout.trim()
    expect(token).not.toBe(previous)
    expect(await uiToken(sandbox)).toBe(token)
    expect((await fetch(pending.link, { redirect: 'manual' })).status).toBe(401)
    expect((await fetch(route, { headers: { cookie } })).status).toBe(401)
    expect((await fetch(route, { headers: bearer(token) })).status).toBe(404)
  })

  test('--bind listens on the given interface with the same token requirement', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const started = await sandbox.aang('start', '--bind', '0.0.0.0')

    expect(started.code).toBe(0)
    expect((await sandbox.daemonState())?.api.host).toBe('0.0.0.0')
    const { base } = await openLink(sandbox)
    const route = `${base}/api/admin/no-such-route`
    expect((await fetch(route)).status).toBe(401)
    expect((await fetch(route, { headers: bearer(await uiToken(sandbox)) })).status).toBe(404)
    expect(await sandbox.aang('stop')).toMatchObject({ code: 0 })
  })

  test('an invalid --bind address fails the start and leaves nothing running', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const started = await sandbox.aang('start', '--bind', '[::1]:70000')

    expect(started.code).toBe(1)
    expect(started.stderr).toContain("invalid --bind address '[::1]:70000'")
    expect(await sandbox.daemonState()).toBeNull()
  })

  test('aang open without a running daemon fails', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const opened = await sandbox.aang('open')

    expect(opened.code).toBe(1)
    expect(opened.stderr).toContain('aang is not running')
  })
})
