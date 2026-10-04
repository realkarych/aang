import { appendFile } from 'node:fs/promises'
import { endpoints, type RunId } from '@aang/contract'
import { sampleScenarioManifest } from '@aang/testkit'
import type { Page } from '@playwright/test'
import { expect, type HookFields, test } from './fixtures.js'
import { claudeOriginal, codexThread, hookFields, runOf, sessionFile } from './samples.js'
import { fact, history, historyToggle, openItems, sessionOf, step, zone, zoneItem } from './screens.js'

const fastSpool = { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } }

const probe = { command: 'touch probe-perm.txt', description: 'Create empty probe file' }

const choice = 'Какой вариант выбрать?'

const askUser = (fields: HookFields, call: string, question: string): HookFields => ({
  ...fields,
  tool_name: 'AskUserQuestion',
  tool_use_id: call,
  tool_input: {
    questions: [{ question, header: 'Выбор', options: [{ label: 'Первый' }, { label: 'Второй' }], multiSelect: false }],
  },
})

const testRun = (fields: HookFields, call: string): HookFields => ({
  ...fields,
  tool_name: 'Bash',
  tool_use_id: call,
  tool_input: { command: 'pnpm test', description: 'Run the tests' },
})

const asyncAsk = 'Proceed with probe?'

const codexAsyncQuestion = (text: string): string => {
  const at = Date.now()
  return `${JSON.stringify({
    timestamp: new Date(at).toISOString(),
    ordinal: 41,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: codexThread.session,
      turn_id: '01a0f755-c3a7-75a1-acf1-7d0839bc2d5c',
      item: {
        type: 'AgentMessage',
        id: 'msg_h3_async_question',
        content: [{ type: 'Text', text: `${text}\n- yes\n- no` }],
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: text, options: ['yes', 'no'] }],
      },
      started_at_ms: at,
      completed_at_ms: at,
    },
  })}\n`
}

const hideBash = async (page: Page, run: RunId): Promise<string> => {
  const response = await page.request.post(endpoints.createViewRule.path.replace(':run', run), {
    data: { action: 'hide', selector: { kind: 'action_tool', tool: 'Bash' }, params: null },
  })
  expect(response.status(), await response.text()).toBe(200)
  return endpoints.createViewRule.response.parse(await response.json()).rule.rule.id
}

