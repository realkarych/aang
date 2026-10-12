import { endpoints } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { mainStageTitle, observerScenarios, preparationStageTitle, sampleScenarioManifest } from '@aang/testkit'
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
    expect(main).toBeDefined()
    await page.goto(`/?run=${claudeRun}&stage=${main?.id ?? ''}`)
    await expect(selected(page).getByRole('heading')).toHaveText(mainStageTitle)
  })
})
