import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadManifest, sampleScenarioManifest } from '@aang/testkit'
import { expect, type HookFields, test } from './fixtures.js'
import { recording } from './recordings.js'
import { claudeFork, claudeOriginal, codexThread, hookFields, runOf, sessionFile } from './samples.js'
import {
  agentsOf,
  fact,
  lamp,
  openItems,
  plan,
  runRowOf,
  sessionOf,
  step,
  stepsOf,
  textShown,
  trace,
  zone,
  zoneItem,
} from './screens.js'

const watchAll = { watch: { all: true } }

const attentionWithinMs = process.env.CI === undefined ? 1_000 : 3_000

const calmZone = 'Открытых пунктов нет.'

const factRetryMs = 5_000

const probe = { command: 'touch probe-perm.txt', description: 'Create empty probe file' }

interface AskedQuestion {
  readonly question: string
  readonly header: string
  readonly options: readonly { readonly label: string }[]
  readonly multiSelect: boolean
}

const askUser = (question: string): { readonly questions: readonly AskedQuestion[] } => ({
  questions: [{ question, header: 'Выбор', options: [{ label: 'Первый' }, { label: 'Второй' }], multiSelect: false }],
})

const subagentTranscript = (fields: HookFields, agent: string): string =>
  join(dirname(String(fields.transcript_path)), claudeOriginal.session, 'subagents', `agent-${agent}.jsonl`)

test.use({ config: watchAll })

