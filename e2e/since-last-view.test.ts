import { sampleScenarioManifest } from '@aang/testkit'
import type { Page } from '@playwright/test'
import { aangEntry, expect, type HookFields, type HookSamples, test } from './fixtures.js'
import { claudeOriginal, hookFields, runOf } from './samples.js'
import {
  change,
  fact,
  lamp,
  mark,
  markButton,
  plan,
  runRowOf,
  since,
  sinceSection,
  sinceTab,
  trace,
  traceTab,
  zoneItem,
} from './screens.js'

const watched = { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } }

const probe = { command: 'touch probe-perm.txt', description: 'Create empty probe file' }

const nothingChanged = 'С отметки ничего не изменилось.'

const run = runOf(claudeOriginal)

const reportPath = `${claudeOriginal.cwd}/report.md`

const markedVersion = async (page: Page): Promise<string> =>
  /версия карты \d+/.exec((await mark(page).textContent()) ?? '')?.[0] ?? 'нет отметки'

const askUser = (question: string): Readonly<Record<string, unknown>> => ({
  questions: [{ question, header: 'Выбор', options: [{ label: 'Первый' }, { label: 'Второй' }], multiSelect: false }],
})

const writeFile = async (hook: HookSamples, fields: HookFields, path: string, id: string): Promise<void> => {
  const write = {
    ...fields,
    tool_name: 'Write',
    tool_use_id: id,
    tool_input: { file_path: path, content: 'Итоги прогона\n' },
  }
  await hook.claude('PreToolUse.Bash.json', write)
  await hook.claude('PostToolUse.Bash.json', { ...write, tool_response: { type: 'create', filePath: path } })
}

const ask = async (hook: HookSamples, fields: HookFields, question: string, id: string): Promise<void> => {
  await hook.claude('PreToolUse.Bash.json', {
    ...fields,
    tool_name: 'AskUserQuestion',
    tool_use_id: id,
    tool_input: askUser(question),
  })
}

test.use({ config: watched })

test('a view mark, the continued run and the since-last-view mode with a new result, a question and the grounds of each (E2E 4, rules)', async ({
  page,
  player,
  profile,
  hook,
}) => {
  const replay = await player(sampleScenarioManifest('claude-fork'), { timeScale: 0 })
  await replay.play({ until: 'resume' })
  await page.goto(`/?run=${run}`)
  await expect(fact(page, 'Агенты')).toHaveText('2')
  await expect(mark(page)).toContainText('Не отмечен просмотренным')

  await sinceTab(page).click()
  await expect(page).toHaveURL(/mode=changes/)
  await expect(since(page)).toContainText('Прогон ещё не отмечен просмотренным.')
  await expect(since(page)).toContainText('ничего не отправляет решателю')
  await expect(trace(page)).toHaveCount(0)

  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('UserPromptSubmit.json', fields)
  await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h7_probe', tool_input: probe })
  await hook.claude('PermissionRequest.Bash.json', fields)
  await ask(hook, fields, 'Какой формат выбрать?', 'toolu_h7_format')
  await expect(zoneItem(page, 'Bash: touch probe-perm.txt')).toContainText('ждёт ответа')
  await expect(zoneItem(page, 'Какой формат выбрать?')).toContainText('ждёт ответа')

  await markButton(page).click()
  await expect(mark(page)).toContainText('Просмотрен только что')
  await expect(since(page)).toContainText(nothingChanged)
  const marked = await markedVersion(page)

  await replay.play({ until: 'fork' })
  await hook.claude('PostToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h7_probe', tool_input: probe })
  await hook.claude('PostToolUse.Bash.json', {
    ...fields,
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_h7_format',
    tool_input: askUser('Какой формат выбрать?'),
    tool_response: { ...askUser('Какой формат выбрать?'), answers: { 'Какой формат выбрать?': 'Первый' } },
  })
  await hook.claude('PreToolUse.Bash.json', {
    ...fields,
    tool_name: 'TodoWrite',
    tool_use_id: 'toolu_h7_todo',
    tool_input: {
      todos: [
        { content: 'Собрать отчёт', status: 'completed' },
        { content: 'Согласовать отчёт', status: 'in_progress' },
      ],
    },
  })
  await writeFile(hook, fields, reportPath, 'toolu_h7_write')
  await ask(hook, fields, 'Какой отчёт оставить?', 'toolu_h7_ask')

  const question = change(page, 'Вопросы и запросы', 'Какой отчёт оставить?')
  await expect(question).toContainText('открыт')
  await expect(question).toContainText('Вопрос')
  await expect(question).toContainText('по правилу aang')
  await expect(question).toContainText('Сессия 86f93ed5, основной агент')
  const approval = change(page, 'Вопросы и запросы', 'Bash: touch probe-perm.txt')
  await expect(approval).toContainText('закрыт')
  await expect(approval).toContainText('Запрос одобрения')
  const answered = change(page, 'Вопросы и запросы', 'Какой формат выбрать?')
  await expect(answered).toContainText('закрыт')
  await expect(answered).toContainText('получен ответ')

  const report = change(page, 'Результаты', reportPath)
  await expect(report).toContainText('новая версия')
  await expect(report).toContainText('записал Write')
  await expect(report).toContainText('Сессия 86f93ed5, основной агент')

  await expect(sinceSection(page, 'План решателя')).toContainText('Задачи решателя')
  await expect(sinceSection(page, 'План решателя')).toContainText('Согласовать отчёт')
  const main = change(page, 'Действия агентов', 'Основной агент')
  await expect(main).toContainText('Write 1')
  await expect(sinceTab(page)).toHaveAccessibleName(/^С последнего просмотра, \d+ изменени/)
  expect(await markedVersion(page)).toBe(marked)

  await question.getByRole('button', { name: /^Основания: / }).click()
  await expect(question).toContainText('вопрос')
  await expect(question).toContainText(/сырая запись № \d+/)
  await report.getByRole('button', { name: /^Основания: / }).click()
  await expect(report).toContainText(`Write: ${reportPath}`)
  await report.getByRole('button', { name: 'Скрыть основания' }).click()
  await expect(report).not.toContainText(`Write: ${reportPath}`)
  await approval.getByRole('button', { name: /^Основания: / }).click()
  await expect(approval).toContainText('запрос одобрения')
  await expect(approval).toContainText('Bash: touch probe-perm.txt')
  await answered.getByRole('button', { name: /^Основания: / }).click()
  await expect(answered).toContainText(/сырая запись № \d+/)

  await markButton(page).click()
  await expect(since(page)).toContainText(nothingChanged)
  await expect(sinceTab(page)).toHaveAccessibleName('С последнего просмотра')
  expect(await markedVersion(page)).not.toBe(marked)

  await traceTab(page).click()
  await expect(page).not.toHaveURL(/mode=changes/)
  await expect(since(page)).toHaveCount(0)
  await expect(plan(page)).toContainText('Согласовать отчёт')
  await expect(lamp(page, 'Связь')).toHaveText('Связь поток подключён')
})

