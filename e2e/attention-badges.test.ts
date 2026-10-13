import { appendFile, readFile } from 'node:fs/promises'
import { endpoints, RunId, type RunSnapshot, type Runtime, type Stage } from '@aang/contract'
import {
  checksBlockerText,
  checksStageTitle,
  loadManifest,
  mainStageTitle,
  nestedBlockerText,
  observerScenarios,
  type RunningDaemon,
  sampleScenarioManifest,
} from '@aang/testkit'
import type { Locator, Page } from '@playwright/test'
import { expect, getWithoutKeepAlive, type HookFields, test } from './fixtures.js'
import { hooksOnly, recording } from './recordings.js'
import { claudeOriginal, codexThread, hookFields, runOf, sessionFile } from './samples.js'
import { dock, runRowOf, waitingChip, waitingFor } from './screens.js'

const observed = { timeout: 30_000 }

const fastSpool = { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } }

const map = (page: Page): Locator => page.getByRole('region', { name: 'Stage map' })

const stage = (page: Page, title: string | RegExp): Locator =>
  map(page).getByRole('group', { name: typeof title === 'string' ? `Stage "${title}"` : title })

const badge = (card: Locator, count: number): Locator => card.getByText(`Waiting for you: ${String(count)}`, { exact: true })

const pingerStage = /^Stage "pinger \(.+\)"$/

const choice = 'Which option should I pick?'

const probe = { command: 'touch probe-perm.txt', description: 'Create empty probe file' }

const asyncAsk = 'Proceed with probe?'

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

const snapshotOf = async (page: Page, run: RunId): Promise<RunSnapshot> => {
  const response = await getWithoutKeepAlive(page.request, endpoints.run.path.replace(':run', run))
  expect(response.status(), await response.text()).toBe(200)
  return endpoints.run.response.parse(await response.json())
}

const stageOf = async (page: Page, run: RunId, title: string): Promise<Stage | null> =>
  (await snapshotOf(page, run)).model.stages.find((found) => found.title === title) ?? null

const sessionEnded = async (page: Page, run: RunId, session: string): Promise<boolean> =>
  (await snapshotOf(page, run)).objects.sessions.some(({ key, state }) => key.session === session && state === 'ended')

const observerAdmitted = async (page: Page, vendor: Runtime): Promise<void> => {
  await expect
    .poll(async () => {
      const response = await getWithoutKeepAlive(page.request, endpoints.status.path)
      const { backends } = endpoints.status.response.parse(await response.json()).observer
      return backends.find((backend) => backend.vendor === vendor)?.state.state ?? null
    }, observed)
    .toBe('ok')
}

const hideStage = async (daemon: RunningDaemon, run: RunId, id: string): Promise<void> => {
  const response = await daemon.request(endpoints.createViewRule.path.replace(':run', run), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'hide', selector: { kind: 'stage_ids', stages: [id] }, params: null }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
}

test.use({ config: fastSpool })

