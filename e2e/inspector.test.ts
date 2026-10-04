import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endpoints, type RunId, type RunSnapshot, type StageId } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { goalCriterionText, mainStageTitle, observerScenarios, sampleScenarioManifest } from '@aang/testkit'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { aangEntry, expect, test } from './fixtures.js'
import { freshManifest } from './fresh.js'

const claudeSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const claudeRun = runId({ kind: 'session', runtime: 'claude', session: claudeSession })

test.use({ config: { watch: { all: true } } })

test.skip(process.platform === 'win32', 'the fake claude observer runs from one configured path only on macOS and Linux')

const snapshotOf = async (request: APIRequestContext, run: RunId): Promise<RunSnapshot | null> => {
  const response = await request.get(endpoints.run.path.replace(':run', run))
  return response.ok() ? endpoints.run.response.parse(await response.json()) : null
}

const interpreted = async (request: APIRequestContext, run: RunId): Promise<RunSnapshot> => {
  const settled: { snapshot: RunSnapshot | null } = { snapshot: null }
  await expect
    .poll(
      async () => {
        const snapshot = await snapshotOf(request, run)
        settled.snapshot =
          snapshot !== null && snapshot.model.stages.length > 0 && snapshot.summary.observer.pending_facts === 0
            ? snapshot
            : null
        return settled.snapshot !== null
      },
      { timeout: 45_000 },
    )
    .toBe(true)
  if (settled.snapshot === null) {
    throw new Error('the observer must interpret the run')
  }
  return settled.snapshot
}

const stageTitled = (snapshot: RunSnapshot, title: (text: string) => boolean): StageId => {
  const stage = snapshot.model.stages.find((candidate) => title(candidate.title))
  if (stage === undefined) {
    throw new Error('the stage must exist')
  }
  return stage.id
}

const liveSample = (): Promise<string> =>
  freshManifest(sampleScenarioManifest('claude-subagent'), test.info().outputPath('live-sample'))

const inspector = (page: Page): Locator => page.getByRole('complementary')

const section = (page: Page, title: string): Locator =>
  inspector(page).getByRole('region', { name: new RegExp(`^${title}`) })

