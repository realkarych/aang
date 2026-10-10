import { execFileSync } from 'node:child_process'
import { mkdir, writeFile as writeText } from 'node:fs/promises'
import { join } from 'node:path'
import { type Agent, endpoints, type FactId, type RunSnapshot, type StageId } from '@aang/contract'
import {
  agentStageTitle,
  checkedCriterionText,
  type ClaudeScenario,
  continuationQuestionText,
  continuedStageTitle,
  goalCriterionText,
  mainStageTitle,
  observerScenarios,
  outlineStageTitles,
  renamedStageTitle,
  reshapedStageTitles,
  sampleScenarioManifest,
} from '@aang/testkit'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
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

const observed = { timeout: 60_000 }

const snapshotOf = async (request: APIRequestContext): Promise<RunSnapshot | null> => {
  const response = await request.get(endpoints.run.path.replace(':run', run))
  return response.status() === 200 ? endpoints.run.response.parse(await response.json()) : null
}

const mapped = async (request: APIRequestContext, title = mainStageTitle): Promise<boolean> => {
  const snapshot = await snapshotOf(request)
  return (
    snapshot !== null &&
    snapshot.model.stages.some((stage) => stage.title === title) &&
    snapshot.summary.observer.pending_facts === 0
  )
}

const settled = async (request: APIRequestContext): Promise<number | null> =>
  (await snapshotOf(request))?.summary.observer.pending_facts ?? null

const stageId = async (request: APIRequestContext, title: string): Promise<StageId> => {
  const stage = (await snapshotOf(request))?.model.stages.find((candidate) => candidate.title === title)
  if (stage === undefined) {
    throw new Error(`the run has no stage ${title}`)
  }
  return stage.id
}

const recordOf = async (request: APIRequestContext, id: FactId): Promise<string> => {
  const response = await request.get(endpoints.fact.path.replace(':id', id))
  return `сырая запись № ${String(endpoints.fact.response.parse(await response.json()).fact.seq)}`
}

const journalRecords = async (request: APIRequestContext, title: string, op: string): Promise<string[]> => {
  const response = await request.get(
    endpoints.stage.path.replace(':run', run).replace(':stage', await stageId(request, title)),
  )
  const { history } = endpoints.stage.response.parse(await response.json())
  const evidence = history.filter((change) => change.op === op).flatMap((change) => change.evidence)
  return (await Promise.all([...new Set(evidence)].map((id) => recordOf(request, id)))).sort()
}

const shownRecords = async (item: Locator): Promise<string[]> =>
  (await item.getByRole('listitem').filter({ hasText: /сырая запись № \d+/ }).allTextContents())
    .map((text) => /сырая запись № \d+/.exec(text)?.[0] ?? text)
    .sort()

const expectGrounds = async (item: Locator, records: readonly string[]): Promise<void> => {
  expect(records.length).toBeGreaterThan(0)
  await item.getByRole('button', { name: /^Основания: / }).click()
  const more = item.getByRole('button', { name: /^Показать все / })
  if (records.length > 6) {
    await more.click()
  }
  await expect(more).toHaveCount(0)
  await expect.poll(() => shownRecords(item)).toEqual(records)
}

const markedVersion = async (page: Page): Promise<string> =>
  /версия карты \d+/.exec((await mark(page).textContent()) ?? '')?.[0] ?? 'нет отметки'

const expectAcceptedTurn = async (page: Page): Promise<void> => {
  await expect(fact(page, 'Агенты')).toHaveText('2', observed)
  await expect(fact(page, 'Состояние')).toHaveText('ждёт ввода', observed)
}

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

const committed = async (directory: string): Promise<string> => {
  await mkdir(directory, { recursive: true })
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  await writeText(join(directory, 'answer.md'), 'Ответ\n')
  git('add', 'answer.md')
  git('-c', 'user.name=aang', '-c', 'user.email=aang@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Answer')
  return git('rev-parse', 'HEAD')
}