test.describe('with the observer opening attention items', () => {
  test.skip(process.platform === 'win32', 'the fake claude cannot be the observer CLI on Windows')
  test.use({ claudeScenario: observerScenarios['attention-zone'].live })

  test('a stage with an open item carries a waiting badge and lists the item when selected', async ({
    page,
    player,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    const run = runOf(claudeOriginal)
    await page.goto(`/?run=${run}`)

    const checks = stage(page, checksStageTitle)
    await expect(badge(checks, 1)).toBeVisible(observed)
    await expect(page.getByRole('region', { name: 'Attention', exact: true })).toHaveCount(0)
    await checks.getByRole('button', { name: checksStageTitle, exact: true }).click()
    const selected = dock(page).getByRole('region', { name: 'Selected stage' })
    await expect(selected.getByRole('heading')).toHaveText(checksStageTitle)
    await expect(selected.getByRole('list', { name: 'Waiting for you' })).toContainText(`Blocker: ${checksBlockerText}`)
    await expect(selected.getByRole('button', { name: 'Whole run', exact: true })).toHaveText('✕ Whole run')
    await selected.getByRole('button', { name: 'Whole run' }).click()
    await expect(selected).toHaveCount(0)

    const open = (await snapshotOf(page, run)).attention.items.filter(({ resolution }) => resolution === 'open')
    expect(open.some(({ runtime_wait: wait }) => wait === 'active')).toBe(false)
    await page.goto('/')
    await expect(runRowOf(page, run)).toContainText(`Waiting for you: ${String(open.length)}`)
  })
})

test.describe('with the observer opening an item on a substage', () => {
  test.skip(process.platform === 'win32', 'the fake claude cannot be the observer CLI on Windows')
  test.use({ claudeScenario: observerScenarios['nested-attention'].live })

  test('a collapsed stage counts the open items of the substages it hides', async ({ page, player }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${runOf(claudeOriginal)}`)

    const main = stage(page, mainStageTitle)
    const pinger = stage(page, pingerStage)
    await expect(badge(pinger, 1)).toBeVisible(observed)
    await expect(main.getByText(/^Waiting for you: /)).toHaveCount(0)

    await expect(badge(pinger, 1)).toHaveAttribute('title', 'Waiting for you: 1')
    await main.getByRole('button', { name: `Collapse "${mainStageTitle}"` }).click()
    await expect(pinger).toHaveCount(0)
    await expect(badge(main, 1)).toBeVisible()
    await expect(badge(main, 1)).toHaveAttribute('title', 'Waiting for you: 1')
    await expect(waitingChip(page)).toHaveCount(0)
    await main.getByRole('button', { name: mainStageTitle, exact: true }).click()
    const selected = dock(page).getByRole('region', { name: 'Selected stage' })
    await expect(selected.getByRole('heading')).toHaveText(mainStageTitle)
    await expect(selected.getByRole('list', { name: 'Waiting for you' }).getByRole('listitem')).toHaveText([
      new RegExp(`^pinger \\(.+\\) · Blocker: ${nestedBlockerText}$`),
    ])
    await selected.getByRole('button', { name: 'Whole run' }).click()

    await main.getByRole('button', { name: `Expand "${mainStageTitle}"` }).click()
    await expect(badge(pinger, 1)).toBeVisible()
    await expect(main.getByText(/^Waiting for you: /)).toHaveCount(0)
  })

  test('the item of a stage a filter hides moves to the header chip and back when the filter is removed', async ({
    page,
    player,
    daemon,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    const run = runOf(claudeOriginal)
    await page.goto(`/?run=${run}`)

    const pinger = stage(page, pingerStage)
    await expect(badge(pinger, 1)).toBeVisible(observed)
    await expect(waitingChip(page)).toHaveCount(0)
    const item = (await snapshotOf(page, run)).attention.items.find(({ text }) => text === nestedBlockerText)
    expect(item?.stage).not.toBeNull()

    await hideStage(daemon, run, item?.stage ?? '')
    await expect(pinger).toHaveCount(0)
    await expect(waitingChip(page)).toHaveAccessibleName('Waiting for you: 1')
    await expect(waitingFor(page)).toHaveText(`Blocker: ${nestedBlockerText}`)

    await map(page).getByRole('button', { name: /^Remove filter: hide stage / }).click()
    await expect(badge(pinger, 1)).toBeVisible()
    await expect(waitingChip(page)).toHaveCount(0)
  })
})

test('a question without a stage is counted in the header, listed on hover and focus, and leaves when answered', async ({
  page,
  player,
}) => {
  const manifest = await loadManifest(recording('claude', '2.1.289', 'claude_cli', 'question'))
  const played = await player(hooksOnly(manifest), { timeScale: 0 })
  await played.play({ until: 'question-answered' })
  await page.goto('/')
  await page.getByRole('list', { name: 'Chats' }).getByRole('listitem').first().getByRole('link').click()
  const run = RunId.parse(new URL(page.url()).searchParams.get('run'))
  await expect
    .poll(async () =>
      (await snapshotOf(page, run)).attention.items
        .filter(({ resolution }) => resolution === 'open')
        .map(({ stage: placed }) => placed),
    )
    .toEqual([null])

  const greeting = 'Which greeting should I use?'
  const waiting = waitingChip(page)
  await expect(waiting).toHaveAccessibleName('Waiting for you: 1', observed)
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toHaveCount(0)
  await waiting.hover()
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toHaveText(`Question: ${greeting}`)
  await expect(tooltip).not.toContainText('Approval request')
  await expect(waiting).toHaveAccessibleDescription(`Question: ${greeting}`)
  await page.mouse.move(0, 600)
  await expect(tooltip).toHaveCount(0)

  await waiting.focus()
  await expect(tooltip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
  await expect(waiting).toBeFocused()

  await page.goto('/')
  await expect(runRowOf(page, run)).toContainText('Waiting for you: 1')

  await played.play()
  await expect(runRowOf(page, run)).not.toContainText('Waiting for you')
  await runRowOf(page, run).getByRole('link').click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(waiting).toHaveCount(0)
})

test('an unanswered Claude question stays waiting after the session ends, resumes and gets a new prompt (E2E 15)', async ({
  page,
  player,
  profile,
  hook,
}) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  const run = runOf(claudeOriginal)
  await page.goto(`/?run=${run}`)
  await expect.poll(async () => (await snapshotOf(page, run)).summary.agents).toBe(2)
  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('UserPromptSubmit.json', fields)
  await hook.claude('PreToolUse.Bash.json', askUser(fields, 'toolu_h3_ask', choice))
  await expect(waitingFor(page)).toHaveText(`Question: ${choice}`)

  await hook.claude('SessionEnd.json', fields)
  await expect.poll(() => sessionEnded(page, run, claudeOriginal.session)).toBe(true)
  await expect(waitingChip(page)).toHaveAccessibleName('Waiting for you: 1')
  await expect(waitingFor(page)).toHaveText(`Question: ${choice}`)

  await hook.claude('SessionStart.resume.json', fields)
  await hook.claude('UserPromptSubmit.json', { ...fields, prompt: 'Run the linter and show the output' })
  await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h3_probe', tool_input: probe })
  await hook.claude('PermissionRequest.Bash.json', fields)
  await expect(waitingChip(page)).toHaveAccessibleName('Waiting for you: 2')
  await expect(waitingFor(page)).toContainText(`Question: ${choice}`)
  await expect(waitingFor(page)).toContainText('Approval request: Bash: touch probe-perm.txt')
})

test('a Codex async question stays waiting after the session ends and a new prompt (E2E 15)', async ({
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
  await expect(waitingFor(page)).toHaveText(`Question: ${asyncAsk}`)

  await hook.codex('SessionEnd.json', fields)
  await expect.poll(() => sessionEnded(page, run, codexThread.session)).toBe(true)
  await hook.codex('UserPromptSubmit.json', { ...fields, prompt: 'Run the linter' })
  await expect.poll(() => sessionEnded(page, run, codexThread.session)).toBe(false)
  await expect(waitingFor(page)).toHaveText(`Question: ${asyncAsk}`)
  await page.reload()
  await expect(waitingChip(page)).toHaveAccessibleName('Waiting for you: 1')
  await expect(waitingFor(page)).toHaveText(`Question: ${asyncAsk}`)
})

test.describe('with the observer and a check contract', () => {
  test.skip(process.platform === 'win32', 'the fake claude cannot be the observer CLI on Windows')
  test.use({
    config: {
      ...fastSpool,
      watch: { all: true, roots: [{ path: claudeOriginal.cwd, contracts: [{ name: 'test', command: '^pnpm test' }] }] },
    },
    claudeScenario: observerScenarios['claimed-done'].live,
  })

  test('a failed check stays waiting after the solver claims done and leaves when a retry passes (E2E 3)', async ({
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
    await expect(waitingFor(page)).toContainText('Failed check: Check "test" failed')

    await appendFile(sessionFile(profile, claudeOriginal), await claudeFinalText('All done.'))
    await expect
      .poll(async () => (await stageOf(page, run, mainStageTitle))?.execution.value.state ?? null, observed)
      .toBe('done')
    expect((await stageOf(page, run, mainStageTitle))?.execution.basis.kind).toBe('claimed')
    await expect(stage(page, mainStageTitle)).toContainText('Execution: done')
    await expect(waitingChip(page)).toHaveAccessibleName('Waiting for you: 1')
    await expect(waitingFor(page)).toContainText('Failed check: Check "test" failed')

    await hook.claude('PreToolUse.Bash.json', testRun(fields, 'toolu_h3_claimed_retry'))
    await hook.claude('PostToolUse.Bash.json', testRun(fields, 'toolu_h3_claimed_retry'))
    await expect(waitingChip(page)).toHaveCount(0)
  })
})
