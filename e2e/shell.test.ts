import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endpoints, type RunId } from '@aang/contract'
import { aangHomePaths } from '@aang/contract/home'
import { sampleScenarioManifest } from '@aang/testkit'
import type { Locator, Page, Route } from '@playwright/test'
import { aangEntry, expect, test } from './fixtures.js'
import { claudeOriginal, codexThread, hookFields, runOf, sessionFile } from './samples.js'
import { fact, lamp } from './screens.js'

const claudeSession = claudeOriginal.session
const claudeRun = runOf(claudeOriginal)
const codexRun = runOf(codexThread)
const claudeProject = 'projects/-tmp-aang-spike-cc-transcripts-run'

const watchAll = { watch: { all: true } }

test.use({ config: watchAll })

const runRow = (page: Page, runtime: string): Locator =>
  page.getByRole('row').filter({ has: page.getByRole('link', { name: new RegExp(`^${runtime}, начат`) }) })

test('a Claude session without hook events shows inactive hooks and the files-only mode until hooks arrive (E2E 9)', async ({
  page,
  player,
  profile,
  hook,
}) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto('/')

  const row = runRow(page, 'Claude Code')
  await expect(row).toContainText('hooks не активны')
  await expect(row).toContainText('только файлы')
  await expect(row).toContainText('цель не определена')
  await expect(lamp(page, 'Hooks')).toHaveText('Hooks не активны в 1 сессии')
  await lamp(page, 'Hooks').getByRole('button').click()
  await expect(page.getByRole('region', { name: 'Hooks: подробности' })).toContainText(
    'Claude Code: hooks не активны в 1 сессии, режим «только файлы».',
  )
  await expect(lamp(page, 'Версии')).toHaveText('Версии 1 версия без полной поддержки')
  await lamp(page, 'Версии').getByRole('button').click()
  await expect(page.getByRole('region', { name: 'Версии: подробности' })).toHaveText(
    /^Claude Code \d+\.\d+\.\d+ \(поверхность не определена\), (macos|linux|windows), local: не проверена, 1 сессия\.$/,
  )

  await row.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?run=${claudeRun}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Claude Code, начат/)
  await expect(fact(page, 'Свежесть')).toHaveText('hooks не активны')
  await expect(fact(page, 'Режим')).toHaveText('только файлы')
  await expect(lamp(page, 'Режим')).toHaveText('Режим только файлы')
  await lamp(page, 'Режим').getByRole('button').click()
  await expect(page.getByRole('region', { name: 'Режим: подробности' })).toHaveText(
    'Сессия 86f93ed5: только файлы — hooks не активны, события берутся из файлов сессии.',
  )

  await expect(fact(page, 'Внимание')).toHaveText('нет')

  await hook.claude('PermissionRequest.Bash.json', hookFields(profile, claudeOriginal))

  await expect(lamp(page, 'Режим')).toHaveText('Режим полный')
  await expect(fact(page, 'Режим')).toHaveText('полный')
  await expect(fact(page, 'Внимание')).toHaveText('ждут ответа: 1')
  await expect(lamp(page, 'Hooks')).not.toContainText('не активны')

  await page.getByRole('navigation').getByRole('link', { name: 'Прогоны' }).click()
  await expect(runRow(page, 'Claude Code')).toContainText('полный')
  await expect(runRow(page, 'Claude Code')).toContainText('ждут ответа: 1')
  await expect(runRow(page, 'Claude Code')).not.toContainText('hooks не активны')
})

test('a Codex session without hook events shows inactive hooks and the files-only mode (E2E 9)', async ({
  page,
  player,
}) => {
  await page.goto(`/?run=${codexRun}`)
  await expect(page.getByRole('heading', { name: 'Прогон не найден' })).toBeVisible()
  await expect(lamp(page, 'Связь')).toHaveText('Связь прогон не найден')

  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Codex, начат/)
  await expect(fact(page, 'Свежесть')).toHaveText('hooks не активны')
  await expect(lamp(page, 'Режим')).toHaveText('Режим только файлы')
  await expect(lamp(page, 'Hooks')).toHaveText('Hooks не активны в 1 сессии')
  await expect(lamp(page, 'Связь')).toHaveText('Связь поток подключён')

  await page.getByRole('link', { name: 'aang' }).click()
  const row = runRow(page, 'Codex')
  await expect(row).toContainText('hooks не активны')
  await expect(row).toContainText('только файлы')
})

