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

const calmZone = 'No open items.'

const factRetryMs = 5_000

const probe = { command: 'touch probe-perm.txt', description: 'Create empty probe file' }

interface AskedQuestion {
  readonly question: string
  readonly header: string
  readonly options: readonly { readonly label: string }[]
  readonly multiSelect: boolean
}

const askUser = (question: string): { readonly questions: readonly AskedQuestion[] } => ({
  questions: [{ question, header: 'Choice', options: [{ label: 'First' }, { label: 'Second' }], multiSelect: false }],
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
    await expect(fact(page, 'Agents')).toHaveText('2')
    await expect(lamp(page, 'Link')).toHaveText('Link stream connected')
    await expect(zone(page)).toContainText(calmZone)

    const sent = Date.now()
    await hook.claude('PermissionRequest.Bash.json', hookFields(profile, claudeOriginal))
    const item = zoneItem(page, 'Bash: touch probe-perm.txt')
    await item.waitFor({ timeout: attentionWithinMs })
    expect(Date.now() - sent).toBeLessThanOrEqual(attentionWithinMs)

    await expect(item).toContainText('Approval request')
    await expect(item).toContainText('awaiting an answer')
    await expect(item).toContainText('Session 86f93ed5, main agent')
    await expect(item).toContainText('by aang rule')
    await expect(fact(page, 'Attention')).toHaveText('awaiting an answer: 1')
    await expect(sessionOf(page, claudeOriginal.session)).toContainText('waiting for a human')
    await expect(step(page, 'Main agent', 'Approval request')).toContainText('awaiting decision')
    await expect(step(page, 'Main agent', 'Approval request')).toContainText('Bash: touch probe-perm.txt')
    await expect(lamp(page, 'Model')).toHaveText('Model not built')
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
    await expect(session).toContainText('mode files only')
    await expect(session).toContainText(/startup Oct \d+, /)
    await expect(step(page, 'Main agent', 'CommandExecution')).toContainText('echo hi')
    await expect(lamp(page, 'Link')).toHaveText('Link stream connected')
    await expect(zone(page)).toContainText(calmZone)

    const sent = Date.now()
    await hook.codex('PermissionRequest.json', hookFields(profile, codexThread))
    const item = zoneItem(page, 'touch /tmp/aang-spike-escalate-probe')
    await item.waitFor({ timeout: attentionWithinMs })
    expect(Date.now() - sent).toBeLessThanOrEqual(attentionWithinMs)

    await expect(item).toContainText('Approval request')
    await expect(item).toContainText('awaiting an answer')
    await expect(fact(page, 'Attention')).toHaveText('awaiting an answer: 1')
    await expect(session).toContainText('waiting for a human')
    await expect(session).toContainText('mode full')
    await expect(lamp(page, 'Model')).toHaveText('Model not built')
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
    await expect(original).toContainText('hooks inactive')
    await expect(fork).toContainText('hooks inactive')

    await hook.claude('PermissionRequest.Bash.json', hookFields(profile, claudeOriginal))
    await hook.claude('UserPromptSubmit.json', hookFields(profile, claudeFork))
    await expect(original).toContainText('waiting for a human')
    await expect(original).toContainText('awaiting an answer: 1')
    await expect(fork).toContainText('running')
    await expect(fork).toContainText('no new events')
    await expect(fork).not.toContainText('waiting for a human')
    await expect(fork).not.toContainText('awaiting an answer')
    await expect(original).toContainText('waiting for a human')

    await fork.getByRole('link').click()
    const forked = sessionOf(page, claudeFork.session)
    await expect(forked).toContainText('running')
    await expect(forked).toContainText('no new events')
    await expect(fact(page, 'Freshness')).toHaveText('no new events')
    await expect(zone(page)).toContainText(calmZone)
    await expect(step(page, 'Main agent', 'Bash')).toContainText('inherited from the source session')

    await rm(sessionFile(profile, claudeFork))
    await expect(forked).toContainText('source lost')
    await expect(forked).toContainText('running')
    await expect(forked).not.toContainText('no new events')
    await expect(fact(page, 'Freshness')).toHaveText('source lost')
    await expect(zone(page)).toContainText(calmZone)

    await page.getByRole('navigation').getByRole('link', { name: 'Runs' }).click()
    await expect(fork).toContainText('source lost')
    await original.getByRole('link').click()
    await expect(sessionOf(page, claudeOriginal.session)).toContainText('waiting for a human')
    await expect(sessionOf(page, claudeOriginal.session)).not.toContainText('source lost')
    await expect(zoneItem(page, 'Approval request')).toContainText('awaiting an answer')
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
    await expect(fact(page, 'Agents')).toHaveText('2')

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
    await expect(echoer).toContainText('subagent')
    await expect(echoer).toContainText('done')
    await expect(fact(page, 'Agents')).toHaveText('3')
    await expect(agents.getByRole('listitem', { name: /./ })).toHaveCount(3)
    const spawned = trace(page).getByRole('list', { name: 'Agents launched by: Main agent' })
    await expect(spawned.getByRole('listitem', { name: 'pinger', exact: true })).toContainText('subagent')
    await expect(sessionOf(page, claudeOriginal.session)).toContainText('mode full')
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
    await expect(session).toContainText('branch HEAD')
    await expect(session).toContainText('waiting for input')
    await expect(session).toContainText('hooks inactive')
    await expect(session).toContainText('mode files only')
    const spawned = trace(page).getByRole('list', { name: 'Agents launched by: Main agent' })
    await expect(spawned).toContainText('pinger')
    await expect(spawned).toContainText('subagent')
    await expect(spawned).toContainText('Ping the pinger agent')
    await expect(step(page, 'Main agent', 'echo hi')).toContainText('Print hi')
    await expect(step(page, 'Main agent', 'echo hi')).toContainText('succeeded')
    await expect(step(page, 'Main agent', 'Agent')).toContainText('ping')
    await expect(plan(page)).toContainText('The solver has not declared a plan.')
    await expect(zone(page)).toContainText(calmZone)

    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', {
      ...fields,
      tool_name: 'TodoWrite',
      tool_use_id: 'toolu_h2_todo',
      tool_input: {
        todos: [
          { content: 'Read the plan', status: 'completed' },
          { content: 'Write a test', status: 'in_progress' },
          { content: 'Open a PR', status: 'pending' },
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
      tool_input: { plan: 'Tests first.\nThen the PR.' },
    })
    await hook.claude('PermissionRequest.Bash.json', fields)

    const updates = plan(page).getByRole('listitem').filter({ has: page.getByText(/^Plan for approval$|^Solver tasks$/) })
    await expect(updates).toHaveCount(2)
    await expect(updates.nth(0)).toContainText('Plan for approval')
    await expect(updates.nth(0)).toContainText('Tests first.')
    await expect(updates.nth(0)).not.toContainText('record format not verified')
    await expect(updates.nth(1)).toContainText('Solver tasks')
    await expect(updates.nth(1)).toContainText('Session 86f93ed5, main agent')
    await expect(updates.nth(1)).toContainText('record format not verified')
    const items = updates.nth(1).getByRole('listitem')
    await expect(items).toHaveCount(3)
    await expect(items.filter({ hasText: 'Read the plan' })).toContainText('completed')
    await expect(items.filter({ hasText: 'Write a test' })).toContainText('in progress')
    await expect(items.filter({ hasText: 'Open a PR' })).toContainText('waiting')

    const zoneItems = openItems(page)
    await expect(zoneItems).toHaveCount(2)
    await expect(zoneItems.nth(0)).toContainText('Question')
    await expect(zoneItems.nth(0)).toContainText('Tests first.')
    await expect(zoneItems.nth(0)).toContainText('awaiting an answer')
    await expect(zoneItems.nth(1)).toContainText('Approval request')
    await expect(zoneItems.nth(1)).toContainText('Bash: touch probe-perm.txt')
    await expect(fact(page, 'Attention')).toHaveText('awaiting an answer: 2')
    await expect(session).toContainText('waiting for a human')
    await expect(session).toContainText('mode full')

    const steps = stepsOf(page, 'Main agent').getByRole('listitem')
    await expect(step(page, 'Main agent', 'pnpm test --shard=5/5')).toContainText('running')
    await expect(step(page, 'Main agent', 'Plan for approval')).toContainText('awaiting decision')
    await expect(step(page, 'Main agent', 'echo hi')).toHaveCount(0)
    await stepsOf(page, 'Main agent').getByRole('button', { name: 'Show 2 early steps' }).click()
    await expect(step(page, 'Main agent', 'echo hi')).toBeVisible()
    await expect(steps).toHaveCount(12)
    await stepsOf(page, 'Main agent').getByRole('button', { name: 'Hide early steps' }).click()
    await expect(step(page, 'Main agent', 'echo hi')).toHaveCount(0)
  })

  test('tasks with one name stay apart by id in the current plan, and an update without a status keeps the last known one', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(plan(page)).toContainText('The solver has not declared a plan.')
    const fields = hookFields(profile, claudeOriginal)
    const taskHook = (event: string, id: string): Promise<void> =>
      hook.claude('UserPromptSubmit.json', { ...fields, hook_event_name: event, task_id: id, task_subject: 'Review' })
    const taskUpdate = (call: string, input: Readonly<Record<string, string>>): Promise<void> =>
      hook.claude('PreToolUse.Bash.json', { ...fields, tool_name: 'TaskUpdate', tool_use_id: call, tool_input: input })
    const tasks = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^(?:Solver tasks|Tasks from hooks)/) })
    const items = tasks.getByRole('listitem')

    await taskHook('TaskCreated', '1')
    await taskHook('TaskCreated', '2')
    await expect(items).toHaveCount(2)
    await taskHook('TaskCompleted', '1')
    await expect(tasks).toHaveCount(1)
    await expect(tasks).toContainText('Tasks from hooks')
    await expect(tasks).toContainText('records merged: 3')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('Review')
    await expect(items.nth(0)).toContainText('completed')
    await expect(items.nth(1)).toContainText('Review')
    await expect(items.nth(1)).toContainText('waiting')

    await taskUpdate('toolu_plan_start_2', { taskId: '2', status: 'in_progress' })
    await expect(items.nth(1)).toContainText('in progress')
    await expect(tasks).toContainText('Solver tasks')
    await taskUpdate('toolu_plan_rename_2', { taskId: '2', subject: 'Review again' })
    await expect(items.nth(1)).toContainText('Review again')
    await expect(items.nth(1)).toContainText('in progress')
    await taskUpdate('toolu_plan_note_1', { taskId: '1', description: 'Checked twice' })
    await expect(items.nth(0)).toContainText('Checked twice')
    await expect(items.nth(0)).toContainText('completed')
    await expect(items).toHaveCount(2)
    await expect(tasks).toContainText('records merged: 6')
    await expect(currentPlan(page)).not.toContainText('status unknown')
  })

  test('a TaskCreate joins a task with an id only when its name, or its description among equal names, picks exactly one, also when the name comes later', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(plan(page)).toContainText('The solver has not declared a plan.')
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
    const items = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^(?:Solver tasks|Tasks from hooks)/) }).getByRole('listitem')
    const done = items.filter({ hasText: 'completed' })

    await call('TaskCreate', 'toolu_plan_parser', { subject: 'Write parser', description: 'Parse hooks' })
    await call('TaskUpdate', 'toolu_plan_parser_start', { taskId: '1', status: 'in_progress' })
    await expect(items).toHaveCount(2)
    await expect(items.nth(1)).toContainText('task 1')
    await expect(items.nth(1)).toContainText('in progress')
    await taskHook('TaskCompleted', '1', 'Write parser')
    await expect(items).toHaveCount(1)
    await expect(items.nth(0)).toContainText('Write parser')
    await expect(items.nth(0)).toContainText('Parse hooks')
    await expect(items.nth(0)).toContainText('completed')

    const code = items.filter({ hasText: 'Review the code' })
    const docs = items.filter({ hasText: 'Review the docs' })
    await call('TaskCreate', 'toolu_plan_review_code', { subject: 'Review', description: 'Review the code' })
    await call('TaskCreate', 'toolu_plan_review_docs', { subject: 'Review', description: 'Review the docs' })
    await taskHook('TaskCompleted', '3', 'Review')
    await expect(items).toHaveCount(4)
    await expect(code).toContainText('waiting')
    await expect(docs).toContainText('waiting')
    await expect(done).toHaveCount(2)
    await taskHook('TaskCreated', '2', 'Review', 'Review the code')
    await expect(items).toHaveCount(3)
    await expect(code).toContainText('waiting')
    await expect(docs).toContainText('completed')

    await taskHook('TaskCompleted', '4', 'Check')
    await taskHook('TaskCompleted', '5', 'Check')
    await call('TaskCreate', 'toolu_plan_check', { subject: 'Check', description: 'Check the build' })
    await expect(items).toHaveCount(6)
    await expect(items.filter({ hasText: 'Check the build' })).toContainText('waiting')
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
    await expect(plan(page)).toContainText('The solver has not declared a plan.')
    const fields = hookFields(profile, claudeOriginal)
    const call = (tool: string, id: string, input: Readonly<Record<string, unknown>>, agent?: string): Promise<void> =>
      hook.claude('PreToolUse.Bash.json', {
        ...fields,
        ...(agent === undefined ? {} : { agent_id: agent }),
        tool_name: tool,
        tool_use_id: id,
        tool_input: input,
      })
    const todos = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^Solver tasks$/) })
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
    await expect(items.nth(0)).toContainText('in progress')
    await expect(todos).not.toContainText('Write the test')
    await call('TodoWrite', 'toolu_plan_todo_3', { todos: [] })
    await expect(todos).toContainText('The to-do list is empty')
    await expect(items).toHaveCount(0)
    await expect(todos).toContainText('records merged: 3')
    await expect(todos).toContainText('record format not verified')

    await call('TodoWrite', 'toolu_plan_todo_4', { todos: [{ content: 'Check the plan', status: 'pending' }] })
    await call('TaskCreate', 'toolu_plan_create', { subject: 'Check the plan' })
    await call('ExitPlanMode', 'toolu_plan_main', { plan: 'One plan for both' })
    await call('ExitPlanMode', 'toolu_plan_pinger', { plan: 'One plan for both' }, pinger)
    const approvals = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^Plan for approval$/) })
    await expect(approvals).toHaveCount(2)
    await expect(approvals.filter({ hasText: 'Session 86f93ed5, main agent' })).toHaveCount(1)
    await expect(approvals.filter({ hasText: 'Session 86f93ed5, pinger' })).toHaveCount(1)

    await plan(page).getByRole('button', { name: 'Record history: 7' }).click()
    const history = plan(page).getByRole('list', { name: 'Plan record history', exact: true })
    const records = history.getByRole('listitem').filter({ has: page.getByText(/^Plan for approval$|^Solver tasks$/) })
    await expect(records).toHaveCount(7)
    await expect(history.getByRole('button', { name: /identical/ })).toHaveCount(0)
    await expect(records.nth(0)).toContainText('Session 86f93ed5, pinger')
    await expect(records.nth(1)).toContainText('Session 86f93ed5, main agent')
    await expect(records.nth(2)).toContainText('Check the plan')
    await expect(records.nth(2)).not.toContainText('record format not verified')
    await expect(records.nth(3)).toContainText('Check the plan')
    await expect(records.nth(3)).toContainText('record format not verified')
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
    await expect(plan(page)).toContainText('The solver has not declared a plan.')
    const fields = hookFields(profile, claudeOriginal)
    for (const index of [1, 2, 3]) {
      await hook.claude('PreToolUse.Bash.json', {
        ...fields,
        tool_name: 'ExitPlanMode',
        tool_use_id: `toolu_plan_same_${String(index)}`,
        tool_input: { plan: 'The same plan' },
      })
    }
    await expect(currentPlan(page)).toContainText('records merged: 3')

    await plan(page).getByRole('button', { name: 'Record history: 3' }).click()
    const history = plan(page).getByRole('list', { name: 'Plan record history', exact: true })
    const records = history.getByRole('listitem')
    await expect(records).toHaveCount(1)
    const folded = history.getByRole('button', { name: '3 identical records in a row' })
    await expect(folded).toHaveAttribute('aria-expanded', 'false')
    await folded.click()
    await expect(folded).toHaveAttribute('aria-expanded', 'true')
    await expect(records).toHaveCount(3)
    for (const index of [0, 1, 2]) {
      await expect(records.nth(index)).toContainText('The same plan')
      await expect(records.nth(index)).toContainText('Session 86f93ed5, main agent')
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
  const bash = stepsOf(page, 'Main agent')
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
    await expect(fact(page, 'Agents')).toHaveText('2')
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h2_probe', tool_input: probe })
    await hook.claude('PermissionRequest.Bash.json', fields)

    const approval = step(page, 'Main agent', 'Bash: touch probe-perm.txt')
    await expect(approval).toContainText('awaiting decision')
    await expect(approval).not.toContainText('aang interpretation')

    await hook.claude('PostToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h2_probe', tool_input: probe })
    await expect(approval).toContainText('approved')
    await expect(approval).toContainText('aang interpretation')

    const asked = askUser('Which option should I pick?')
    const ask = { ...fields, tool_name: 'AskUserQuestion', tool_use_id: 'toolu_h2_ask', tool_input: asked }
    await hook.claude('PreToolUse.Bash.json', ask)
    const question = step(page, 'Main agent', 'Which option should I pick?')
    await expect(question).toContainText('awaiting decision')

    await hook.claude('PostToolUse.Bash.json', {
      ...ask,
      tool_response: { questions: asked.questions, answers: { 'Which option should I pick?': 'First' } },
    })
    await expect(question).toContainText('answered')
    await expect(question).not.toContainText('aang interpretation')
    await expect(approval).toContainText('aang interpretation')
  })

  test('a long question opens in full in the attention zone and in the trace', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)
    await expect(fact(page, 'Agents')).toHaveText('2')
    const fields = hookFields(profile, claudeOriginal)
    const last = 'Which of the options should I pick in the end?'
    const text = [
      ...Array.from({ length: 10 }, (_, index) => `Note ${String(index + 1)}: details about the step and its limitations.`),
      last,
    ].join('\n')
    const asked = askUser(text)
    const ask = { ...fields, tool_name: 'AskUserQuestion', tool_use_id: 'toolu_h2_long', tool_input: asked }
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PermissionRequest.Bash.json', fields)
    await hook.claude('PreToolUse.Bash.json', ask)

    const item = zoneItem(page, 'Note 1:')
    await expect(item).toContainText(last)
    await expect.poll(() => textShown(item, last)).toBe(false)
    await expect(
      zoneItem(page, 'Bash: touch probe-perm.txt').getByRole('button', { name: 'Show all' }),
    ).toHaveCount(0)
    await item.getByRole('button', { name: 'Show all' }).click()
    await expect(item.getByRole('button', { name: 'Collapse' })).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => textShown(item, last)).toBe(true)
    await item.getByRole('button', { name: 'Collapse' }).click()
    await expect.poll(() => textShown(item, last)).toBe(false)

    await hook.claude('PostToolUse.Bash.json', {
      ...ask,
      tool_response: { questions: asked.questions, answers: { [text]: 'Second' } },
    })
    await expect(item).toHaveCount(0)
    const question = step(page, 'Main agent', 'Note 1:')
    await expect(question).toContainText('answered')
    await expect.poll(() => textShown(question, last)).toBe(false)
    await expect.poll(() => textShown(question, 'Note 1:')).toBe(true)
    await question.getByRole('button', { name: 'Show all' }).click()
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

    const blocks = currentPlan(page).getByRole('listitem').filter({ has: page.getByText(/^Solver tasks$|^Plan for approval$/) })
    await expect(blocks).toHaveCount(2)
    const tasks = blocks.nth(0)
    await expect(tasks).toContainText('Solver tasks')
    await expect(tasks).toContainText('Session')
    const items = tasks.getByRole('listitem')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('Write checklist')
    await expect(items.nth(0)).toContainText('Create checklist.txt with both steps')
    await expect(items.nth(0)).toContainText('completed')
    await expect(items.nth(1)).toContainText('Review checklist')
    await expect(items.nth(1)).toContainText('completed')
    await expect(blocks.nth(1)).toContainText('Plan for approval')
    await expect(blocks.nth(1)).toContainText('# Checklist plan')
    await expect(plan(page).getByText('Tasks from hooks')).toHaveCount(0)

    const toggle = plan(page).getByRole('button', { name: /^Record history: \d+$/ })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const history = plan(page).getByRole('list', { name: 'Plan record history', exact: true })
    await expect(history).toHaveCount(0)
    const records = Number((await toggle.textContent())?.replace(/\D/g, ''))
    expect(records).toBeGreaterThan(4)
    await toggle.click()
    await expect(history).toContainText('Tasks from hooks')
    await expect(history.getByRole('listitem').filter({ has: page.getByText(/^Plan for approval$/) })).not.toHaveCount(0)
    await plan(page).getByRole('button', { name: 'Hide record history' }).click()
    await expect(history).toHaveCount(0)
  })
})