const runCheck = async (
  hook: HookSamples,
  fields: HookFields,
  id: string,
  input: Readonly<Record<string, string>>,
  stdout: string,
): Promise<void> => {
  const call = { ...fields, tool_name: 'Bash', tool_use_id: id, tool_input: { ...input, description: 'Run the check' } }
  await hook.claude('PreToolUse.Bash.json', call)
  await hook.claude('PostToolUse.Bash.json', {
    ...call,
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
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
  await expectAcceptedTurn(page)
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

  const report = change(page, 'Результаты', 'report.md')
  await expect(report.locator('code')).toHaveText(/[\\/]cc-transcripts[\\/]run[\\/]report\.md$/)
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

test.describe('with check contracts', () => {
  test.use({
    config: {
      ...watched,
      watch: {
        all: true,
        roots: [
          {
            path: claudeOriginal.cwd,
            contracts: [
              { name: 'tests', command: '^pnpm test$', commitPattern: 'tested commit ([0-9a-f]{40})' },
              { name: 'lint', command: '^pnpm lint$' },
            ],
          },
        ],
      },
    },
  })

  test('criteria the checks revise after the mark are in the changes, a pass without a version apart from a confirmation (E2E 4, rules)', async ({
    page,
    player,
    profile,
    hook,
  }, testInfo) => {
    const repository = testInfo.outputPath('repository')
    const commit = await committed(repository)
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${run}&mode=changes`)
    await expectAcceptedTurn(page)
    await markButton(page).click()
    await expect(since(page)).toContainText(nothingChanged)

    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await runCheck(hook, fields, 'toolu_h7_tests', { command: 'pnpm test' }, 'all tests passed')
    const tests = change(page, 'Пересмотренные решения', 'Критерий «Check "tests" passes»')
    await expect(tests).toContainText('новый')
    await expect(tests).toContainText('пройден без версии')
    await expect(tests).not.toContainText('подтверждён')
    await markButton(page).click()
    await expect(since(page)).toContainText(nothingChanged)

    await runCheck(hook, fields, 'toolu_h7_tests_commit', { command: 'pnpm test', cwd: repository }, `tested commit ${commit}`)
    await runCheck(hook, fields, 'toolu_h7_lint', { command: 'pnpm lint' }, 'no problems')
    await expect(tests).toContainText('изменён')
    await expect(tests).toContainText('было: пройден без версии')
    await expect(tests).toContainText('стало: подтверждён')
    await expect(tests).toContainText('наблюдаемое событие')
    await tests.getByRole('button', { name: /^Основания: / }).click()
    await expect(tests).toContainText('Bash: pnpm test')
    await expect(tests).toContainText(/сырая запись № \d+/)
    const lint = change(page, 'Пересмотренные решения', 'Критерий «Check "lint" passes»')
    await expect(lint).toContainText('новый')
    await expect(lint).toContainText('пройден без версии')
    await expect(lint).not.toContainText('подтверждён')

    await markButton(page).click()
    await expect(since(page)).toContainText(nothingChanged)
  })
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
    await expectAcceptedTurn(page)
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
    await expect(change(page, 'Результаты', 'notes.md')).toContainText('новая версия')
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

const holdChanges = async (page: Page): Promise<() => void> => {
  const held = Promise.withResolvers<undefined>()
  await page.route(changesRead, async (route) => {
    await held.promise
    await route.continue().catch(() => undefined)
  })
  return () => {
    held.resolve(undefined)
  }
}

test('a mark in the changes mode keeps a change the page has not shown yet', async ({
  page,
  context,
  player,
  profile,
  hook,
}) => {
  const question = 'Сверить отчёт с источниками?'
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${run}&mode=changes`)
  await expectAcceptedTurn(page)
  await markButton(page).click()
  await expect(since(page)).toContainText(nothingChanged)

  const release = await holdChanges(page)
  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('UserPromptSubmit.json', fields)
  await ask(hook, fields, question, 'toolu_h7_unseen')
  await expect(zoneItem(page, question)).toContainText('ждёт ответа')
  await expect(since(page)).toContainText(nothingChanged)
  const saved = page.waitForResponse((response) => response.url().endsWith('/viewed'))
  await markButton(page).click()
  expect((await saved).status()).toBe(200)

  release()
  await expect(change(page, 'Вопросы и запросы', question)).toContainText('открыт')
  const returned = await context.newPage()
  await returned.goto(`/?run=${run}&mode=changes`)
  await expect(change(returned, 'Вопросы и запросы', question)).toContainText('открыт')
  await returned.close()
})

test('a changes read that hangs times out, says so and recovers without a reload', async ({
  page,
  player,
  profile,
  hook,
}) => {
  const question = 'Отложить публикацию?'
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${run}&mode=changes`)
  await expectAcceptedTurn(page)
  await markButton(page).click()
  await expect(since(page)).toContainText(nothingChanged)

  const release = await holdChanges(page)
  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('UserPromptSubmit.json', fields)
  await ask(hook, fields, question, 'toolu_h7_hang')
  await expect(zoneItem(page, question)).toContainText('ждёт ответа')
  await expect(since(page)).toContainText('Изменения не обновляются: демон не ответил.', { timeout: 20_000 })
  await expect(since(page)).toContainText(nothingChanged)
  release()
  await expect(change(page, 'Вопросы и запросы', question)).toContainText('открыт')
  await expect(since(page)).not.toContainText('Изменения не обновляются')
})

test('a failed mark, changes read or grounds read says so and recovers', async ({ page, player, profile, hook }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${run}&mode=changes`)
  await expectAcceptedTurn(page)
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
    await expectAcceptedTurn(page)
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

test.describe('with the observer', () => {
  test.skip(
    process.platform === 'win32',
    'on Windows the fake claude needs node with a script and cannot be the configured observer CLI',
  )

  test.describe('revising the map after the mark', () => {
    test.use({ claudeScenario: observerScenarios['since-last-view'].before })

    test('the since-last-view mode shows the replaced stage, the new stage and the observer question, and the cards open the original (E2E 4)', async ({
      page,
      player,
      fakeClaude,
    }) => {
      const replay = await player(sampleScenarioManifest('claude-fork'), { timeScale: 0, recordTime: 'playback' })
      await replay.play({ until: 'resume' })
      await page.goto(`/?run=${run}&mode=changes`)
      await expectAcceptedTurn(page)
      await expect.poll(() => mapped(page.request), observed).toBe(true)
      await markButton(page).click()
      await expect(since(page)).toContainText(nothingChanged)

      fakeClaude.setScenario(observerScenarios['since-last-view'].after)
      await replay.play({ until: 'fork' })

      const replaced = change(page, 'Пересмотренные решения', `Этап «${mainStageTitle}»`)
      await expect(replaced).toContainText('заменён', observed)
      await expect(replaced).toContainText(`заменён этапом «${continuedStageTitle}»`)
      await expect(replaced).toContainText('интерпретация aang')
      await expect(replaced).toContainText(/журнал карты: версия \d+/)
      await expect.poll(() => settled(page.request), observed).toBe(0)
      const replacement = await journalRecords(page.request, mainStageTitle, 'stage.replace')
      const creation = await journalRecords(page.request, mainStageTitle, 'stage.create')
      expect(replacement.filter((record) => creation.includes(record))).toEqual([])
      await expectGrounds(replaced, replacement)

      const continued = change(page, 'Этапы', `«${continuedStageTitle}»`)
      await expect(continued).toContainText('новый')
      await continued.getByRole('button', { name: /^Основания: / }).click()
      await expect(continued).toContainText(/сырая запись № \d+/)
      const more = continued.getByRole('button', { name: /^Показать все \d+ записей$/ })
      await more.click()
      await expect(more).toHaveCount(0)
      await expect
        .poll(() => continued.getByRole('listitem').filter({ hasText: /сырая запись № \d+/ }).count())
        .toBeGreaterThan(6)

      const question = change(page, 'Вопросы и запросы', continuationQuestionText)
      await expect(question).toContainText('открыт', observed)
      await expect(question).toContainText('от наблюдателя')

      await expect(sinceSection(page, 'Итоги решателя')).toBeVisible(observed)
      const [first] = (await snapshotOf(page.request))?.model.cards ?? []
      expect(first).toBeDefined()
      const card = change(page, 'Итоги решателя', first?.text ?? '')
      await expect(card).toContainText('новая')
      await expect(card).toContainText(`этап «${continuedStageTitle}»`)
      await card.getByRole('button', { name: 'Показать в оригинале' }).click()
      const original = card.getByRole('figure')
      await expect(original.locator('mark')).toHaveText(first?.text ?? '')
      await expect(original).toContainText('сообщение')
      await expect(original).toContainText('решатель')
      await card.getByRole('button', { name: 'Скрыть оригинал' }).click()
      await expect(original).toHaveCount(0)
    })
  })

  test.describe('delegating after the mark', () => {
    test.use({ claudeScenario: observerScenarios['live-map'].live })

    test('the since-last-view mode names the new stage of a delegated agent by its type and short id, with the full title in the tooltip (E2E 4)', async ({
      page,
      player,
    }) => {
      const replay = await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })
      await replay.play({ until: 'subagent' })
      await page.goto(`/?run=${run}&mode=changes`)
      await expect.poll(() => mapped(page.request), observed).toBe(true)
      await markButton(page).click()
      await expect(since(page)).toContainText(nothingChanged)

      await replay.play()
      const delegatedAgent = async (): Promise<Agent | undefined> =>
        (await snapshotOf(page.request))?.objects.agents.find(({ agent_type: type }) => type === 'pinger')
      await expect.poll(async () => (await delegatedAgent()) !== undefined, observed).toBe(true)
      const agent = await delegatedAgent()
      if (agent === undefined) {
        throw new Error('the run has no pinger agent')
      }
      const title = agentStageTitle(agent)
      const shown = title.replace(agent.id, agent.id.slice(0, 8))
      const delegated = change(page, 'Этапы', `«${shown}»`)
      await expect(delegated).toContainText('новый', observed)
      await expect(delegated).not.toContainText(agent.id)
      await expect(delegated.getByTitle(title, { exact: true })).toHaveText(`«${shown}»`)
    })
  })

  test.describe('merging and splitting after the mark', () => {
    test.use({ claudeScenario: observerScenarios['revised-decisions'].before })

    test('the since-last-view mode shows merged and split stages with their successors, a new dependency and revised criteria, each on the grounds of its own change (E2E 4)', async ({
      page,
      context,
      player,
      fakeClaude,
    }) => {
      const replay = await player(sampleScenarioManifest('claude-fork'), { timeScale: 0, recordTime: 'playback' })
      await replay.play({ until: 'resume' })
      await page.goto(`/?run=${run}&mode=changes`)
      await expectAcceptedTurn(page)
      await expect.poll(() => mapped(page.request, outlineStageTitles.publish), observed).toBe(true)
      await markButton(page).click()
      await expect(since(page)).toContainText(nothingChanged)

      fakeClaude.setScenario(observerScenarios['revised-decisions'].after)
      await replay.play({ until: 'fork' })
      const sources = change(page, 'Пересмотренные решения', `Этап «${outlineStageTitles.sources}»`)
      await expect(sources).toContainText('объединён', observed)
      await expect.poll(() => settled(page.request), observed).toBe(0)

      const prepared = `«${reshapedStageTitles.prepared}»`
      await expect(sources).toContainText(`объединён в этап ${prepared}`)
      const draft = change(page, 'Пересмотренные решения', `Этап «${outlineStageTitles.draft}»`)
      await expect(draft).toContainText(`объединён в этап ${prepared}`)
      const check = change(page, 'Пересмотренные решения', `Этап «${outlineStageTitles.check}»`)
      await expect(check).toContainText('разделён')
      await expect(check).toContainText(
        `разделён на этапы «${reshapedStageTitles.facts}», «${reshapedStageTitles.wording}»`,
      )
      await expect(check).toContainText('интерпретация aang')
      const merge = await journalRecords(page.request, outlineStageTitles.sources, 'stage.merge')
      const creation = await journalRecords(page.request, outlineStageTitles.sources, 'stage.create')
      expect(merge.filter((record) => creation.includes(record))).toEqual([])
      await expectGrounds(sources, merge)
      await expectGrounds(check, await journalRecords(page.request, outlineStageTitles.check, 'stage.split'))

      const goal = change(page, 'Пересмотренные решения', `Критерий «${goalCriterionText}»`)
      await expect(goal).toContainText('изменён')
      await expect(goal).toContainText('было: не проверен')
      await expect(goal).toContainText('стало: подтверждён частично')
      await expect(goal).toContainText('интерпретация aang')
      await goal.getByRole('button', { name: /^Основания: / }).click()
      await expect(goal).toContainText(/сырая запись № \d+/)
      const checked = change(page, 'Пересмотренные решения', `Критерий «${checkedCriterionText}»`)
      await expect(checked).toContainText('новый')
      await expect(checked).toContainText('не проверен')
      await expect(checked).not.toContainText('было:')

      for (const title of Object.values(reshapedStageTitles)) {
        await expect(change(page, 'Этапы', `«${title}»`)).toContainText('новый')
      }
      const notify = change(page, 'Этапы', `«${renamedStageTitle}»`)
      await expect(notify).toContainText('изменён')
      await expect(notify).toContainText(`было: «${outlineStageTitles.notify}»`)
      await expect(notify).toContainText(`стало: «${renamedStageTitle}»`)
      await expectGrounds(notify, await journalRecords(page.request, renamedStageTitle, 'stage.update'))
      const publish = change(page, 'Этапы', `«${outlineStageTitles.publish}»`)
      await expect(publish).toContainText('изменён')
      await expect(publish).toContainText(/журнал карты: версия \d+/)
      await expectGrounds(publish, await journalRecords(page.request, outlineStageTitles.publish, 'stage.depends'))

      const returned = await context.newPage()
      const inspector = '**/api/runs/*/stages/*'
      await returned.route(inspector, (route) => route.abort('connectionfailed'))
      await returned.goto(`/?run=${run}&mode=changes`)
      const failed = change(returned, 'Этапы', `«${outlineStageTitles.publish}»`)
      await expect(failed).toContainText('Основания не загружены: демон не ответил.')
      await returned.unroute(inspector)
      await failed.getByRole('button', { name: 'Повторить' }).click()
      await expect(failed.getByRole('button', { name: /^Основания: / })).toBeVisible()
      await returned.close()

      await markButton(page).click()
      await expect(since(page)).toContainText(nothingChanged)
      await expect(since(page)).not.toContainText(outlineStageTitles.sources)
    })
  })

  test.describe('failing and recovering', () => {
    test.use({ claudeScenario: observerScenarios['llm-failure'].healthy })

    test('changes made while the observer is out are in the mode on return and are not announced again after a restart and the recovery (E2E 16)', async ({
      page,
      context,
      player,
      profile,
      hook,
      daemon,
      config,
      fakeClaude,
    }) => {
      const notesPath = `${claudeOriginal.cwd}/notes.md`
      await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })).play()
      await page.goto(`/?run=${run}`)
      await expect.poll(() => mapped(page.request), observed).toBe(true)
      await markButton(page).click()
      await expect(mark(page)).toContainText('Просмотрен только что')

      const failing: ClaudeScenario = {
        replies: [{ kind: 'limit', resetsAt: Math.floor(Date.now() / 1000) + 20 }],
        chatReplies: [],
      }
      fakeClaude.setScenario(failing)
      const fields = hookFields(profile, claudeOriginal)
      await hook.claude('UserPromptSubmit.json', fields)
      await writeFile(hook, fields, notesPath, 'toolu_h7_notes')
      await ask(hook, fields, 'Публиковать заметки?', 'toolu_h7_publish')
      await expect(lamp(page, 'Наблюдатель')).toContainText('исчерпан лимит', observed)

      await sinceTab(page).click()
      await expect(change(page, 'Результаты', 'notes.md')).toContainText('новая версия')
      await expect(change(page, 'Вопросы и запросы', 'Публиковать заметки?')).toContainText('по правилу aang')
      await markButton(page).click()
      await expect(since(page)).toContainText(nothingChanged)
      const marked = await markedVersion(page)

      fakeClaude.setScenario(observerScenarios['llm-failure'].recovered)
      expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
      await profile.configure({
        ...config,
        collector: { rootsScanIntervalMs: 250, spoolScanIntervalMs: 250 },
        cli: { claude: fakeClaude.path },
        api: { port: daemon.api.port },
      })
      const restarted = await profile.startDaemon({ entry: aangEntry })
      await expect(lamp(page, 'Связь')).toHaveText('Связь поток подключён')
      await expect(lamp(page, 'Наблюдатель')).toContainText('работает', { timeout: 90_000 })
      await expect.poll(async () => (await snapshotOf(page.request))?.summary.observer.pending_facts, observed).toBe(0)

      expect(await markedVersion(page)).toBe(marked)
      await expect(since(page)).not.toContainText('notes.md')
      await expect(since(page)).not.toContainText('Публиковать заметки?')
      const returned = await context.newPage()
      await returned.goto(`/?run=${run}&mode=changes`)
      await expect(mark(returned)).toContainText(marked)
      await expect(since(returned)).not.toContainText('notes.md')
      await expect(since(returned)).not.toContainText('Публиковать заметки?')
      await expect(zoneItem(returned, 'Публиковать заметки?')).toContainText('ждёт ответа')
      await returned.close()
      expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
    })
  })
})
