import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { endpoints } from '@aang/contract'
import { expect, getWithoutKeepAlive, test } from './fixtures.js'

test.describe('a browser without the session cookie', () => {
  test.use({ signedIn: false })

  test('is refused by the API and the page, and a one-time link signs it in exactly once (E2E 13)', async ({
    page,
    request,
    signInLink,
    baseURL,
  }) => {
    const api = await getWithoutKeepAlive(request, endpoints.runs.path)
    expect(api.status()).toBe(401)
    expect(await api.json()).toMatchObject({ error: { code: 'unauthorized' } })

    const anonymous = await page.goto('/')
    expect(anonymous?.status()).toBe(401)
    await expect(page.getByText('Not signed in. Run `aang open` to get a sign-in link.')).toBeVisible()

    const link = await signInLink()
    await page.goto(link)
    await expect(page).toHaveURL(`${baseURL ?? ''}/`)
    await expect(page.getByRole('heading', { name: 'Прогонов пока нет' })).toBeVisible()
    await expect(page.getByText('Ни один каталог не отслеживается.', { exact: false })).toBeVisible()
    expect(await page.context().cookies()).toEqual([
      expect.objectContaining({ name: 'aang_token', httpOnly: true, sameSite: 'Strict' }),
    ])

    const reused = await page.goto(link)
    expect(reused?.status()).toBe(401)
    await expect(page.getByText('This sign-in link has expired or was already used.', { exact: false })).toBeVisible()
  })
})

test('an open page asks to sign in again once the token is rotated', async ({ page, aang, daemon }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Прогонов пока нет' })).toBeVisible()

  await aang('token', 'rotate')

  await expect(page.getByRole('heading', { name: 'Вход не выполнен' })).toBeVisible()
  await expect(page.getByRole('main')).toContainText('Выполните в терминале aang open')
  await expect(page).toHaveTitle('Вход не выполнен — aang')

  await aang('stop')
  expect(await daemon.exited, daemon.output()).toEqual({ code: 0, signal: null })
})

test('a page on another port of 127.0.0.1 cannot change anything with the session cookie, the aang page can', async ({
  page,
  context,
  baseURL,
  daemon,
}) => {
  const target = `${baseURL ?? ''}${endpoints.shutdown.path}`
  const attacker = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><script>fetch(${JSON.stringify(target)}, ` +
        `{ method: 'POST', mode: 'no-cors', credentials: 'include', body: '{}' })</script>`,
    )
  })
  attacker.listen(0, '127.0.0.1')
  await once(attacker, 'listening')
  try {
    const { port } = attacker.address() as AddressInfo
    const tab = await context.newPage()
    const answered = tab.waitForResponse(target)
    await tab.goto(`http://127.0.0.1:${String(port)}/`)
    const refused = await answered
    expect(refused.status()).toBe(403)
    await tab.close()
  } finally {
    attacker.close()
  }
  expect(daemon.running()).toBe(true)

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Прогонов пока нет' })).toBeVisible()
  const post = (type: string): Promise<number> =>
    page.evaluate(async ([path, contentType]) => {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': contentType }, body: '{}' })
      return response.status
    }, [endpoints.reparse.path, type] as const)
  expect(await post('text/plain')).toBe(415)
  expect(await post('application/json')).toBe(200)
})
