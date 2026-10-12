import { appendFile, readFile } from 'node:fs/promises'
import { endpoints, RunId, type RunSnapshot, type Runtime, type Stage } from '@aang/contract'
import {
  checksBlockerText,
  checksStageTitle,
  loadManifest,
  mainStageTitle,
  observerScenarios,
  reviewRequestText,
  sampleScenarioManifest,
} from '@aang/testkit'
import type { Page } from '@playwright/test'
import { expect, getWithoutKeepAlive, type HookFields, test } from './fixtures.js'
import { hooksOnly, recording } from './recordings.js'
import { claudeOriginal, codexThread, hookFields, runOf, sessionFile } from './samples.js'
import { dock, history, historyToggle, openItems, zone, zoneItem } from './screens.js'

const fastSpool = { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } }

const probe = { command: 'touch probe-perm.txt', description: 'Create empty probe file' }

const choice = 'Which option should I pick?'

const askUser = (fields: HookFields, call: string, question: string): HookFields => ({
  ...fields,
  tool_name: 'AskUserQuestion',
  tool_use_id: call,
  tool_input: {
    questions: [{ question, header: 'Choice', options: [{ label: 'First' }, { label: 'Second' }], multiSelect: false }],
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

const snapshotOf = async (page: Page, run: RunId): Promise<RunSnapshot> => {
  const response = await getWithoutKeepAlive(page.request, endpoints.run.path.replace(':run', run))
  expect(response.status(), await response.text()).toBe(200)
  return endpoints.run.response.parse(await response.json())
}

const waitingForHuman = async (page: Page, run: RunId): Promise<number> =>
  (await snapshotOf(page, run)).summary.attention.waiting_for_human

const agentCount = async (page: Page, run: RunId): Promise<number> => (await snapshotOf(page, run)).summary.agents

const waitsForHuman = async (page: Page, run: RunId, session: string): Promise<boolean> =>
  (await snapshotOf(page, run)).objects.sessions.some(
    ({ key, execution }) => key.session === session && execution.state === 'waiting' && execution.reason === 'human',
  )

const zoneSize = async (page: Page, run: RunId): Promise<number> => {
  const response = await getWithoutKeepAlive(page.request, endpoints.run.path.replace(':run', run))
  return response.ok() ? endpoints.run.response.parse(await response.json()).view.zone.length : 0
}

const fromPage = async (page: Page, method: 'POST' | 'DELETE', path: string, body: unknown): Promise<unknown> => {
  const { status, text } = await page.evaluate(
    async ([verb, target, payload]) => {
      const response = await fetch(target, {
        method: verb,
        headers: { 'content-type': 'application/json' },
        body: payload === null ? null : JSON.stringify(payload),
      })
      return { status: response.status, text: await response.text() }
    },
    [method, path, body] as const,
  )
  expect(status, text).toBe(200)
  return JSON.parse(text)
}

const hideBash = async (page: Page, run: RunId): Promise<string> => {
  const created = await fromPage(page, 'POST', endpoints.createViewRule.path.replace(':run', run), {
    action: 'hide',
    selector: { kind: 'action_tool', tool: 'Bash' },
    params: null,
  })
  return endpoints.createViewRule.response.parse(created).rule.rule.id
}

test.describe('with a fast spool scan', () => {
  test.use({ config: fastSpool })

  test('one AskUserQuestion of a recorded Claude run is one question in the zone, not a question and an approval request', async ({
    page,
    player,
  }) => {
    const manifest = await loadManifest(recording('claude', '2.1.289', 'claude_cli', 'question'))
    const played = await player(hooksOnly(manifest), { timeScale: 0 })
    await played.play({ until: 'question-answered' })
    await page.goto('/')
    await page.getByRole('row').nth(1).getByRole('link').click()

    const greeting = 'Which greeting should I use?'
    await expect(openItems(page)).toHaveCount(1)
    await expect(openItems(page).nth(0)).toContainText('Question')
    await expect(openItems(page).nth(0)).toContainText(greeting)
    await expect(openItems(page).nth(0)).toContainText('awaiting an answer')
    await expect(zoneItem(page, 'Approval request')).toHaveCount(0)
    const run = RunId.parse(new URL(page.url()).searchParams.get('run'))
    await expect.poll(() => waitingForHuman(page, run)).toBe(1)

    await played.play()
    await expect(openItems(page)).toHaveCount(0)
    await historyToggle(page).click()
    await expect(history(page).filter({ hasText: greeting })).toHaveCount(1)
    await expect(history(page).filter({ hasText: 'AskUserQuestion' })).toHaveCount(0)
  })

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
    await expect.poll(() => agentCount(page, run)).toBe(2)
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', askUser(fields, 'toolu_h3_ask', choice))

    const question = zoneItem(page, choice)
    await expect(question).toContainText('awaiting an answer')
    await expect(question).not.toContainText('session ended')
    await expect(zone(page)).toContainText('nothing is sent to the solver')

    await hook.claude('SessionEnd.json', fields)
    await expect(question).toContainText('session ended')
    await expect(question).not.toContainText('awaiting an answer')
    await expect(question).toContainText('by time opened')
    expect(await waitsForHuman(page, run, claudeOriginal.session)).toBe(false)

    await hook.claude('SessionStart.resume.json', fields)
    await hook.claude('UserPromptSubmit.json', { ...fields, prompt: 'Run the linter and show the output' })
    await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h3_probe', tool_input: probe })
    await hook.claude('PermissionRequest.Bash.json', fields)
    const approval = zoneItem(page, 'Bash: touch probe-perm.txt')
    await expect(approval).toContainText('awaiting an answer')
    await expect(question).not.toContainText('session ended')
    await expect(question).toContainText('by time opened')
    await expect(openItems(page)).toHaveCount(2)
    await expect(openItems(page).nth(0)).toContainText('Bash: touch probe-perm.txt')
    await expect(openItems(page).nth(1)).toContainText(choice)

    await approval.getByRole('button', { name: 'Mark as viewed' }).click()
    await expect(approval).toContainText('viewed')
    await expect(approval).toContainText('awaiting an answer')
    await expect(approval.getByRole('button', { name: 'Mark as viewed' })).toHaveCount(0)
    await expect(openItems(page).nth(0)).toContainText(choice)
    await expect(openItems(page).nth(1)).toContainText('Bash: touch probe-perm.txt')
    await expect.poll(() => waitingForHuman(page, run)).toBe(1)
    await expect(historyToggle(page)).toHaveCount(0)

    await question.getByRole('button', { name: 'Dismiss' }).click()
    await expect(question).toHaveCount(0)
    await expect(zone(page).getByRole('status')).toHaveText(`Item "${choice}" was dismissed from the zone and kept in the history.`)
    await expect(zone(page).getByRole('status')).toBeFocused()
    await expect(openItems(page)).toHaveCount(1)
    await expect.poll(() => waitingForHuman(page, run)).toBe(1)

    await historyToggle(page).click()
    await expect(historyToggle(page)).toHaveText('History: 1 item')
    await expect(historyToggle(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(history(page)).toHaveCount(1)
    await expect(history(page)).toContainText('Question')
    await expect(history(page)).toContainText(choice)
    await expect(history(page)).toContainText('dismissed by the user')
    await historyToggle(page).click()
    await expect(history(page)).toHaveCount(0)

    const returned = await context.newPage()
    await returned.goto(`/?run=${run}`)
    await expect(zoneItem(returned, 'Bash: touch probe-perm.txt')).toContainText('viewed')
    await expect(openItems(returned)).toHaveCount(1)
    await historyToggle(returned).click()
    await expect(history(returned)).toContainText('dismissed by the user')
    await returned.close()
  })

  test('a Codex async question stays in the zone after the session ends and after a new prompt, and its dismissal is kept in the history (E2E 15)', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
    const run = runOf(codexThread)
    await page.goto(`/?run=${run}`)
    await expect
      .poll(async () => (await snapshotOf(page, run)).objects.actions.some(({ tool }) => tool === 'CommandExecution'))
      .toBe(true)
    const fields = hookFields(profile, codexThread)
    await appendFile(sessionFile(profile, codexThread), codexAsyncQuestion(asyncAsk))

    const question = zoneItem(page, asyncAsk)
    await expect(question).toContainText('Question')
    await expect(question).toContainText('by aang rule')
    await hook.codex('SessionEnd.json', fields)
    await expect(question).toContainText('session ended')
    await expect(question).not.toContainText('awaiting an answer')

    await hook.codex('UserPromptSubmit.json', { ...fields, prompt: 'Run the linter' })
    await expect(question).not.toContainText('session ended')
    await expect(question).toBeVisible()

    await question.getByRole('button', { name: 'Dismiss' }).click()
    await expect(question).toHaveCount(0)
    await expect(zone(page)).toContainText('No open items.')
    await historyToggle(page).click()
    await expect(history(page)).toContainText(asyncAsk)
    await expect(history(page)).toContainText('dismissed by the user')
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
    await expect.poll(() => agentCount(page, run)).toBe(2)
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h3_hidden', tool_input: probe })
    await hook.claude('PermissionRequest.Bash.json', fields)
    const approval = zoneItem(page, 'Bash: touch probe-perm.txt')
    await expect(approval).toContainText('awaiting an answer')
    await expect(approval).not.toContainText('from a hidden element')

    const rule = await hideBash(page, run)
    await expect(approval).toContainText('from a hidden element')
    await expect(approval).toContainText('awaiting an answer')

    await fromPage(
      page,
      'DELETE',
      endpoints.revokeViewRule.path.replace(':run', run).replace(':id', encodeURIComponent(rule)),
      null,
    )
    await expect(approval).not.toContainText('from a hidden element')
    await expect(approval).toContainText('awaiting an answer')
  })

  test('while the live stream is down a viewed item goes below the unviewed one and a dismissed one moves to the history', async ({
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
    await expect.poll(() => zoneSize(page, run)).toBe(2)

    await page.route('**/api/stream?**', (route) => route.abort('connectionfailed'))
    await page.goto(`/?run=${run}`)
    const question = zoneItem(page, choice)
    const approval = zoneItem(page, 'Bash: touch probe-perm.txt')
    await expect(openItems(page)).toHaveCount(2)
    await expect(openItems(page).nth(0)).toContainText(choice)
    await expect(openItems(page).nth(1)).toContainText('Bash: touch probe-perm.txt')

    await question.getByRole('button', { name: 'Mark as viewed' }).click()
    await expect(question).toContainText('viewed')
    await expect(openItems(page).nth(0)).toContainText('Bash: touch probe-perm.txt')
    await expect(openItems(page).nth(1)).toContainText(choice)
    await expect(approval.getByRole('button', { name: 'Mark as viewed' })).toBeVisible()
    await question.getByRole('button', { name: 'Dismiss' }).click()
    await expect(question).toHaveCount(0)
    await expect(zone(page).getByRole('status')).toHaveText(`Item "${choice}" was dismissed from the zone and kept in the history.`)
    await historyToggle(page).click()
    await expect(history(page)).toContainText('dismissed by the user')
  })
})

test.describe('with a fast spool scan and the LLM unavailable', () => {
  test.use({ config: fastSpool, claudeScenario: { loggedIn: false }, codexScenario: { loggedIn: false } })

  test('a failed mark or dismissal keeps the item and says why, a rotated token shows the sign-in screen', async ({
    page,
    player,
    profile,
    hook,
    aang,
    daemon,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    const run = runOf(claudeOriginal)
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', askUser(fields, 'toolu_h3_failing', choice))
    await expect.poll(() => zoneSize(page, run)).toBe(1)

    await page.route('**/api/stream?**', (route) => route.abort('connectionfailed'))
    await page.route('**/api/status', (route) => route.abort('connectionfailed'))
    await page.route('**/api/runs', (route) => route.abort('connectionfailed'))
    await page.goto(`/?run=${run}`)
    const question = zoneItem(page, choice)
    await expect(question).toContainText('awaiting an answer')

    await page.route('**/attention/*/viewed', (route) => route.abort('connectionfailed'))
    await question.getByRole('button', { name: 'Mark as viewed' }).click()
    await expect(question.getByRole('alert')).toHaveText('Could not mark the item: no connection to the daemon')
    await expect(question.getByRole('button', { name: 'Mark as viewed' })).toBeEnabled()

    await aang('prune', '--run', run)
    await question.getByRole('button', { name: 'Dismiss' }).click()
    await expect(question.getByRole('alert')).toHaveText('Could not dismiss the item: the item or its run was deleted')
    await expect(question).toContainText('awaiting an answer')
    await expect(historyToggle(page)).toHaveCount(0)

    await aang('token', 'rotate')
    await question.getByRole('button', { name: 'Dismiss' }).click()
    await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible()

    await aang('stop')
    expect(await daemon.exited, daemon.output()).toEqual({ code: 0, signal: null })
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
    const run = runOf(claudeOriginal)
    await page.goto(`/?run=${run}`)
    await expect.poll(() => agentCount(page, run)).toBe(2)
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', testRun(fields, 'toolu_h3_test_1'))
    await hook.claude('PostToolUseFailure.Bash.json', {
      ...testRun(fields, 'toolu_h3_test_1'),
      error: 'Exit code 1\n1 test failed',
    })

    const failed = zoneItem(page, 'Failed check')
    await expect(failed).toContainText('Check "test" failed')
    await expect(failed).toContainText('by aang rule')
    await expect(failed).toContainText('by time opened')
    await expect(failed).not.toContainText('awaiting an answer')
    await expect
      .poll(async () => {
        const { open, waiting_for_human: waiting } = (await snapshotOf(page, run)).summary.attention
        return { open, waiting }
      })
      .toEqual({ open: 1, waiting: 0 })

    await hook.claude('PreToolUse.Bash.json', testRun(fields, 'toolu_h3_test_2'))
    await hook.claude('PostToolUse.Bash.json', testRun(fields, 'toolu_h3_test_2'))
    await expect(failed).toHaveCount(0)
    await expect(zone(page)).toContainText('No open items.')
    await historyToggle(page).click()
    await expect(history(page)).toHaveCount(1)
    await expect(history(page)).toContainText('Failed check')
    await expect(history(page)).toContainText('check passed')
  })
})

const observed = { timeout: 30_000 }

const endTurnSample = new URL('../docs/research/samples/claude-code-transcripts/rec-assistant-text-end-turn.json', import.meta.url)

const claudeFinalText = async (text: string): Promise<string> => {
  const line = JSON.parse(await readFile(endTurnSample, 'utf8')) as Record<string, unknown> & {
    readonly uuid: string
    readonly message: Record<string, unknown>
  }
  return `${JSON.stringify({
    ...line,
    parentUuid: line.uuid,
    uuid: 'b3a1f0c2-4d5e-4f60-8a71-92b3c4d5e6f7',
    requestId: 'req_h3_final',
    timestamp: new Date().toISOString(),
    message: { ...line.message, id: 'msg_h3_final', content: [{ type: 'text', text }] },
  })}\n`
}

const observerAdmitted = async (page: Page, vendor: Runtime): Promise<void> => {
  await expect
    .poll(async () => {
      const response = await getWithoutKeepAlive(page.request, endpoints.status.path)
      const { backends } = endpoints.status.response.parse(await response.json()).observer
      return backends.find((backend) => backend.vendor === vendor)?.state.state ?? null
    }, observed)
    .toBe('ok')
}

const stageOf = async (page: Page, run: RunId, title: string): Promise<Stage | null> => {
  const response = await getWithoutKeepAlive(page.request, endpoints.run.path.replace(':run', run))
  expect(response.status(), await response.text()).toBe(200)
  return endpoints.run.response.parse(await response.json()).model.stages.find((found) => found.title === title) ?? null
}

test.describe('with the observer of the attention zone', () => {
  test.use({
    config: fastSpool,
    claudeScenario: observerScenarios['attention-zone'].live,
    codexScenario: observerScenarios['attention-zone'].live,
  })

  test('items the observer opens and an unanswered question outlive the Claude session, blocked stages order them, the recommendation does not (E2E 15)', async ({
    page,
    player,
    profile,
    hook,
    fakeClaude,
  }) => {
    await observerAdmitted(page, 'claude')
    const played = await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })
    await played.play({ until: 'subagent-result' })
    const run = runOf(claudeOriginal)
    await page.goto(`/?run=${run}`)
    const blocker = zoneItem(page, checksBlockerText)
    const review = zoneItem(page, reviewRequestText)
    await expect(blocker).toContainText('blocks 2 stages', observed)
    await expect(blocker).toContainText('Blocker')
    await expect(blocker).toContainText('from the observer')
    await expect(blocker).not.toContainText('recommended')

    await page.getByRole('region', { name: 'Stage map' }).getByRole('button', { name: checksStageTitle, exact: true }).click()
    const selected = dock(page).getByRole('region', { name: 'Selected stage' })
    await expect(selected.getByRole('heading')).toHaveText(checksStageTitle)
    await expect(selected.getByRole('list', { name: 'Waiting for you' })).toContainText(`Blocker: ${checksBlockerText}`)
    await selected.getByRole('button', { name: 'Whole run' }).click()
    await expect(selected).toHaveCount(0)

    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await hook.claude('PreToolUse.Bash.json', askUser(fields, 'toolu_h3_observed_ask', choice))
    const question = zoneItem(page, choice)
    await expect(question).toContainText('awaiting an answer')
    await expect(question).toContainText('recommended: high priority', observed)
    await expect(openItems(page).nth(0)).toContainText(choice)
    await expect(openItems(page).nth(1)).toContainText(checksBlockerText)

    await appendFile(sessionFile(profile, claudeOriginal), await claudeFinalText('Done, take a look at the result.'))
    await expect(review).toContainText('Review request', observed)
    await expect(review).toContainText('from the observer')
    await expect(review).toContainText('blocks 1 stage')

    await hook.claude('SessionEnd.json', fields)
    await expect(question).toContainText('session ended')
    await expect(question).not.toContainText('awaiting an answer')
    await expect(openItems(page)).toHaveCount(3)
    await expect(openItems(page).nth(0)).toContainText(checksBlockerText)
    await expect(openItems(page).nth(1)).toContainText(choice)
    await expect(openItems(page).nth(2)).toContainText(reviewRequestText)
    await expect(question).toContainText('blocks 1 stage')
    await expect(question).toContainText('recommended: high priority')
    expect(await waitsForHuman(page, run, claudeOriginal.session)).toBe(false)
    expect((await stageOf(page, run, mainStageTitle))?.execution.value.state).not.toBe('waiting')

    const calls = fakeClaude.calls().length
    await hook.claude('SessionStart.resume.json', fields)
    await hook.claude('UserPromptSubmit.json', { ...fields, prompt: 'Run the linter and show the output' })
    await expect.poll(() => fakeClaude.calls().length, observed).toBeGreaterThan(calls)
    await expect(openItems(page)).toHaveCount(3)
    await expect(question).not.toContainText('likely answered')
    await expect(review).toBeVisible()

    await review.getByRole('button', { name: 'Dismiss' }).click()
    await expect(review).toHaveCount(0)
    await historyToggle(page).click()
    await expect(history(page).filter({ hasText: reviewRequestText })).toContainText('dismissed by the user')
    await expect(openItems(page)).toHaveCount(2)
  })

  test('a Codex async question answered in a later prompt is marked probably answered and stays open (E2E 15)', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await observerAdmitted(page, 'codex')
    await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(codexThread)}`)
    await expect(zoneItem(page, checksBlockerText)).toContainText('blocks 2 stages', observed)
    const fields = hookFields(profile, codexThread)
    await appendFile(sessionFile(profile, codexThread), codexAsyncQuestion(asyncAsk))
    const question = zoneItem(page, asyncAsk)
    await expect(question).toContainText('recommended: high priority', observed)
    await expect(question).not.toContainText('likely answered')

    await hook.codex('UserPromptSubmit.json', { ...fields, prompt: `${asyncAsk} Yes, go ahead.` })
    await expect(question).toContainText('likely answered', observed)
    await expect(question).toContainText('aang interpretation')
    await expect(question).toContainText('by aang rule')
    await expect(question.getByRole('button', { name: 'Dismiss' })).toBeVisible()
  })
})

test.describe('with the observer and a check contract', () => {
  test.use({
    config: {
      ...fastSpool,
      watch: { all: true, roots: [{ path: claudeOriginal.cwd, contracts: [{ name: 'test', command: '^pnpm test' }] }] },
    },
    claudeScenario: observerScenarios['claimed-done'].live,
  })

  test('the solver claims done over a failed check, the item of the check stays in the zone (E2E 3)', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await observerAdmitted(page, 'claude')
    const played = await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })
    await played.play({ until: 'subagent-result' })
    const run = runOf(claudeOriginal)
    await page.goto(`/?run=${run}`)
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('PreToolUse.Bash.json', testRun(fields, 'toolu_h3_claimed_test'))
    await hook.claude('PostToolUseFailure.Bash.json', {
      ...testRun(fields, 'toolu_h3_claimed_test'),
      error: 'Exit code 1\n1 test failed',
    })
    const failed = zoneItem(page, 'Failed check')
    await expect(failed).toContainText('Check "test" failed')

    await appendFile(sessionFile(profile, claudeOriginal), await claudeFinalText('All done.'))
    await expect
      .poll(async () => (await stageOf(page, run, mainStageTitle))?.execution.value.state ?? null, observed)
      .toBe('done')
    expect((await stageOf(page, run, mainStageTitle))?.execution.basis.kind).toBe('claimed')
    await expect(failed).toContainText('Check "test" failed')
    await expect(failed).toContainText('by aang rule')
    await expect
      .poll(async () => {
        const { open, waiting_for_human: waiting } = (await snapshotOf(page, run)).summary.attention
        return { open, waiting }
      })
      .toEqual({ open: 1, waiting: 0 })
  })
})