test.describe('with the LLM unavailable', () => {
  test.use({ claudeScenario: { loggedIn: false }, codexScenario: { loggedIn: false } })

  test('a Claude permission request reaches the attention zone within a second (E2E 2)', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(fact(page, 'Агенты')).toHaveText('2')
    await expect(lamp(page, 'Связь')).toHaveText('Связь поток подключён')
    await expect(zone(page)).toContainText(calmZone)

    const sent = Date.now()
    await hook.claude('PermissionRequest.Bash.json', hookFields(profile, claudeOriginal))
    const item = zoneItem(page, 'Bash: touch probe-perm.txt')
    await item.waitFor({ timeout: attentionWithinMs })
    expect(Date.now() - sent).toBeLessThanOrEqual(attentionWithinMs)

    await expect(item).toContainText('Запрос одобрения')
    await expect(item).toContainText('ждёт ответа')
    await expect(item).toContainText('Сессия 86f93ed5, основной агент')
    await expect(item).toContainText('по правилу aang')
    await expect(fact(page, 'Внимание')).toHaveText('ждут ответа: 1')
    await expect(sessionOf(page, claudeOriginal.session)).toContainText('ждёт человека')
    await expect(step(page, 'Основной агент', 'Запрос одобрения')).toContainText('ждёт решения')
    await expect(step(page, 'Основной агент', 'Запрос одобрения')).toContainText('Bash: touch probe-perm.txt')
    await expect(lamp(page, 'Модель')).toHaveText('Модель не строилась')
  })

  test('a Codex permission request reaches the attention zone within a second (E2E 2)', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(codexThread)}`)
    const session = sessionOf(page, codexThread.session)
    await expect(session).toContainText('codex exec 0.159.2')
    await expect(session).toContainText('режим только файлы')
    await expect(session).toContainText(/запуск \d+ окт\./)
    await expect(step(page, 'Основной агент', 'CommandExecution')).toContainText('echo hi')
    await expect(lamp(page, 'Связь')).toHaveText('Связь поток подключён')
    await expect(zone(page)).toContainText(calmZone)

    const sent = Date.now()
    await hook.codex('PermissionRequest.json', hookFields(profile, codexThread))
    const item = zoneItem(page, 'touch /tmp/aang-spike-escalate-probe')
    await item.waitFor({ timeout: attentionWithinMs })
    expect(Date.now() - sent).toBeLessThanOrEqual(attentionWithinMs)

    await expect(item).toContainText('Запрос одобрения')
    await expect(item).toContainText('ждёт ответа')
    await expect(fact(page, 'Внимание')).toHaveText('ждут ответа: 1')
    await expect(session).toContainText('ждёт человека')
    await expect(session).toContainText('режим полный')
    await expect(lamp(page, 'Модель')).toHaveText('Модель не строилась')
  })
})

test.describe('with a short quiet interval', () => {
  test.use({ config: { ...watchAll, freshness: { quietAfterMs: 1_500 }, collector: { spoolScanIntervalMs: 250 } } })

  test('tells waiting for a human, no new events and a lost source apart (E2E 10)', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-fork'), { timeScale: 0 })).play()
    await page.goto('/')
    const original = runRowOf(page, runOf(claudeOriginal))
    const fork = runRowOf(page, runOf(claudeFork))
    await expect(original).toContainText('hooks не активны')
    await expect(fork).toContainText('hooks не активны')

    await hook.claude('PermissionRequest.Bash.json', hookFields(profile, claudeOriginal))
    await hook.claude('UserPromptSubmit.json', hookFields(profile, claudeFork))
    await expect(original).toContainText('ждёт человека')
    await expect(original).toContainText('ждут ответа: 1')
    await expect(fork).toContainText('выполняется')
    await expect(fork).toContainText('нет новых событий')
    await expect(fork).not.toContainText('ждёт человека')
    await expect(fork).not.toContainText('ждут ответа')
    await expect(original).toContainText('ждёт человека')

    await fork.getByRole('link').click()
    const forked = sessionOf(page, claudeFork.session)
    await expect(forked).toContainText('выполняется')
    await expect(forked).toContainText('нет новых событий')
    await expect(fact(page, 'Свежесть')).toHaveText('нет новых событий')
    await expect(zone(page)).toContainText(calmZone)
    await expect(step(page, 'Основной агент', 'Bash')).toContainText('унаследовано из исходной сессии')

    await rm(sessionFile(profile, claudeFork))
    await expect(forked).toContainText('источник потерян')
    await expect(forked).toContainText('выполняется')
    await expect(forked).not.toContainText('нет новых событий')
    await expect(fact(page, 'Свежесть')).toHaveText('источник потерян')
    await expect(zone(page)).toContainText(calmZone)

    await page.getByRole('navigation').getByRole('link', { name: 'Прогоны' }).click()
    await expect(fork).toContainText('источник потерян')
    await original.getByRole('link').click()
    await expect(sessionOf(page, claudeOriginal.session)).toContainText('ждёт человека')
    await expect(sessionOf(page, claudeOriginal.session)).not.toContainText('источник потерян')
    await expect(zoneItem(page, 'Запрос одобрения')).toContainText('ждёт ответа')
  })
})

test.describe('with a fast spool scan', () => {
  test.use({ config: { ...watchAll, collector: { spoolScanIntervalMs: 250 } } })

  test('the false SubagentStop of a Claude compaction does not become an agent, a real subagent does (E2E 12)', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    const replay = await player(sampleScenarioManifest('claude-compaction'), { timeScale: 0 })
    await replay.play({ until: 'compaction' })
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(fact(page, 'Агенты')).toHaveText('2')

    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('PreCompact.manual.json', fields)
    await hook.claude('SubagentStop.internal-compaction.json', {
      ...fields,
      agent_transcript_path: subagentTranscript(fields, 'aba57616e9a18e7bc'),
    })
    await hook.claude('SessionStart.compact.json', fields)
    await hook.claude('PostCompact.manual.json', fields)
    await replay.play()
    await hook.claude('SubagentStart.json', fields)
    await hook.claude('SubagentStop.json', {
      ...fields,
      agent_transcript_path: subagentTranscript(fields, 'a0885622b68c3d0f1'),
    })

    const agents = agentsOf(page, claudeOriginal.session)
    const echoer = agents.getByRole('listitem', { name: 'echoer', exact: true })
    await expect(echoer).toContainText('субагент')
    await expect(echoer).toContainText('завершён')
    await expect(fact(page, 'Агенты')).toHaveText('3')
    await expect(agents.getByRole('listitem', { name: /./ })).toHaveCount(3)
    const spawned = trace(page).getByRole('list', { name: 'Агенты, запущенные: Основной агент' })
    await expect(spawned.getByRole('listitem', { name: 'pinger', exact: true })).toContainText('субагент')
    await expect(sessionOf(page, claudeOriginal.session)).toContainText('режим полный')
    await expect(zone(page)).toContainText(calmZone)
  })

  test('the run page shows sessions, agents, steps and the plan as the solver wrote it before any stage exists', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    const session = sessionOf(page, claudeOriginal.session)
    await expect(session).toContainText('Claude Code 2.1.286')
    await expect(session).toContainText(claudeOriginal.cwd)
    await expect(session).toContainText('ветка HEAD')
    await expect(session).toContainText('ждёт ввода')
    await expect(session).toContainText('hooks не активны')
    await expect(session).toContainText('режим только файлы')
    const spawned = trace(page).getByRole('list', { name: 'Агенты, запущенные: Основной агент' })
    await expect(spawned).toContainText('pinger')
    await expect(spawned).toContainText('субагент')
    await expect(spawned).toContainText('Ping the pinger agent')
    await expect(step(page, 'Основной агент', 'echo hi')).toContainText('Print hi')
    await expect(step(page, 'Основной агент', 'echo hi')).toContainText('успешно')
    await expect(step(page, 'Основной агент', 'Agent')).toContainText('ping')
    await expect(plan(page)).toContainText('Решатель не объявлял план.')
    await expect(zone(page)).toContainText(calmZone)

    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', {
      ...fields,
      tool_name: 'TodoWrite',
      tool_use_id: 'toolu_h2_todo',
      tool_input: {
        todos: [
          { content: 'Прочитать план', status: 'completed' },
          { content: 'Написать тест', status: 'in_progress' },
          { content: 'Открыть PR', status: 'pending' },
        ],
      },
    })
    for (const index of [1, 2, 3, 4, 5]) {
      await hook.claude('PreToolUse.Bash.json', {
        ...fields,
        tool_use_id: `toolu_h2_check_${String(index)}`,
        tool_input: { command: `pnpm test --shard=${String(index)}/5`, description: `Run shard ${String(index)}` },
      })
    }
    await hook.claude('PreToolUse.Bash.json', {
      ...fields,
      tool_name: 'ExitPlanMode',
      tool_use_id: 'toolu_h2_plan',
      tool_input: { plan: 'Сначала тесты.\nПотом PR.' },
    })
    await hook.claude('PermissionRequest.Bash.json', fields)

    const updates = plan(page).getByRole('listitem').filter({ has: page.getByText(/^План на одобрение$|^Задачи решателя$/) })
    await expect(updates).toHaveCount(2)
    await expect(updates.nth(0)).toContainText('План на одобрение')
    await expect(updates.nth(0)).toContainText('Сначала тесты.')
    await expect(updates.nth(0)).not.toContainText('формат записи не проверен')
    await expect(updates.nth(1)).toContainText('Задачи решателя')
    await expect(updates.nth(1)).toContainText('Сессия 86f93ed5, основной агент')
    await expect(updates.nth(1)).toContainText('формат записи не проверен')
    const items = updates.nth(1).getByRole('listitem')
    await expect(items).toHaveCount(3)
    await expect(items.filter({ hasText: 'Прочитать план' })).toContainText('выполнен')
    await expect(items.filter({ hasText: 'Написать тест' })).toContainText('в работе')
    await expect(items.filter({ hasText: 'Открыть PR' })).toContainText('ожидает')

    const zoneItems = openItems(page)
    await expect(zoneItems).toHaveCount(2)
    await expect(zoneItems.nth(0)).toContainText('Вопрос')
    await expect(zoneItems.nth(0)).toContainText('Сначала тесты.')
    await expect(zoneItems.nth(0)).toContainText('ждёт ответа')
    await expect(zoneItems.nth(1)).toContainText('Запрос одобрения')
    await expect(zoneItems.nth(1)).toContainText('Bash: touch probe-perm.txt')
    await expect(fact(page, 'Внимание')).toHaveText('ждут ответа: 2')
    await expect(session).toContainText('ждёт человека')
    await expect(session).toContainText('режим полный')

    const steps = stepsOf(page, 'Основной агент').getByRole('listitem')
    await expect(step(page, 'Основной агент', 'pnpm test --shard=5/5')).toContainText('выполняется')
    await expect(step(page, 'Основной агент', 'План на одобрение')).toContainText('ждёт решения')
    await expect(step(page, 'Основной агент', 'echo hi')).toHaveCount(0)
    await stepsOf(page, 'Основной агент').getByRole('button', { name: 'Показать 2 ранних шага' }).click()
    await expect(step(page, 'Основной агент', 'echo hi')).toBeVisible()
    await expect(steps).toHaveCount(12)
    await stepsOf(page, 'Основной агент').getByRole('button', { name: 'Скрыть ранние шаги' }).click()
    await expect(step(page, 'Основной агент', 'echo hi')).toHaveCount(0)
  })
})

test('a failed input read is retried after a pause while the step stays on screen, not in a loop', async ({
  page,
  player,
}) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  const facts = '**/api/facts/**'
  const reads: string[] = []
  await page.route(facts, (route) => {
    reads.push(route.request().url())
    return route.abort('connectionfailed')
  })
  await page.goto(`/?run=${runOf(claudeOriginal)}`)
  const bash = stepsOf(page, 'Основной агент')
    .getByRole('listitem')
    .filter({ has: page.getByText('Bash', { exact: true }) })
  await expect(bash).toBeVisible()
  await expect.poll(() => reads.length).toBeGreaterThan(0)

  await page.waitForTimeout(factRetryMs - 2_000)
  const inputs = new Set(reads).size
  expect(reads).toHaveLength(inputs)
  await expect(bash).not.toContainText('echo hi')
  await expect.poll(() => reads.length, { timeout: factRetryMs + 2_000 }).toBeGreaterThan(inputs)
  expect(reads.length).toBeLessThanOrEqual(2 * inputs)

  await page.unroute(facts)
  await expect(bash).toContainText('echo hi', { timeout: factRetryMs + 3_000 })
  await expect(bash).toContainText('Print hi')
})

test.describe('with a fast spool scan for decisions and long questions', () => {
  test.use({ config: { ...watchAll, collector: { spoolScanIntervalMs: 250 } } })

  test('a human decision inferred from later events is marked as aang interpretation, an observed answer is not', async ({
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
    await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h2_probe', tool_input: probe })
    await hook.claude('PermissionRequest.Bash.json', fields)

    const approval = step(page, 'Основной агент', 'Bash: touch probe-perm.txt')
    await expect(approval).toContainText('ждёт решения')
    await expect(approval).not.toContainText('интерпретация aang')

    await hook.claude('PostToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h2_probe', tool_input: probe })
    await expect(approval).toContainText('одобрено')
    await expect(approval).toContainText('интерпретация aang')

    const asked = askUser('Какой вариант выбрать?')
    const ask = { ...fields, tool_name: 'AskUserQuestion', tool_use_id: 'toolu_h2_ask', tool_input: asked }
    await hook.claude('PreToolUse.Bash.json', ask)
    const question = step(page, 'Основной агент', 'Какой вариант выбрать?')
    await expect(question).toContainText('ждёт решения')

    await hook.claude('PostToolUse.Bash.json', {
      ...ask,
      tool_response: { questions: asked.questions, answers: { 'Какой вариант выбрать?': 'Первый' } },
    })
    await expect(question).toContainText('отвечен')
    await expect(question).not.toContainText('интерпретация aang')
    await expect(approval).toContainText('интерпретация aang')
  })

  test('a long question opens in full in the attention zone and in the trace', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(fact(page, 'Агенты')).toHaveText('2')
    const fields = hookFields(profile, claudeOriginal)
    const last = 'Какой из вариантов выбрать в итоге?'
    const text = [
      ...Array.from({ length: 10 }, (_, index) => `Пояснение ${String(index + 1)}: подробности о шаге и его ограничениях.`),
      last,
    ].join('\n')
    const asked = askUser(text)
    const ask = { ...fields, tool_name: 'AskUserQuestion', tool_use_id: 'toolu_h2_long', tool_input: asked }
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PermissionRequest.Bash.json', fields)
    await hook.claude('PreToolUse.Bash.json', ask)

    const item = zoneItem(page, 'Пояснение 1:')
    await expect(item).toContainText(last)
    await expect.poll(() => textShown(item, last)).toBe(false)
    await expect(
      zoneItem(page, 'Bash: touch probe-perm.txt').getByRole('button', { name: 'Показать полностью' }),
    ).toHaveCount(0)
    await item.getByRole('button', { name: 'Показать полностью' }).click()
    await expect(item.getByRole('button', { name: 'Свернуть' })).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => textShown(item, last)).toBe(true)
    await item.getByRole('button', { name: 'Свернуть' }).click()
    await expect.poll(() => textShown(item, last)).toBe(false)

    await hook.claude('PostToolUse.Bash.json', {
      ...ask,
      tool_response: { questions: asked.questions, answers: { [text]: 'Второй' } },
    })
    await expect(item).toHaveCount(0)
    const question = step(page, 'Основной агент', 'Пояснение 1:')
    await expect(question).toContainText('отвечен')
    await expect.poll(() => textShown(question, last)).toBe(false)
    await expect.poll(() => textShown(question, 'Пояснение 1:')).toBe(true)
    await question.getByRole('button', { name: 'Показать полностью' }).click()
    await expect.poll(() => textShown(question, last)).toBe(true)
  })
})

test.describe('with a fast spool scan for a recorded plan', () => {
  test.use({ config: { ...watchAll, collector: { spoolScanIntervalMs: 250 } } })

  test('the plan of a recorded Claude run shows one task list with the last states and one plan for approval, every record stays in a collapsed history', async ({
    page,
    player,
    otelEndpoint,
  }) => {
    const manifest = await loadManifest(recording('claude', '2.1.289', 'claude_cli', 'plan'))
    await (await player(manifest, { timeScale: 0, recordTime: 'playback', otlp: await otelEndpoint() })).play()
    await page.goto('/')
    await page.getByRole('row').nth(1).getByRole('link').click()

    const current = plan(page).getByRole('list', { name: 'Текущий план', exact: true })
    const blocks = current.getByRole('listitem').filter({ has: page.getByText(/^Задачи решателя$|^План на одобрение$/) })
    await expect(blocks).toHaveCount(2)
    const tasks = blocks.nth(0)
    await expect(tasks).toContainText('Задачи решателя')
    await expect(tasks).toContainText('Сессия')
    const items = tasks.getByRole('listitem')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('Write checklist')
    await expect(items.nth(0)).toContainText('Create checklist.txt with both steps')
    await expect(items.nth(0)).toContainText('выполнен')
    await expect(items.nth(1)).toContainText('Review checklist')
    await expect(items.nth(1)).toContainText('выполнен')
    await expect(blocks.nth(1)).toContainText('План на одобрение')
    await expect(blocks.nth(1)).toContainText('# Checklist plan')
    await expect(plan(page).getByText('Задачи из hooks')).toHaveCount(0)

    const toggle = plan(page).getByRole('button', { name: /^История записей: \d+$/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const history = plan(page).getByRole('list', { name: 'История записей плана', exact: true })
    await expect(history).toHaveCount(0)
    const records = Number((await toggle.textContent())?.replace(/\D/g, ''))
    expect(records).toBeGreaterThan(4)
    await toggle.click()
    await expect(history).toContainText('Задачи из hooks')
    await expect(history.getByRole('listitem').filter({ has: page.getByText(/^План на одобрение$/) })).not.toHaveCount(0)
    await plan(page).getByRole('button', { name: 'Скрыть историю записей' }).click()
    await expect(history).toHaveCount(0)
  })
})
