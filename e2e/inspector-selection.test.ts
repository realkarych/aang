import { runId } from '@aang/contract/ids'
import { sampleScenarioManifest } from '@aang/testkit'
import { expect, test } from './fixtures.js'

const claudeRun = runId({ kind: 'session', runtime: 'claude', session: '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef' })

const unknownStage = '00000000-0000-4000-8000-000000000000'

const quietMs = 2_000

test.use({ config: { watch: { all: true } } })

test('a stage chosen by the address opens the inspector, which says when the run has no such stage and closes back to the run', async ({
  page,
  player,
}) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${claudeRun}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Claude Code, начат/)
  await expect(page.getByRole('complementary')).toHaveCount(0)

  await page.goto(`/?run=${claudeRun}&stage=${unknownStage}`)
  const inspector = page.getByRole('complementary', { name: 'Этап 00000000' })
  await expect(inspector.getByRole('heading', { level: 2 })).toBeFocused()
  await expect(inspector).toContainText('В этом прогоне нет этапа 00000000: ссылка устарела или прогон собран заново.')
  await inspector.getByRole('button', { name: 'Закрыть' }).click()
  await expect(page.getByRole('complementary')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`\\?run=${claudeRun}$`))

  await page.goBack()
  await expect(inspector).toBeVisible()
  await inspector.getByRole('heading', { level: 2 }).press('Escape')
  await expect(page.getByRole('complementary')).toHaveCount(0)
})

test('a stage link of a run the daemon does not know yet reads the stage once, not in a loop, again when the run appears, and never after the inspector closes', async ({
  page,
  player,
}) => {
  const reads: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/stages/')) {
      reads.push(request.url())
    }
  })
  await page.goto(`/?run=${claudeRun}&stage=${unknownStage}`)
  await expect(page.getByRole('heading', { name: 'Прогон не найден' })).toBeVisible()
  const inspector = page.getByRole('complementary', { name: 'Этап 00000000' })
  const missing = 'В этом прогоне нет этапа 00000000: ссылка устарела или прогон собран заново.'
  await expect(inspector).toContainText(missing)
  await page.waitForTimeout(quietMs)
  expect(reads).toHaveLength(1)

  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Claude Code, начат/)
  await expect.poll(() => reads.length).toBeGreaterThan(1)
  await expect(inspector).toContainText(missing)

  await inspector.getByRole('button', { name: 'Закрыть' }).click()
  await expect(page.getByRole('complementary')).toHaveCount(0)
  const closed = reads.length
  await page.waitForTimeout(quietMs)
  expect(reads).toHaveLength(closed)
})