test.describe('with the LLM unavailable', () => {
  test.use({ claudeScenario: { loggedIn: false } })

  test('a new artifact version and a rule question after the mark are in the changes on return and are not announced again after a restart (E2E 16, rules)', async ({
    page,
    context,
    player,
    profile,
    hook,
    daemon,
    config,
  }) => {
    const notesPath = `${claudeOriginal.cwd}/notes.md`
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${run}`)
    await expect(fact(page, 'Агенты')).toHaveText('2')
    await markButton(page).click()
    await expect(mark(page)).toContainText('Просмотрен только что, версия карты')
    await page.getByRole('navigation', { name: 'Навигация' }).getByRole('link', { name: 'Прогоны' }).click()
    const row = runRowOf(page, run)
    await expect(row).toBeVisible()

    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await writeFile(hook, fields, notesPath, 'toolu_h7_notes')
    await ask(hook, fields, 'Публиковать заметки?', 'toolu_h7_publish')
    await expect(row).toContainText('ждут ответа: 1')

    await row.getByRole('link').click()
    await expect(lamp(page, 'Модель')).toHaveText('Модель не строилась')
    await expect(sinceTab(page)).toHaveAccessibleName(/^С последнего просмотра, \d+ изменени/)
    await sinceTab(page).click()
    await expect(change(page, 'Результаты', notesPath)).toContainText('новая версия')
    await expect(change(page, 'Вопросы и запросы', 'Публиковать заметки?')).toContainText('открыт')

    await markButton(page).click()
    await expect(since(page)).toContainText(nothingChanged)
    const marked = await markedVersion(page)

    expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
    await expect(lamp(page, 'Связь')).toHaveText('Связь нет связи с демоном')
    await profile.configure({
      ...config,
      collector: { rootsScanIntervalMs: 250, spoolScanIntervalMs: 250 },
      api: { port: daemon.api.port },
    })
    const restarted = await profile.startDaemon({ entry: aangEntry })
    await expect(lamp(page, 'Связь')).toHaveText('Связь поток подключён')
    await expect(since(page)).toContainText(nothingChanged)
    expect(await markedVersion(page)).toBe(marked)

    const returned = await context.newPage()
    await returned.goto(`/?run=${run}&mode=changes`)
    await expect(mark(returned)).toContainText(marked)
    await expect(since(returned)).toContainText(nothingChanged)
    await expect(sinceTab(returned)).toHaveAccessibleName('С последнего просмотра')
    await expect(zoneItem(returned, 'Публиковать заметки?')).toContainText('ждёт ответа')
    await returned.close()
    expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
  })
})

const changesRead = (url: URL): boolean => url.pathname.endsWith('/changes')

test('a failed mark, changes read or grounds read says so and recovers', async ({ page, player, profile, hook }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${run}&mode=changes`)
  await expect(since(page)).toContainText('Прогон ещё не отмечен просмотренным.')

  await page.route('**/viewed', (route) => route.abort('connectionfailed'))
  await markButton(page).click()
  await expect(mark(page)).toContainText('Отметка не сохранена: демон не ответил.')
  await expect(mark(page)).toContainText('Не отмечен просмотренным')
  await page.unroute('**/viewed')
  const refusal = { error: { code: 'invalid_request', message: 'the run moved on' } }
  await page.route('**/viewed', (route) => route.fulfill({ status: 400, json: refusal }))
  await markButton(page).click()
  await expect(mark(page)).toContainText('Отметка не сохранена: демон отказал (the run moved on).')
  await page.unroute('**/viewed')

  await page.route(changesRead, (route) => route.abort('connectionfailed'))
  await markButton(page).click()
  await expect(mark(page)).toContainText('Просмотрен только что')
  await expect(mark(page)).not.toContainText('Отметка не сохранена')
  await expect(since(page)).toContainText('Изменения не получены: демон не ответил.')
  await page.unroute(changesRead)
  await expect(since(page)).toContainText(nothingChanged)

  await page.route(changesRead, (route) => route.abort('connectionfailed'))
  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('UserPromptSubmit.json', fields)
  await ask(hook, fields, 'Продолжать без проверки?', 'toolu_h7_continue')
  await expect(zoneItem(page, 'Продолжать без проверки?')).toBeVisible()
  await expect(since(page)).toContainText('Изменения не обновляются: демон не ответил.')
  await expect(since(page)).toContainText(nothingChanged)
  await page.unroute(changesRead)
  const question = change(page, 'Вопросы и запросы', 'Продолжать без проверки?')
  await expect(question).toContainText('открыт')
  await expect(since(page)).not.toContainText('Изменения не обновляются')

  await page.route('**/api/facts/**', (route) => route.abort('connectionfailed'))
  await question.getByRole('button', { name: /^Основания: / }).click()
  await expect(question).toContainText('Основания не загружены: демон не ответил.')
  await page.unroute('**/api/facts/**')
  await question.getByRole('button', { name: 'Повторить' }).click()
  await expect(question).toContainText(/сырая запись № \d+/)
  await expect(question).not.toContainText('Основания не загружены')
})

test.describe('when the sign-in session ends', () => {
  const unauthorized = { error: { code: 'unauthorized', message: 'the session ended' } }

  test('a mark shows the sign-in screen', async ({ page, player }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${run}`)
    await page.route('**/viewed', (route) => route.fulfill({ status: 401, json: unauthorized }))
    await markButton(page).click()
    await expect(page.getByRole('heading', { name: 'Вход не выполнен' })).toBeVisible()
  })

  test('a changes read shows the sign-in screen', async ({ page, player }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${run}&mode=changes`)
    await page.route(changesRead, (route) => route.fulfill({ status: 401, json: unauthorized }))
    await markButton(page).click()
    await expect(page.getByRole('heading', { name: 'Вход не выполнен' })).toBeVisible()
  })

  test('a grounds read shows the sign-in screen', async ({ page, player, profile, hook }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${run}&mode=changes`)
    await markButton(page).click()
    await expect(since(page)).toContainText(nothingChanged)
    const fields = hookFields(profile, claudeOriginal)
    await ask(hook, fields, 'Остановить прогон?', 'toolu_h7_stop')
    const question = change(page, 'Вопросы и запросы', 'Остановить прогон?')
    await page.route('**/api/facts/**', (route) => route.fulfill({ status: 401, json: unauthorized }))
    await question.getByRole('button', { name: /^Основания: / }).click()
    await expect(page.getByRole('heading', { name: 'Вход не выполнен' })).toBeVisible()
  })
})
