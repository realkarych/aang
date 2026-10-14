import { endpoints } from '@catacomb/contract'
import { runId } from '@catacomb/contract/ids'
import { mainStageTitle, observerScenarios, preparationStageTitle, sampleScenarioManifest } from '@catacomb/testkit'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { dock } from './screens.js'

const claudeRun = runId({ kind: 'session', runtime: 'claude', session: '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef' })
const observed = { timeout: 30_000 }

const map = (page: Page): Locator => page.getByRole('region', { name: 'Stage map' })
const stage = (page: Page, title: string): Locator => map(page).getByRole('group', { name: `Stage "${title}"` })
const selected = (page: Page): Locator => dock(page).getByRole('region', { name: 'Selected stage' })

test.use({ config: { watch: { all: true } } })

test.describe('with the observer building the map', () => {
  test.skip(process.platform === 'win32', 'the fake claude cannot be the observer CLI on Windows')
  test.use({ claudeScenario: observerScenarios['map-layout'].live })

  test('clicking a stage shows its summary in the chat panel and narrows the chat; whole run clears it', async ({
    page,
    player,
  }) => {
    const played = await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.goto(`/?run=${claudeRun}`)
    await played.play({ until: 'subagent' })
    await expect(stage(page, preparationStageTitle)).toBeVisible(observed)

    await stage(page, preparationStageTitle).getByRole('button', { name: preparationStageTitle, exact: true }).click()
    await expect(page).toHaveURL(/[?&]stage=/)
    await expect(selected(page).getByRole('heading')).toHaveText(preparationStageTitle)
    await expect(selected(page)).toContainText('Execution: done')
    await expect(dock(page).getByText(`Question about stage "${preparationStageTitle}"`)).toBeVisible()
    await expect(page.getByRole('complementary')).toHaveCount(1)

    await selected(page).getByRole('button', { name: 'Whole run' }).click()
    await expect(page).not.toHaveURL(/[?&]stage=/)
    await expect(selected(page)).toHaveCount(0)
    await expect(dock(page).getByText('Question about the whole run.')).toBeVisible()
  })

  test('a stage link opened directly selects the stage and shows its summary', async ({ page, player, daemon }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${claudeRun}`)
    await expect(stage(page, mainStageTitle)).toBeVisible(observed)
    const snapshot = endpoints.run.response.parse(
      await (await daemon.request(endpoints.run.path.replace(':run', claudeRun))).json(),
    )
    const main = snapshot.model.stages.find(({ title }) => title === mainStageTitle)
    expect(main?.summary).toMatch(/^Latest batch: \d+ facts, \d+ actions/)
    await page.goto(`/?run=${claudeRun}&stage=${main?.id ?? ''}`)
    await expect(selected(page).getByRole('heading')).toHaveText(mainStageTitle)
    await expect(selected(page)).toContainText(/Latest batch: \d+ facts, \d+ actions/)
  })

  for (const { screen, width, collapse } of [
    { screen: 'a narrow screen', width: 800, collapse: false },
    { screen: 'a wide screen with the chat collapsed', width: 1400, collapse: true },
  ]) {
    test(`on ${screen} clicking a stage opens the chat panel on its summary`, async ({ page, player }) => {
      await page.setViewportSize({ width, height: 900 })
      await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
      await page.goto(`/?run=${claudeRun}`)
      const main = stage(page, mainStageTitle)
      await expect(main).toBeVisible(observed)
      if (collapse) {
        await dock(page).getByRole('button', { name: 'Collapse chat' }).click()
      }
      await expect(dock(page).getByRole('button', { name: 'Expand chat' })).toBeVisible()
      await expect(selected(page)).toBeHidden()

      await main.getByRole('button', { name: mainStageTitle, exact: true }).click()
      await expect(selected(page).getByRole('heading')).toHaveText(mainStageTitle)
      await expect(selected(page)).toBeVisible()
      await expect(dock(page).getByRole('button', { name: 'Collapse chat' })).toHaveAttribute('aria-expanded', 'true')

      if (collapse) {
        await page.reload()
        await expect(selected(page)).toBeVisible(observed)
        await expect(dock(page).getByRole('button', { name: 'Collapse chat' })).toBeVisible()
      }
    })
  }
})
