import { runId } from '@catacomb/contract/ids'
import { sampleScenarioManifest } from '@catacomb/testkit'
import { expect, test } from './fixtures.js'
import { dock } from './screens.js'

const claudeRun = runId({ kind: 'session', runtime: 'claude', session: '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef' })

test.use({ config: { watch: { all: true } } })

test('the run screen is the map with the chat panel beside it and nothing else', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/?run=${claudeRun}`)

  await expect(page.getByRole('region', { name: 'Stage map' })).toBeVisible()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Sessions and agents' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Solver plan' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'View rules' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Run view' })).toHaveCount(0)
  await expect(page.locator('dl.facts')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Usage' })).toHaveCount(0)

  const map = await page.getByRole('region', { name: 'Stage map' }).boundingBox()
  const panel = await dock(page).boundingBox()
  expect(map !== null && panel !== null && panel.x >= map.x + map.width - 1).toBe(true)
})

test('the collapsed chat panel stays collapsed after a reload', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/?run=${claudeRun}`)

  await dock(page).getByRole('button', { name: 'Collapse chat' }).click()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeHidden()
  await page.reload()
  await expect(dock(page).getByRole('button', { name: 'Expand chat' })).toBeVisible()
  await dock(page).getByRole('button', { name: 'Expand chat' }).click()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeVisible()
})

test('the chat panel works when the browser refuses storage', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
  })
  await page.goto(`/?run=${claudeRun}`)

  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeVisible()
  await dock(page).getByRole('button', { name: 'Collapse chat' }).click()
  await expect(dock(page).getByRole('button', { name: 'Expand chat' })).toBeVisible()
})

test('on a narrow screen the chat opens over the map and closes again', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto(`/?run=${claudeRun}`)

  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeHidden()
  await dock(page).getByRole('button', { name: 'Expand chat' }).click()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeVisible()
  await dock(page).getByRole('button', { name: 'Collapse chat' }).click()
  await expect(dock(page).getByRole('region', { name: 'Chat', exact: true })).toBeHidden()
})

test('old usage and changes links open the remaining screens', async ({ page, player }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto('/?view=usage')
  await expect(page.getByRole('link', { name: 'catacomb' })).toBeVisible()
  await expect(page.getByText('No runs yet').or(page.locator(`a[href="?run=${claudeRun}"]`))).toBeVisible()
  await page.goto(`/?run=${claudeRun}&mode=changes`)
  await expect(page.getByRole('region', { name: 'Stage map' })).toBeVisible()
})
