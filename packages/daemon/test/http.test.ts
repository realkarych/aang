import { request } from 'node:http'
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readSpoolState } from '@aang/contract/home'
import { BindAddressError, DaemonAlreadyRunningError, runDaemon } from '@aang/daemon'
import { describe, test } from 'vitest'
import { bearer, createHome, type Home, repositoryMatrix, startDaemon, testVersion } from './daemon.js'

const rawGet = (base: string, path: string, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base)
    request({ hostname, port, path, headers }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
      .on('error', reject)
      .end()
  })

const createWebDirectory = async (home: Home): Promise<string> => {
  const web = join(home.root, 'web')
  await mkdir(join(web, 'assets'), { recursive: true })
  await writeFile(join(web, 'index.html'), '<!doctype html><title>aang</title>')
  await writeFile(join(web, 'assets', 'app.js'), 'export const app = 1\n')
  await writeFile(join(home.root, 'secret.txt'), 'outside the web directory')
  return web
}

const issueCode = async (home: Home, ageMs = 0): Promise<string> => {
  const code = randomBytes(32).toString('base64url')
  const file = join(home.paths.authCodes, code)
  await mkdir(home.paths.authCodes, { recursive: true })
  await writeFile(file, '')
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs)
    await utimes(file, then, then)
  }
  return code
}

describe.concurrent('the daemon serves the UI and the API only to holders of the UI token', () => {
  test('static files of the web directory are served after authorization and nothing outside it', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished)
    const { base } = await startDaemon(home, onTestFinished, { staticRoot: await createWebDirectory(home) })
    const auth = bearer(home.token)

    const anonymous = await fetch(`${base}/`)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.text()).toContain('aang open')

    const index = await fetch(`${base}/`, { headers: auth })
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(index.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await index.text()).toBe('<!doctype html><title>aang</title>')

    const script = await fetch(`${base}/assets/app.js`, { headers: auth })
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await script.text()).toBe('export const app = 1\n')

    const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD', headers: auth })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('21')

    expect((await fetch(`${base}/missing.css`, { headers: auth })).status).toBe(404)
    expect((await fetch(`${base}/assets`, { headers: auth })).status).toBe(404)
    expect((await fetch(`${base}/`, { method: 'POST', headers: auth })).status).toBe(405)
    for (const path of ['/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e%5csecret.txt', '/%E0%A4%A', '/a%00']) {
      expect(await rawGet(base, path, auth)).toBe(404)
    }
  })

  test('without a web directory only the API is served', async ({ expect, onTestFinished }) => {
    const home = await createHome(onTestFinished)
    const { base } = await startDaemon(home, onTestFinished)

    expect((await fetch(`${base}/`, { headers: bearer(home.token) })).status).toBe(404)
    expect((await fetch(`${base}/api`, { headers: bearer(home.token) })).status).toBe(404)
  })

  test('a one-time code signs in once, expires after five minutes and must be well-formed', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished)
    const { base } = await startDaemon(home, onTestFinished)
    const code = await issueCode(home)
    const expired = await issueCode(home, 6 * 60_000)
    const stale = await issueCode(home, 6 * 60_000)

    const signIn = await fetch(`${base}/auth/${code}`, { redirect: 'manual' })
    expect(signIn.status).toBe(200)
    expect(signIn.headers.get('set-cookie')).toBe(
      `aang_token=${home.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`,
    )
    expect(signIn.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await readdir(home.paths.authCodes)).toEqual([])
    expect((await fetch(`${base}/auth/${code}`)).status).toBe(401)
    expect((await fetch(`${base}/auth/${expired}`)).status).toBe(401)
    expect((await fetch(`${base}/auth/${stale}`)).status).toBe(401)
    expect((await fetch(`${base}/auth/not-a-code`)).status).toBe(401)

    const cookie = `aang_token=${home.token}`
    expect((await fetch(`${base}/api/x`, { headers: { cookie: `theme=dark; ${cookie}` } })).status).toBe(404)
    expect((await fetch(`${base}/api/x`, { headers: { cookie: 'aang_token=forged' } })).status).toBe(401)
  })

  test('without a UI token file nothing is authorized and no cookie is issued', async ({ expect, onTestFinished }) => {
    const home = await createHome(onTestFinished)
    const { base } = await startDaemon(home, onTestFinished)
    const code = await issueCode(home)
    await rm(home.paths.uiToken)

    expect((await fetch(`${base}/api/x`, { headers: bearer(home.token) })).status).toBe(401)
    expect((await fetch(`${base}/auth/${code}`)).status).toBe(401)
  })

  test('shutdown takes an empty JSON object, answers first, then removes the lease and the state file', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished)
    const daemon = await startDaemon(home, onTestFinished)
    const shutdown = `${daemon.base}/api/admin/shutdown`
    const auth = { ...bearer(home.token), 'content-type': 'application/json' }

    for (const body of ['not json', '{"now":true}', 'x'.repeat(70_000)]) {
      const refused = await fetch(shutdown, { method: 'POST', headers: auth, body })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({ error: { code: 'invalid_request' } })
    }
    expect((await fetch(shutdown, { headers: auth })).status).toBe(404)
    expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).not.toBeNull()

    const accepted = await fetch(shutdown, { method: 'POST', headers: auth, body: '{}' })

    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ stopping: true })
    expect(await daemon.stopped).toBe('shutdown')
    expect(await readSpoolState(home.paths.spool)).toMatchObject({ leaseExpiresAt: null, stopped: false })
    expect(await readdir(home.paths.home)).not.toContain('daemon.json')
  })

  test('aborting the daemon stops it the same way', async ({ expect, onTestFinished }) => {
    const home = await createHome(onTestFinished)
    const daemon = await startDaemon(home, onTestFinished)

    daemon.abort()

    expect(await daemon.stopped).toBe('signal')
    expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).toBeNull()
  })

  test('a second daemon on the same home is refused while the first one runs', async ({ expect, onTestFinished }) => {
    const home = await createHome(onTestFinished)
    const first = await startDaemon(home, onTestFinished)

    await expect(startDaemon(home, onTestFinished)).rejects.toThrow(DaemonAlreadyRunningError)
    expect((await fetch(`${first.base}/api/x`, { headers: bearer(home.token) })).status).toBe(404)
  })

  test.for(['localhost', '127.0.0.1:0'])(
    'the bind address %j replaces the configured listener',
    async (bind, { expect, onTestFinished }) => {
      const home = await createHome(onTestFinished)

      const { ready } = await startDaemon(home, onTestFinished, { bind })

      expect(ready.api.host).toBe(bind.split(':')[0])
      expect(ready.api.port).toBeGreaterThan(0)
    },
  )

  test.for(['[::1]:70000', 'two words', '[::1', '', 'host/path'])(
    'the bind address %j is rejected before the store is opened',
    async (bind, { expect, onTestFinished }) => {
      const home = await createHome(onTestFinished)

      await expect(
        runDaemon({
          version: testVersion,
          environment: { env: { AANG_HOME: home.paths.home }, homedir: home.root },
          bind,
          staticRoot: null,
          supportMatrix: repositoryMatrix,
          placement: 'local',
          signal: new AbortController().signal,
          onReady: () => undefined,
        }),
      ).rejects.toThrow(BindAddressError)
      expect(await readdir(home.paths.home)).not.toContain('aang.lock')
    },
  )
})