test.describe('a session that loses its hooks mid-session', () => {
  test.use({ config: { ...watchAll, freshness: { hooksInactiveAfterMs: 1_000 } } })

  test('shows inactive hooks and the files-only mode from a turn without hook events until the next hook event', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await hook.claude('UserPromptSubmit.json', { ...hookFields(profile, claudeOriginal), prompt_id: 'hooked-turn' })
    await page.goto(`/?run=${claudeRun}`)
    await expect(fact(page, 'Режим')).toHaveText('полный')
    await expect(fact(page, 'Свежесть')).not.toHaveText('hooks не активны')
    await expect(lamp(page, 'Hooks')).not.toContainText('не активны')

    const prompt = {
      type: 'user',
      sessionId: claudeSession,
      cwd: claudeOriginal.cwd,
      uuid: 'turn-without-hooks',
      promptId: 'turn-without-hooks',
      timestamp: new Date().toISOString(),
      promptSource: 'typed',
      message: { role: 'user', content: 'A turn without hook events' },
    }
    await appendFile(sessionFile(profile, claudeOriginal), `${JSON.stringify(prompt)}\n`)

    await expect(fact(page, 'Свежесть')).toHaveText('hooks не активны')
    await expect(fact(page, 'Режим')).toHaveText('только файлы')
    await expect(lamp(page, 'Hooks')).toHaveText('Hooks не активны в 1 сессии')
    await lamp(page, 'Режим').getByRole('button').click()
    await expect(page.getByRole('region', { name: 'Режим: подробности' })).toHaveText(
      'Сессия 86f93ed5: только файлы — hooks не активны, события берутся из файлов сессии.',
    )

    await hook.claude('Stop.json', hookFields(profile, claudeOriginal))

    await expect(fact(page, 'Режим')).toHaveText('полный')
    await expect(fact(page, 'Свежесть')).not.toHaveText('hooks не активны')
    await expect(lamp(page, 'Hooks')).not.toContainText('не активны')
  })
})

const readRunSummary = async (request: (path: string) => Promise<Response>, run: RunId) => {
  const response = await request(endpoints.run.path.replace(':run', run))
  return response.ok ? endpoints.run.response.parse(await response.json()).summary : null
}

test('the run page follows the stream live and re-reads the run when the stream resets on a replaced database', async ({
  page,
  context,
  player,
  profile,
  daemon,
}) => {
  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
  const claude = await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })
  await claude.play({ until: 'subagent' })
  const transcript = sessionFile(profile, claudeOriginal)
  const beforeSubagent = await readFile(transcript)
  await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.agents).toBe(1)

  await page.goto(`/?run=${claudeRun}`)
  await expect(fact(page, 'Состояние')).toHaveText('выполняется')
  await expect(fact(page, 'Агенты')).toHaveText('1')
  await expect(lamp(page, 'Связь')).toHaveText('Связь поток подключён')

  await claude.play()
  await expect(fact(page, 'Агенты')).toHaveText('2')
  await expect(fact(page, 'Состояние')).toHaveText('ждёт ввода')
  const complete = await readFile(transcript)

  await context.setOffline(true)
  expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
  await expect(lamp(page, 'Связь')).toHaveText('Связь нет связи с демоном')

  for (const file of ['aang.db', 'aang.db-wal', 'aang.db-shm']) {
    await rm(join(profile.aangHome, file), { force: true })
  }
  await rm(join(profile.codex, 'sessions'), { recursive: true, force: true })
  await rm(join(profile.claude, ...claudeProject.split('/'), claudeSession), { recursive: true, force: true })
  await writeFile(transcript, beforeSubagent)
  await profile.configure({ ...watchAll, collector: { rootsScanIntervalMs: 250 }, api: { port: daemon.api.port } })
  const restarted = await profile.startDaemon({ entry: aangEntry })
  expect(restarted.url).toBe(daemon.url)
  await expect.poll(async () => (await readRunSummary(restarted.request, claudeRun))?.agents).toBe(1)

  await context.setOffline(false)
  await expect(fact(page, 'Агенты')).toHaveText('1')
  await expect(fact(page, 'Состояние')).toHaveText('выполняется')
  await expect(lamp(page, 'Связь')).toHaveText('Связь поток подключён')

  await appendFile(transcript, complete.subarray(beforeSubagent.length))
  await expect(fact(page, 'Состояние')).toHaveText('ждёт ввода')
  expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
})