test.describe('with a fast spool scan', () => {
  test.use({ config: fastSpool })

  test('a Claude question unanswered at the end of the session stays in the zone, a new prompt does not close it, a viewed item goes down and a dismissed one moves to the history (E2E 15)', async ({
    page,
    context,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    const run = runOf(claudeOriginal)
    await page.goto(`/?run=${run}`)
    await expect(fact(page, 'Агенты')).toHaveText('2')
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', askUser(fields, 'toolu_h3_ask', choice))

    const question = zoneItem(page, choice)
    await expect(question).toContainText('ждёт ответа')
    await expect(question).not.toContainText('сессия завершена')
    await expect(zone(page)).toContainText('решателю ничего не отправляется')

    await hook.claude('SessionEnd.json', fields)
    await expect(question).toContainText('сессия завершена')
    await expect(question).not.toContainText('ждёт ответа')
    await expect(question).toContainText('по времени открытия')
    await expect(sessionOf(page, claudeOriginal.session)).not.toContainText('ждёт человека')

    await hook.claude('SessionStart.resume.json', fields)
    await hook.claude('UserPromptSubmit.json', { ...fields, prompt: 'Запусти линтер и покажи вывод' })
    await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h3_probe', tool_input: probe })
    await hook.claude('PermissionRequest.Bash.json', fields)
    const approval = zoneItem(page, 'Bash: touch probe-perm.txt')
    await expect(approval).toContainText('ждёт ответа')
    await expect(question).not.toContainText('сессия завершена')
    await expect(question).toContainText('по времени открытия')
    await expect(openItems(page)).toHaveCount(2)
    await expect(openItems(page).nth(0)).toContainText('Bash: touch probe-perm.txt')
    await expect(openItems(page).nth(1)).toContainText(choice)

    await approval.getByRole('button', { name: 'Отметить просмотренным' }).click()
    await expect(approval).toContainText('просмотрен')
    await expect(approval).toContainText('ждёт ответа')
    await expect(approval.getByRole('button', { name: 'Отметить просмотренным' })).toHaveCount(0)
    await expect(openItems(page).nth(0)).toContainText(choice)
    await expect(openItems(page).nth(1)).toContainText('Bash: touch probe-perm.txt')
    await expect(fact(page, 'Внимание')).toHaveText('ждут ответа: 1')
    await expect(historyToggle(page)).toHaveCount(0)

    await question.getByRole('button', { name: 'Снять' }).click()
    await expect(question).toHaveCount(0)
    await expect(zone(page).getByRole('status')).toHaveText(`Пункт «${choice}» снят из зоны и сохранён в истории.`)
    await expect(zone(page).getByRole('status')).toBeFocused()
    await expect(openItems(page)).toHaveCount(1)
    await expect(fact(page, 'Внимание')).toHaveText('ждут ответа: 1')
    await expect(step(page, 'Основной агент', choice)).toContainText('ждёт решения')

    await historyToggle(page).click()
    await expect(historyToggle(page)).toHaveText('История: 1 пункт')
    await expect(historyToggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(history(page)).toHaveCount(1)
    await expect(history(page)).toContainText('Вопрос')
    await expect(history(page)).toContainText(choice)
    await expect(history(page)).toContainText('снят пользователем')
    await historyToggle(page).click()
    await expect(history(page)).toHaveCount(0)

    const returned = await context.newPage()
    await returned.goto(`/?run=${run}`)
    await expect(zoneItem(returned, 'Bash: touch probe-perm.txt')).toContainText('просмотрен')
    await expect(openItems(returned)).toHaveCount(1)
    await historyToggle(returned).click()
    await expect(history(returned)).toContainText('снят пользователем')
    await returned.close()
  })

  test('a Codex async question stays in the zone after the session ends and after a new prompt, and its dismissal is kept in the history (E2E 15)', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(codexThread)}`)
    await expect(step(page, 'Основной агент', 'CommandExecution')).toContainText('echo hi')
    const fields = hookFields(profile, codexThread)
    await appendFile(sessionFile(profile, codexThread), codexAsyncQuestion(asyncAsk))

    const question = zoneItem(page, asyncAsk)
    await expect(question).toContainText('Вопрос')
    await expect(question).toContainText('по правилу aang')
    await hook.codex('SessionEnd.json', fields)
    await expect(question).toContainText('сессия завершена')
    await expect(question).not.toContainText('ждёт ответа')

    await hook.codex('UserPromptSubmit.json', { ...fields, prompt: 'Run the linter' })
    await expect(question).not.toContainText('сессия завершена')
    await expect(question).toBeVisible()

    await question.getByRole('button', { name: 'Снять' }).click()
    await expect(question).toHaveCount(0)
    await expect(zone(page)).toContainText('Открытых пунктов нет.')
    await historyToggle(page).click()
    await expect(history(page)).toContainText(asyncAsk)
    await expect(history(page)).toContainText('снят пользователем')
  })

  test('an item of an element that a view rule hides stays in the zone marked as coming from a hidden element', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    const run = runOf(claudeOriginal)
    await page.goto(`/?run=${run}`)
    await expect(fact(page, 'Агенты')).toHaveText('2')
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h3_hidden', tool_input: probe })
    await hook.claude('PermissionRequest.Bash.json', fields)
    const approval = zoneItem(page, 'Bash: touch probe-perm.txt')
    await expect(approval).toContainText('ждёт ответа')
    await expect(approval).not.toContainText('из скрытого элемента')

    const rule = await hideBash(page, run)
    await expect(approval).toContainText('из скрытого элемента')
    await expect(approval).toContainText('ждёт ответа')

    const revoked = await page.request.delete(
      endpoints.revokeViewRule.path.replace(':run', run).replace(':id', encodeURIComponent(rule)),
    )
    expect(revoked.status(), await revoked.text()).toBe(200)
    await expect(approval).not.toContainText('из скрытого элемента')
    await expect(approval).toContainText('ждёт ответа')
  })

  test('a failed mark or dismissal keeps the item and says why, a lost sign-in shows the sign-in screen', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(fact(page, 'Агенты')).toHaveText('2')
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', askUser(fields, 'toolu_h3_failing', choice))
    const question = zoneItem(page, choice)
    await expect(question).toContainText('ждёт ответа')

    await page.route('**/attention/*/viewed', (route) => route.abort('connectionfailed'))
    await question.getByRole('button', { name: 'Отметить просмотренным' }).click()
    await expect(question.getByRole('alert')).toHaveText('Не удалось отметить пункт: нет связи с демоном')
    await expect(question.getByRole('button', { name: 'Отметить просмотренным' })).toBeEnabled()

    await page.route('**/attention/*/dismiss', (route) =>
      route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'the item changed' } } }),
    )
    await question.getByRole('button', { name: 'Снять' }).click()
    await expect(question.getByRole('alert')).toHaveText('Не удалось снять пункт: the item changed')
    await expect(question).toContainText('ждёт ответа')
    await expect(historyToggle(page)).toHaveCount(0)

    await page.unroute('**/attention/*/dismiss')
    await page.route('**/attention/*/dismiss', (route) =>
      route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'signed out' } } }),
    )
    await question.getByRole('button', { name: 'Снять' }).click()
    await expect(page.getByRole('heading', { name: 'Вход не выполнен' })).toBeVisible()
  })
  test('a mark and a dismissal take effect from the answer of the daemon while the live stream is down', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    const run = runOf(claudeOriginal)
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', askUser(fields, 'toolu_h3_offline', choice))
    await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h3_offline_probe', tool_input: probe })
    await hook.claude('PermissionRequest.Bash.json', fields)
    await expect
      .poll(async () => {
        const response = await page.request.get(endpoints.run.path.replace(':run', run))
        return response.ok() ? endpoints.run.response.parse(await response.json()).view.zone.length : 0
      })
      .toBe(2)

    await page.route('**/api/stream?**', (route) => route.abort('connectionfailed'))
    await page.goto(`/?run=${run}`)
    const question = zoneItem(page, choice)
    const approval = zoneItem(page, 'Bash: touch probe-perm.txt')
    await expect(openItems(page)).toHaveCount(2)

    await approval.getByRole('button', { name: 'Отметить просмотренным' }).click()
    await expect(approval).toContainText('просмотрен')
    await question.getByRole('button', { name: 'Снять' }).click()
    await expect(question).toHaveCount(0)
    await expect(zone(page).getByRole('status')).toHaveText(`Пункт «${choice}» снят из зоны и сохранён в истории.`)
    await historyToggle(page).click()
    await expect(history(page)).toContainText('снят пользователем')
  })
})

test.describe('with a check contract on the sample directory', () => {
  test.use({
    config: {
      ...fastSpool,
      watch: { all: true, roots: [{ path: claudeOriginal.cwd, contracts: [{ name: 'test', command: '^pnpm test' }] }] },
    },
  })

  test('a failed check stays in the zone by rule until a successful retry closes it into the history (E2E 3)', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(fact(page, 'Агенты')).toHaveText('2')
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', testRun(fields, 'toolu_h3_test_1'))
    await hook.claude('PostToolUseFailure.Bash.json', {
      ...testRun(fields, 'toolu_h3_test_1'),
      error: 'Exit code 1\n1 test failed',
    })

    const failed = zoneItem(page, 'Упавшая проверка')
    await expect(failed).toContainText('Check "test" failed')
    await expect(failed).toContainText('по правилу aang')
    await expect(failed).toContainText('по времени открытия')
    await expect(failed).not.toContainText('ждёт ответа')
    await expect(fact(page, 'Внимание')).toHaveText('открыто: 1')

    await hook.claude('PreToolUse.Bash.json', testRun(fields, 'toolu_h3_test_2'))
    await hook.claude('PostToolUse.Bash.json', testRun(fields, 'toolu_h3_test_2'))
    await expect(failed).toHaveCount(0)
    await expect(zone(page)).toContainText('Открытых пунктов нет.')
    await historyToggle(page).click()
    await expect(history(page)).toHaveCount(1)
    await expect(history(page)).toContainText('Упавшая проверка')
    await expect(history(page)).toContainText('проверка прошла')
  })
})
