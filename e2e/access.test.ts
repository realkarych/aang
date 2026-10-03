import { endpoints } from '@aang/contract'
import { expect, test } from './fixtures.js'

test.describe('a browser without the session cookie', () => {
  test.use({ signedIn: false })

  test('is refused by the API and the page, and a one-time link signs it in exactly once (E2E 13)', async ({
    page,
    request,
    signInLink,
    baseURL,
  }) => {
    const api = await request.get(endpoints.runs.path)
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
