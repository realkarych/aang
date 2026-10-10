import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadManifest, sampleScenarioManifest } from '@aang/testkit'
import { expect, type HookFields, test } from './fixtures.js'
import { recording } from './recordings.js'
import { claudeFork, claudeOriginal, codexThread, hookFields, runOf, sessionFile } from './samples.js'
import {
  agentsOf,
  currentPlan,
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

const pinger = 'aad616394e806288d'

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

  test('tasks with one name stay apart by id in the current plan, and an update without a status keeps the last known one', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(plan(page)).toContainText('Решатель не объявлял план.')
    const fields = hookFields(profile, claudeOriginal)
    const taskHook = (event: string, id: string): Promise<void> =>
      hook.claude('UserPromptSubmit.json', { ...fields, hook_event_name: event, task_id: id, task_subject: 'Review' })
    const taskUpdate = (call: string, input: Readonly<Record<string, string>>): Promise<void> =>
      hook.claude('PreToolUse.Bash.json', { ...fields, tool_name: 'TaskUpdate', tool_use_id: call, tool_input: input })
    const tasks = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^Задачи/) })
    const items = tasks.getByRole('listitem')

    await taskHook('TaskCreated', '1')
    await taskHook('TaskCreated', '2')
    await expect(items).toHaveCount(2)
    await taskHook('TaskCompleted', '1')
    await expect(tasks).toHaveCount(1)
    await expect(tasks).toContainText('Задачи из hooks')
    await expect(tasks).toContainText('сведено записей: 3')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('Review')
    await expect(items.nth(0)).toContainText('выполнен')
    await expect(items.nth(1)).toContainText('Review')
    await expect(items.nth(1)).toContainText('ожидает')

    await taskUpdate('toolu_plan_start_2', { taskId: '2', status: 'in_progress' })
    await expect(items.nth(1)).toContainText('в работе')
    await expect(tasks).toContainText('Задачи решателя')
    await taskUpdate('toolu_plan_rename_2', { taskId: '2', subject: 'Review again' })
    await expect(items.nth(1)).toContainText('Review again')
    await expect(items.nth(1)).toContainText('в работе')
    await taskUpdate('toolu_plan_note_1', { taskId: '1', description: 'Checked twice' })
    await expect(items.nth(0)).toContainText('Checked twice')
    await expect(items.nth(0)).toContainText('выполнен')
    await expect(items).toHaveCount(2)
    await expect(tasks).toContainText('сведено записей: 6')
    await expect(currentPlan(page)).not.toContainText('статус неизвестен')
  })

  test('a TaskCreate joins a task with an id only when its name, or its description among equal names, picks exactly one, also when the name comes later', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(plan(page)).toContainText('Решатель не объявлял план.')
    const fields = hookFields(profile, claudeOriginal)
    const call = (tool: string, id: string, input: Readonly<Record<string, string>>): Promise<void> =>
      hook.claude('PreToolUse.Bash.json', { ...fields, tool_name: tool, tool_use_id: id, tool_input: input })
    const taskHook = (event: string, id: string, subject: string, description?: string): Promise<void> =>
      hook.claude('UserPromptSubmit.json', {
        ...fields,
        hook_event_name: event,
        task_id: id,
        task_subject: subject,
        ...(description === undefined ? {} : { task_description: description }),
      })
    const items = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^Задачи/) }).getByRole('listitem')
    const done = items.filter({ hasText: 'выполнен' })

    await call('TaskCreate', 'toolu_plan_parser', { subject: 'Write parser', description: 'Parse hooks' })
    await call('TaskUpdate', 'toolu_plan_parser_start', { taskId: '1', status: 'in_progress' })
    await expect(items).toHaveCount(2)
    await expect(items.nth(1)).toContainText('задача 1')
    await expect(items.nth(1)).toContainText('в работе')
    await taskHook('TaskCompleted', '1', 'Write parser')
    await expect(items).toHaveCount(1)
    await expect(items.nth(0)).toContainText('Write parser')
    await expect(items.nth(0)).toContainText('Parse hooks')
    await expect(items.nth(0)).toContainText('выполнен')

    const code = items.filter({ hasText: 'Review the code' })
    const docs = items.filter({ hasText: 'Review the docs' })
    await call('TaskCreate', 'toolu_plan_review_code', { subject: 'Review', description: 'Review the code' })
    await call('TaskCreate', 'toolu_plan_review_docs', { subject: 'Review', description: 'Review the docs' })
    await taskHook('TaskCompleted', '3', 'Review')
    await expect(items).toHaveCount(4)
    await expect(code).toContainText('ожидает')
    await expect(docs).toContainText('ожидает')
    await expect(done).toHaveCount(2)
    await taskHook('TaskCreated', '2', 'Review', 'Review the code')
    await expect(items).toHaveCount(3)
    await expect(code).toContainText('ожидает')
    await expect(docs).toContainText('выполнен')

    await taskHook('TaskCompleted', '4', 'Check')
    await taskHook('TaskCompleted', '5', 'Check')
    await call('TaskCreate', 'toolu_plan_check', { subject: 'Check', description: 'Check the build' })
    await expect(items).toHaveCount(6)
    await expect(items.filter({ hasText: 'Check the build' })).toContainText('ожидает')
    await expect(done).toHaveCount(4)
  })

  test('the current plan shows the last todo list, even an empty one, and the history folds only equal records of one owner with one format check', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(plan(page)).toContainText('Решатель не объявлял план.')
    const fields = hookFields(profile, claudeOriginal)
    const call = (tool: string, id: string, input: Readonly<Record<string, unknown>>, agent?: string): Promise<void> =>
      hook.claude('PreToolUse.Bash.json', {
        ...fields,
        ...(agent === undefined ? {} : { agent_id: agent }),
        tool_name: tool,
        tool_use_id: id,
        tool_input: input,
      })
    const todos = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^Задачи решателя$/) })
    const items = todos.getByRole('listitem')

    await call('TodoWrite', 'toolu_plan_todo_1', {
      todos: [
        { content: 'Write the test', status: 'completed' },
        { content: 'Open the PR', status: 'pending' },
      ],
    })
    await expect(items).toHaveCount(2)
    await call('TodoWrite', 'toolu_plan_todo_2', { todos: [{ content: 'Open the PR', status: 'in_progress' }] })
    await expect(items).toHaveCount(1)
    await expect(items.nth(0)).toContainText('Open the PR')
    await expect(items.nth(0)).toContainText('в работе')
    await expect(todos).not.toContainText('Write the test')
    await call('TodoWrite', 'toolu_plan_todo_3', { todos: [] })
    await expect(todos).toContainText('Список дел пуст')
    await expect(items).toHaveCount(0)
    await expect(todos).toContainText('сведено записей: 3')
    await expect(todos).toContainText('формат записи не проверен')

    await call('TodoWrite', 'toolu_plan_todo_4', { todos: [{ content: 'Check the plan', status: 'pending' }] })
    await call('TaskCreate', 'toolu_plan_create', { subject: 'Check the plan' })
    await call('ExitPlanMode', 'toolu_plan_main', { plan: 'One plan for both' })
    await call('ExitPlanMode', 'toolu_plan_pinger', { plan: 'One plan for both' }, pinger)
    const approvals = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^План на одобрение$/) })
    await expect(approvals).toHaveCount(2)
    await expect(approvals.filter({ hasText: 'Сессия 86f93ed5, основной агент' })).toHaveCount(1)
    await expect(approvals.filter({ hasText: 'Сессия 86f93ed5, pinger' })).toHaveCount(1)

    await plan(page).getByRole('button', { name: 'История записей: 7' }).click()
    const history = plan(page).getByRole('list', { name: 'История записей плана', exact: true })
    const records = history.getByRole('listitem').filter({ has: page.getByText(/^План на одобрение$|^Задачи решателя$/) })
    await expect(records).toHaveCount(7)
    await expect(history.getByRole('button', { name: /одинаков/ })).toHaveCount(0)
    await expect(records.nth(0)).toContainText('Сессия 86f93ed5, pinger')
    await expect(records.nth(1)).toContainText('Сессия 86f93ed5, основной агент')
    await expect(records.nth(2)).toContainText('Check the plan')
    await expect(records.nth(2)).not.toContainText('формат записи не проверен')
    await expect(records.nth(3)).toContainText('Check the plan')
    await expect(records.nth(3)).toContainText('формат записи не проверен')
    await expect(records.nth(6)).toContainText('Write the test')
  })

  test('equal neighbouring records of one owner fold in the history and open to every record', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(plan(page)).toContainText('Решатель не объявлял план.')
    const fields = hookFields(profile, claudeOriginal)
    for (const index of [1, 2, 3]) {
      await hook.claude('PreToolUse.Bash.json', {
        ...fields,
        tool_name: 'ExitPlanMode',
        tool_use_id: `toolu_plan_same_${String(index)}`,
        tool_input: { plan: 'The same plan' },
      })
    }
    await expect(currentPlan(page)).toContainText('сведено записей: 3')

    await plan(page).getByRole('button', { name: 'История записей: 3' }).click()
    const history = plan(page).getByRole('list', { name: 'История записей плана', exact: true })
    const records = history.getByRole('listitem')
    await expect(records).toHaveCount(1)
    const folded = history.getByRole('button', { name: '3 одинаковые записи подряд' })
    await expect(folded).toHaveAttribute('aria-expanded', 'false')
    await folded.click()
    await expect(folded).toHaveAttribute('aria-expanded', 'true')
    await expect(records).toHaveCount(3)
    for (const index of [0, 1, 2]) {
      await expect(records.nth(index)).toContainText('The same plan')
      await expect(records.nth(index)).toContainText('Сессия 86f93ed5, основной агент')
    }
    await folded.click()
    await expect(records).toHaveCount(1)
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

    const blocks = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^Задачи решателя$|^План на одобрение$/) })
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
