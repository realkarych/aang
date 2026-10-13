import { endpoints, RunId } from '@aang/contract'
import { checksBlockerText, checksStageTitle, loadManifest, observerScenarios, sampleScenarioManifest } from '@aang/testkit'
import type { Locator, Page } from '@playwright/test'
import { expect, getWithoutKeepAlive, test } from './fixtures.js'
import { hooksOnly, recording } from './recordings.js'
import { claudeOriginal, runOf } from './samples.js'
import { dock, waitingChip } from './screens.js'

const observed = { timeout: 30_000 }
const map = (page: Page): Locator => page.getByRole('region', { name: 'Stage map' })
const stage = (page: Page, title: string): Locator => map(page).getByRole('group', { name: `Stage "${title}"` })

test.use({ config: { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } } })

test.describe('with the observer opening attention items', () => {
  test.skip(process.platform === 'win32', 'the fake claude cannot be the observer CLI on Windows')
  test.use({ claudeScenario: observerScenarios['attention-zone'].live })

  test('a stage with an open item carries a waiting badge and lists the item when selected', async ({
    page,
    player,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    const run = runOf(claudeOriginal)
    await page.goto(`/?run=${run}`)

    const checks = stage(page, checksStageTitle)
    await expect(checks.getByLabel('Waiting for you')).toHaveText('1', observed)
    await expect(page.getByRole('region', { name: 'Attention', exact: true })).toHaveCount(0)
    await checks.getByRole('button', { name: checksStageTitle, exact: true }).click()
    const selected = dock(page).getByRole('region', { name: 'Selected stage' })
    await expect(selected.getByRole('heading')).toHaveText(checksStageTitle)
    await expect(selected.getByRole('list', { name: 'Waiting for you' })).toContainText(`Blocker: ${checksBlockerText}`)
    await selected.getByRole('button', { name: 'Whole run' }).click()
    await expect(selected).toHaveCount(0)
  })
})

test('a question without a stage is counted in the header, listed on hover once and leaves when answered', async ({
  page,
  player,
}) => {
  const manifest = await loadManifest(recording('claude', '2.1.289', 'claude_cli', 'question'))
  const played = await player(hooksOnly(manifest), { timeScale: 0 })
  await played.play({ until: 'question-answered' })
  await page.goto('/')
  await page.getByRole('row').nth(1).getByRole('link').click()
  const run = RunId.parse(new URL(page.url()).searchParams.get('run'))
  await expect
    .poll(async () => {
      const response = await getWithoutKeepAlive(page.request, endpoints.run.path.replace(':run', run))
      if (!response.ok()) {
        return null
      }
      const { items } = endpoints.run.response.parse(await response.json()).attention
      return items.filter(({ resolution }) => resolution === 'open').map(({ stage: placed }) => placed)
    })
    .toEqual([null])

  const greeting = 'Which greeting should I use?'
  const waiting = waitingChip(page)
  await expect(waiting).toContainText('1', observed)
  await waiting.hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toHaveText(`Question: ${greeting}`)
  await expect(tooltip).not.toContainText('Approval request')

  await played.play()
  await expect(waiting).toHaveCount(0)
})