test('the run list says when only the list request fails and shows the run once the request succeeds again', async ({
  page,
  player,
  daemon,
}) => {
  const runsRoute = `**${endpoints.runs.path}`
  const dropRuns = (route: Route): Promise<void> => route.abort('connectionfailed')
  const trouble = page.getByRole('main').getByRole('status')

  await page.route(runsRoute, dropRuns)
  await page.goto('/')
  await expect(trouble).toHaveText('Не удалось загрузить список прогонов. aang повторяет запрос.')
  await expect(lamp(page, 'Связь')).toHaveText('Связь список не обновляется')

  await page.unroute(runsRoute, dropRuns)
  await expect(page.getByRole('heading', { name: 'Прогонов пока нет' })).toBeVisible()
  await expect(trouble).toHaveCount(0)
  await expect(lamp(page, 'Связь')).toHaveText('Связь есть')

  await page.route(runsRoute, dropRuns)
  await expect(trouble).toHaveText('Не удалось обновить список прогонов. Показаны прежние данные, они могут устареть.')
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.agents).toBe(2)
  await expect(page.getByRole('heading', { name: 'Прогонов пока нет' })).toBeVisible()
  await expect(lamp(page, 'Связь')).toHaveText('Связь список не обновляется')
  await lamp(page, 'Связь').getByRole('button').click()
  await expect(page.getByRole('region', { name: 'Связь: подробности' })).toHaveText(
    'Демон не отдал список прогонов. aang повторяет запрос; список на экране может устареть.',
  )

  await page.unroute(runsRoute, dropRuns)
  await expect(runRow(page, 'Claude Code')).toBeVisible()
  await expect(trouble).toHaveCount(0)
  await expect(lamp(page, 'Связь')).toHaveText('Связь есть')
})

test.describe('the status strip', () => {
  test.use({ config: { ...watchAll, spool: { thresholdBytes: 4_096, checkIntervalMs: 50 } } })

  test('lights the lamps for unknown records, a lost source and an overfull spool', async ({
    page,
    player,
    profile,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Прогонов пока нет' })).toBeVisible()
    await expect(page.getByText('aang наблюдает все каталоги.', { exact: false })).toBeVisible()

    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await expect(runRow(page, 'Claude Code')).toBeVisible()
    await expect(lamp(page, 'Записи')).toHaveText('Записи все распознаны')
    await expect(lamp(page, 'Источники')).toHaveText('Источники в порядке')
    await expect(lamp(page, 'Spool')).toHaveText('Spool пуст')

    const transcript = sessionFile(profile, claudeOriginal)
    const unknownRecord = { type: 'h1-future-record', sessionId: claudeSession, cwd: claudeOriginal.cwd }
    await appendFile(transcript, `${JSON.stringify(unknownRecord)}\n`)
    await expect(lamp(page, 'Записи')).toHaveText('Записи всего 1 нераспознанная')
    await lamp(page, 'Записи').getByRole('button').click()
    await expect(page.getByRole('region', { name: 'Записи: подробности' })).toContainText(
      'Записи неизвестного формата сохранены в журнале',
    )

    await rm(transcript)
    await expect(runRow(page, 'Claude Code')).toContainText('источник потерян')
    await expect(lamp(page, 'Источники')).toHaveText('Источники 1 источник потерян')

    await runRow(page, 'Claude Code').getByRole('link').click()
    await expect(fact(page, 'Свежесть')).toHaveText('источник потерян')
    await expect(lamp(page, 'Источники')).toHaveText('Источники 1 источник потерян')
    await lamp(page, 'Источники').getByRole('button').click()
    await expect(page.getByRole('region', { name: 'Источники: подробности' })).toContainText('источник потерян')
    await expect(lamp(page, 'Записи')).toHaveText('Записи в этом прогоне 1 нераспознанная')

    const { spoolReady } = aangHomePaths(profile.aangHome)
    await mkdir(spoolReady, { recursive: true })
    await writeFile(join(spoolReady, 'h1-overflow.evt'), 'x'.repeat(5_000))
    await expect(lamp(page, 'Spool')).toHaveText('Spool превышен порог')
    await lamp(page, 'Spool').getByRole('button').click()
    await expect(page.getByRole('region', { name: 'Spool: подробности' })).toContainText(
      'Аренда снята: hooks не пишут в spool.',
    )
  })
})

test.describe('an empty list with watched directories', () => {
  const watched = join(tmpdir(), 'aang-h1-watched-project')

  test.use({ config: { watch: { roots: [{ path: watched }] } } })

  test('names the directories where a run would come from', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Прогонов пока нет' })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: watched })).toBeVisible()
  })
})