test('the inspector of a stage shows its axes, criteria, work and relations, and its grounds lead to the raw record (E2E 1)', async ({
  page,
  player,
  fakeClaude,
}) => {
  fakeClaude.setScenario(observerScenarios['live-map'].live)
  await (await player(await liveSample(), { timeScale: 0 })).play()
  const main = stageTitled(await interpreted(page.request, claudeRun), (title) => title === mainStageTitle)

  await page.goto(`/?run=${claudeRun}&stage=${main}`)
  const panel = inspector(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(mainStageTitle)
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused()
  await expect(panel).toContainText('восстановлен наблюдателем')
  await expect(section(page, 'Критерии')).toContainText('The goal of the run is reached')
  await expect(section(page, 'Критерии')).toContainText('не проверен')
  await expect(section(page, 'Участники и действия')).toContainText('Основной агент')
  await expect(section(page, 'Участники и действия').getByRole('list', { name: 'Действия этапа' })).toContainText('echo hi')
  await expect(section(page, 'Время и расход')).toContainText('Расход решателя, токены')

  await section(page, 'Связи').getByRole('link', { name: /^pinger/ }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(/^pinger/)
  await expect(page).toHaveURL(/&stage=/)
  await section(page, 'Связи').getByRole('link', { name: mainStageTitle }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(mainStageTitle)

  const grounds = section(page, 'Основания')
  await grounds.getByRole('button', { name: /^Этап и его описание: \d+ факт/ }).click()
  const prompt = grounds
    .getByRole('list', { name: 'Основания: Этап и его описание' })
    .getByRole('listitem')
    .filter({ hasText: /^Промпт/ })
    .first()
  await expect(prompt).toContainText('человек')
  await prompt.getByRole('button', { name: 'Сырая запись' }).click()
  const raw = prompt.getByRole('region', { name: /^Сырая запись: Промпт/ })
  await expect(raw).toContainText('транскрипт, Claude Code')
  await expect(raw).toContainText(`${claudeSession}.jsonl, строка`)
  await expect(raw.locator('pre')).toContainText(`"sessionId": "${claudeSession}"`)

  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`\\?run=${claudeRun}$`))
})

test('the open inspector follows the model live and lists the observer answer the daemon rejected', async ({
  page,
  player,
  fakeClaude,
}) => {
  fakeClaude.setScenario(observerScenarios['rejected-answer'].live)
  const playback = await player(await liveSample(), { timeScale: 0 })
  await playback.play({ until: 'subagent' })
  const main = stageTitled(await interpreted(page.request, claudeRun), (title) => title === mainStageTitle)

  await page.goto(`/?run=${claudeRun}&stage=${main}`)
  await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText(mainStageTitle)
  await expect(section(page, 'Связи')).toContainText('Связей с другими этапами нет.')

  await playback.play()
  await expect(section(page, 'Связи').getByRole('link', { name: /^pinger/ })).toBeVisible({ timeout: 45_000 })
  const rejected = section(page, 'Отклонённые ответы наблюдателя')
  await expect(rejected).toContainText('Ответ отклонён целиком')
  await expect(rejected).toContainText('нарушает правила модели')
  await expect(rejected).toContainText('операция 1')
})

test('a report written by a Bash command becomes an output, and its saved version opens after the file changed, vanished and the daemon restarted (E2E 17)', async ({
  page,
  player,
  profile,
  daemon,
  fakeClaude,
}) => {
  fakeClaude.setScenario(observerScenarios.report.live)
  const project = join(profile.home, 'project')
  await mkdir(project, { recursive: true })
  const report = join(project, 'report.md')
  const firstVersion = `report-v1\n${'all checks passed\n'.repeat(6_000)}end of report\n`
  await writeFile(report, firstVersion)
  const sample = await freshManifest(sampleScenarioManifest('claude-subagent'), test.info().outputPath('report-sample'), [
    ['/tmp/aang-spike/cc-transcripts/run', project],
    ['"command": "echo hi"', '"command": "echo report-v1 > report.md"'],
  ])
  await (await player(sample, { timeScale: 0 })).play()
  const main = stageTitled(await interpreted(page.request, claudeRun), (title) => title === mainStageTitle)

  await page.goto(`/?run=${claudeRun}&stage=${main}`)
  const outputs = section(page, 'Входы и выходы')
  await expect(outputs.getByRole('list', { name: 'Выходы' })).toContainText(report)
  await expect(outputs).toContainText('сохранена: состояние файла на момент чтения', { timeout: 15_000 })
  await expect(outputs).toContainText('записана действием Bash')

  await writeFile(report, 'report-v2\n')
  await rm(report)
  expect(await readFile(report, 'utf8').catch(() => null)).toBeNull()
  expect(await daemon.stop()).toEqual({ code: 0, signal: null })
  const restarted = await profile.startDaemon({ entry: aangEntry })
  try {
    await page.goto(`${restarted.url}/?run=${claudeRun}&stage=${main}`)
    const saved = section(page, 'Входы и выходы')
    await saved.getByRole('button', { name: 'Открыть сохранённую версию' }).click()
    const version = saved.getByRole('region', { name: `Сохранённая версия: ${report}` })
    await expect(version).toContainText('состояние файла на момент чтения')
    await expect(version.locator('pre')).toHaveText(firstVersion.slice(0, 100_000))
    await expect(version).toContainText('Показаны первые 100 000 символов из 108 024.')
    await version.getByRole('button', { name: 'Показать полностью' }).click()
    await expect(version.locator('pre')).toHaveText(firstVersion)
  } finally {
    expect(await restarted.stop()).toEqual({ code: 0, signal: null })
  }
})

const checkedProject = join(tmpdir(), `aang-e2e-inspector-${String(process.pid)}`)

test.describe('a claim of done over a failed check', () => {
  test.use({
    config: { watch: { roots: [{ path: checkedProject, contracts: [{ name: 'test', command: '^pnpm test' }] }] } },
  })

  test.afterEach(async () => {
    await rm(checkedProject, { recursive: true, force: true })
  })

  test('the inspector shows the claimed done stage with its open failed check and the reported criterion (E2E 3)', async ({
    page,
    profile,
    fakeClaude,
  }) => {
    fakeClaude.setScenario(observerScenarios['claimed-done'].live)
    await mkdir(checkedProject, { recursive: true })
    const session = 'e2e-claimed-done'
    const started = Date.now() - 60_000
    const line = (index: number, type: 'user' | 'assistant', message: Record<string, unknown>): string =>
      JSON.stringify({
        type,
        sessionId: session,
        uuid: `${session}-${String(index)}`,
        parentUuid: index === 0 ? null : `${session}-${String(index - 1)}`,
        timestamp: new Date(started + index * 1_000).toISOString(),
        cwd: checkedProject,
        message,
      })
    const lines = [
      line(0, 'user', { role: 'user', content: 'Run the tests and report.' }),
      line(1, 'assistant', {
        id: 'message-check',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_check', name: 'Bash', input: { command: 'pnpm test' } }],
      }),
      line(2, 'user', {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_check', content: 'Exit code 1\nfailed', is_error: true }],
      }),
      line(3, 'assistant', {
        id: 'message-done',
        role: 'assistant',
        content: [{ type: 'text', text: 'All done: the tests pass.' }],
        stop_reason: 'end_turn',
      }),
    ]
    await profile.write('claude', `projects/e2e-inspector/${session}.jsonl`, `${lines.join('\n')}\n`)
    const run = runId({ kind: 'session', runtime: 'claude', session })
    const main = stageTitled(await interpreted(page.request, run), (title) => title === mainStageTitle)

    await page.goto(`/?run=${run}&stage=${main}`)
    const panel = inspector(page)
    await expect(panel.getByRole('definition').filter({ hasText: 'завершён' }).first()).toContainText('заявление решателя')
    await expect(panel).toContainText('Завершён, но есть упавшая проверка')
    const attention = section(page, 'Внимание')
    await expect(attention).toContainText('Упавшая проверка')
    await expect(attention).toContainText('открыт')
    const criteria = section(page, 'Критерии')
    await expect(criteria).toContainText('агент сообщил о завершении')
    const contract = criteria.getByRole('listitem').filter({ hasText: 'Check "test" passes' })
    await expect(contract).toContainText('не выполнен')
    await expect(contract).toContainText('по контракту проверки test')
    await expect(contract).toContainText('Критерий всего прогона')
    const goal = criteria.getByRole('listitem').filter({ hasText: goalCriterionText })
    await goal.getByRole('button', { name: /^Статус критерия/ }).click()
    await expect(goal.getByRole('list', { name: /^Основания: Статус критерия/ })).toContainText('All done: the tests pass.')
  })
})
