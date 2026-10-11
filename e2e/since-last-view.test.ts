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
import { aangEntry, expect, getWithoutKeepAlive, type HookFields, type HookSamples, test } from './fixtures.js'
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

const nothingChanged = 'Nothing changed since the mark.'

const run = runOf(claudeOriginal)

const reportPath = `${claudeOriginal.cwd}/report.md`

const observed = { timeout: 60_000 }

const snapshotOf = async (request: APIRequestContext): Promise<RunSnapshot | null> => {
  const response = await getWithoutKeepAlive(request, endpoints.run.path.replace(':run', run))
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
  const response = await getWithoutKeepAlive(request, endpoints.fact.path.replace(':id', id))
  return `raw record #${String(endpoints.fact.response.parse(await response.json()).fact.seq)}`
}

const journalRecords = async (request: APIRequestContext, title: string, op: string): Promise<string[]> => {
  const response = await getWithoutKeepAlive(
    request,
    endpoints.stage.path.replace(':run', run).replace(':stage', await stageId(request, title)),
  )
  const { history } = endpoints.stage.response.parse(await response.json())
  const evidence = history.filter((change) => change.op === op).flatMap((change) => change.evidence)
  return (await Promise.all([...new Set(evidence)].map((id) => recordOf(request, id)))).sort()
}

const shownRecords = async (item: Locator): Promise<string[]> =>
  (await item.getByRole('listitem').filter({ hasText: /raw record #\d+/ }).allTextContents())
    .map((text) => /raw record #\d+/.exec(text)?.[0] ?? text)
    .sort()

const expectGrounds = async (item: Locator, records: readonly string[]): Promise<void> => {
  expect(records.length).toBeGreaterThan(0)
  await item.getByRole('button', { name: /^Grounds: / }).click()
  const more = item.getByRole('button', { name: /^Show all / })
  if (records.length > 6) {
    await more.click()
  }
  await expect(more).toHaveCount(0)
  await expect.poll(() => shownRecords(item)).toEqual(records)
}

const markedVersion = async (page: Page): Promise<string> =>
  /map version \d+/.exec((await mark(page).textContent()) ?? '')?.[0] ?? 'no mark'

const expectAcceptedTurn = async (page: Page): Promise<void> => {
  await expect(fact(page, 'Agents')).toHaveText('2', observed)
  await expect(fact(page, 'State')).toHaveText('waiting for input', observed)
}

const askUser = (question: string): Readonly<Record<string, unknown>> => ({
  questions: [{ question, header: 'Choice', options: [{ label: 'First' }, { label: 'Second' }], multiSelect: false }],
})

const writeFile = async (hook: HookSamples, fields: HookFields, path: string, id: string): Promise<void> => {
  const write = {
    ...fields,
    tool_name: 'Write',
    tool_use_id: id,
    tool_input: { file_path: path, content: 'Run summary\n' },
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
  await writeText(join(directory, 'answer.md'), 'Answer\n')
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
  await expect(mark(page)).toContainText('Not marked as reviewed')

  await sinceTab(page).click()
  await expect(page).toHaveURL(/mode=changes/)
  await expect(since(page)).toContainText('The run is not marked as reviewed yet.')
  await expect(since(page)).toContainText('sends nothing to the solver')
  await expect(trace(page)).toHaveCount(0)

  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('UserPromptSubmit.json', fields)
  await hook.claude('PreToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h7_probe', tool_input: probe })
  await hook.claude('PermissionRequest.Bash.json', fields)
  await ask(hook, fields, 'Which format to choose?', 'toolu_h7_format')
  await expect(zoneItem(page, 'Bash: touch probe-perm.txt')).toContainText('awaiting an answer')
  await expect(zoneItem(page, 'Which format to choose?')).toContainText('awaiting an answer')

  await markButton(page).click()
  await expect(mark(page)).toContainText('Reviewed just now')
  await expect(since(page)).toContainText(nothingChanged)
  const marked = await markedVersion(page)

  await replay.play({ until: 'fork' })
  await hook.claude('PostToolUse.Bash.json', { ...fields, tool_use_id: 'toolu_h7_probe', tool_input: probe })
  await hook.claude('PostToolUse.Bash.json', {
    ...fields,
    tool_name: 'AskUserQuestion',
    tool_use_id: 'toolu_h7_format',
    tool_input: askUser('Which format to choose?'),
    tool_response: { ...askUser('Which format to choose?'), answers: { 'Which format to choose?': 'First' } },
  })
  await hook.claude('PreToolUse.Bash.json', {
    ...fields,
    tool_name: 'TodoWrite',
    tool_use_id: 'toolu_h7_todo',
    tool_input: {
      todos: [
        { content: 'Build the report', status: 'completed' },
        { content: 'Agree on the report', status: 'in_progress' },
      ],
    },
  })
  await writeFile(hook, fields, reportPath, 'toolu_h7_write')
  await ask(hook, fields, 'Which report to keep?', 'toolu_h7_ask')

  const question = change(page, 'Questions and requests', 'Which report to keep?')
  await expect(question).toContainText('opened')
  await expect(question).toContainText('Question')
  await expect(question).toContainText('by aang rule')
  await expect(question).toContainText('Session 86f93ed5, main agent')
  const approval = change(page, 'Questions and requests', 'Bash: touch probe-perm.txt')
  await expect(approval).toContainText('closed')
  await expect(approval).toContainText('Approval request')
  const answered = change(page, 'Questions and requests', 'Which format to choose?')
  await expect(answered).toContainText('closed')
  await expect(answered).toContainText('answered')

  const report = change(page, 'Outputs', 'report.md')
  await expect(report.locator('code')).toHaveText(/[\\/]cc-transcripts[\\/]run[\\/]report\.md$/)
  await expect(report).toContainText('new version')
  await expect(report).toContainText('written by Write')
  await expect(report).toContainText('Session 86f93ed5, main agent')

  await expect(sinceSection(page, 'Solver plan')).toContainText('Solver tasks')
  await expect(sinceSection(page, 'Solver plan')).toContainText('Agree on the report')
  const main = change(page, 'Agent actions', 'Main agent')
  await expect(main).toContainText('Write 1')
  await expect(sinceTab(page)).toHaveAccessibleName(/^Since last review, \d+ change/)
  expect(await markedVersion(page)).toBe(marked)

  await question.getByRole('button', { name: /^Grounds: / }).click()
  await expect(question).toContainText('question')
  await expect(question).toContainText(/raw record #\d+/)
  await report.getByRole('button', { name: /^Grounds: / }).click()
  await expect(report).toContainText(`Write: ${reportPath}`)
  await report.getByRole('button', { name: 'Hide grounds' }).click()
  await expect(report).not.toContainText(`Write: ${reportPath}`)
  await approval.getByRole('button', { name: /^Grounds: / }).click()
  await expect(approval).toContainText('approval request')
  await expect(approval).toContainText('Bash: touch probe-perm.txt')
  await answered.getByRole('button', { name: /^Grounds: / }).click()
  await expect(answered).toContainText(/raw record #\d+/)

  await markButton(page).click()
  await expect(since(page)).toContainText(nothingChanged)
  await expect(sinceTab(page)).toHaveAccessibleName('Since last review')
  expect(await markedVersion(page)).not.toBe(marked)

  await traceTab(page).click()
  await expect(page).not.toHaveURL(/mode=changes/)
  await expect(since(page)).toHaveCount(0)
  await expect(plan(page)).toContainText('Agree on the report')
  await expect(lamp(page, 'Link')).toHaveText('Link stream connected')
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
    const tests = change(page, 'Revised decisions', 'Criterion "Check "tests" passes"')
    await expect(tests).toContainText('new')
    await expect(tests).toContainText('passed without a version')
    await expect(tests).not.toContainText('confirmed')
    await markButton(page).click()
    await expect(since(page)).toContainText(nothingChanged)

    await runCheck(hook, fields, 'toolu_h7_tests_commit', { command: 'pnpm test', cwd: repository }, `tested commit ${commit}`)
    await runCheck(hook, fields, 'toolu_h7_lint', { command: 'pnpm lint' }, 'no problems')
    await expect(tests).toContainText('changed')
    await expect(tests).toContainText('before: passed without a version')
    await expect(tests).toContainText('after: confirmed')
    await expect(tests).toContainText('observed event')
    await tests.getByRole('button', { name: /^Grounds: / }).click()
    await expect(tests).toContainText('Bash: pnpm test')
    await expect(tests).toContainText(/raw record #\d+/)
    const lint = change(page, 'Revised decisions', 'Criterion "Check "lint" passes"')
    await expect(lint).toContainText('new')
    await expect(lint).toContainText('passed without a version')
    await expect(lint).not.toContainText('confirmed')

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
    await expect(mark(page)).toContainText('Reviewed just now, map version')
    await page.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: 'Runs' }).click()
    const row = runRowOf(page, run)
    await expect(row).toBeVisible()

    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('UserPromptSubmit.json', fields)
    await writeFile(hook, fields, notesPath, 'toolu_h7_notes')
    await ask(hook, fields, 'Publish the notes?', 'toolu_h7_publish')
    await expect(row).toContainText('awaiting an answer: 1')

    await row.getByRole('link').click()
    await expect(lamp(page, 'Model')).toHaveText('Model not built')
    await expect(sinceTab(page)).toHaveAccessibleName(/^Since last review, \d+ change/)
    await sinceTab(page).click()
    await expect(change(page, 'Outputs', 'notes.md')).toContainText('new version')
    await expect(change(page, 'Questions and requests', 'Publish the notes?')).toContainText('opened')

    await markButton(page).click()
    await expect(since(page)).toContainText(nothingChanged)
    const marked = await markedVersion(page)

    expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
    await expect(lamp(page, 'Link')).toHaveText('Link no connection to the daemon')
    await profile.configure({
      ...config,
      collector: { rootsScanIntervalMs: 250, spoolScanIntervalMs: 250 },
      api: { port: daemon.api.port },
    })
    const restarted = await profile.startDaemon({ entry: aangEntry })
    await expect(lamp(page, 'Link')).toHaveText('Link stream connected')
    await expect(since(page)).toContainText(nothingChanged)
    expect(await markedVersion(page)).toBe(marked)

    const returned = await context.newPage()
    await returned.goto(`/?run=${run}&mode=changes`)
    await expect(mark(returned)).toContainText(marked)
    await expect(since(returned)).toContainText(nothingChanged)
    await expect(sinceTab(returned)).toHaveAccessibleName('Since last review')
    await expect(zoneItem(returned, 'Publish the notes?')).toContainText('awaiting an answer')
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
  const question = 'Check the report against the sources?'
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${run}&mode=changes`)
  await expectAcceptedTurn(page)
  await markButton(page).click()
  await expect(since(page)).toContainText(nothingChanged)

  const release = await holdChanges(page)
  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('UserPromptSubmit.json', fields)
  await ask(hook, fields, question, 'toolu_h7_unseen')
  await expect(zoneItem(page, question)).toContainText('awaiting an answer')
  await expect(since(page)).toContainText(nothingChanged)
  const saved = page.waitForResponse((response) => response.url().endsWith('/viewed'))
  await markButton(page).click()
  expect((await saved).status()).toBe(200)

  release()
  await expect(change(page, 'Questions and requests', question)).toContainText('opened')
  const returned = await context.newPage()
  await returned.goto(`/?run=${run}&mode=changes`)
  await expect(change(returned, 'Questions and requests', question)).toContainText('opened')
  await returned.close()
})

test('a changes read that hangs times out, says so and recovers without a reload', async ({
  page,
  player,
  profile,
  hook,
}) => {
  const question = 'Postpone publishing?'
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${run}&mode=changes`)
  await expectAcceptedTurn(page)
  await markButton(page).click()
  await expect(since(page)).toContainText(nothingChanged)

  const release = await holdChanges(page)
  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('UserPromptSubmit.json', fields)
  await ask(hook, fields, question, 'toolu_h7_hang')
  await expect(zoneItem(page, question)).toContainText('awaiting an answer')
  await expect(since(page)).toContainText('Changes are not updating: the daemon did not respond.', { timeout: 20_000 })
  await expect(since(page)).toContainText(nothingChanged)
  release()
  await expect(change(page, 'Questions and requests', question)).toContainText('opened')
  await expect(since(page)).not.toContainText('Changes are not updating')
})

test('a failed mark, changes read or grounds read says so and recovers', async ({ page, player, profile, hook }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto(`/?run=${run}&mode=changes`)
  await expectAcceptedTurn(page)
  await expect(since(page)).toContainText('The run is not marked as reviewed yet.')

  await page.route('**/viewed', (route) => route.abort('connectionfailed'))
  await markButton(page).click()
  await expect(mark(page)).toContainText('Mark not saved: the daemon did not respond.')
  await expect(mark(page)).toContainText('Not marked as reviewed')
  await page.unroute('**/viewed')
  const refusal = { error: { code: 'invalid_request', message: 'the run moved on' } }
  await page.route('**/viewed', (route) => route.fulfill({ status: 400, json: refusal }))
  await markButton(page).click()
  await expect(mark(page)).toContainText('Mark not saved: the daemon refused (the run moved on).')
  await page.unroute('**/viewed')

  await page.route(changesRead, (route) => route.abort('connectionfailed'))
  await markButton(page).click()
  await expect(mark(page)).toContainText('Reviewed just now')
  await expect(mark(page)).not.toContainText('Mark not saved')
  await expect(since(page)).toContainText('Changes not received: the daemon did not respond.')
  await page.unroute(changesRead)
  await expect(since(page)).toContainText(nothingChanged)

  await page.route(changesRead, (route) => route.abort('connectionfailed'))
  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('UserPromptSubmit.json', fields)
  await ask(hook, fields, 'Continue without checking?', 'toolu_h7_continue')
  await expect(zoneItem(page, 'Continue without checking?')).toBeVisible()
  await expect(since(page)).toContainText('Changes are not updating: the daemon did not respond.')
  await expect(since(page)).toContainText(nothingChanged)
  await page.unroute(changesRead)
  const question = change(page, 'Questions and requests', 'Continue without checking?')
  await expect(question).toContainText('opened')
  await expect(since(page)).not.toContainText('Changes are not updating')

  await page.route('**/api/facts/**', (route) => route.abort('connectionfailed'))
  await question.getByRole('button', { name: /^Grounds: / }).click()
  await expect(question).toContainText('Grounds not loaded: the daemon did not respond.')
  await page.unroute('**/api/facts/**')
  await question.getByRole('button', { name: 'Retry' }).click()
  await expect(question).toContainText(/raw record #\d+/)
  await expect(question).not.toContainText('Grounds not loaded')
})

test.describe('when the sign-in session ends', () => {
  const unauthorized = { error: { code: 'unauthorized', message: 'the session ended' } }

  test('a mark shows the sign-in screen', async ({ page, player }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${run}`)
    await page.route('**/viewed', (route) => route.fulfill({ status: 401, json: unauthorized }))
    await markButton(page).click()
    await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible()
  })

  test('a changes read shows the sign-in screen', async ({ page, player }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${run}&mode=changes`)
    await page.route(changesRead, (route) => route.fulfill({ status: 401, json: unauthorized }))
    await markButton(page).click()
    await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible()
  })

  test('a grounds read shows the sign-in screen', async ({ page, player, profile, hook }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await page.goto(`/?run=${run}&mode=changes`)
    await expectAcceptedTurn(page)
    await markButton(page).click()
    await expect(since(page)).toContainText(nothingChanged)
    const fields = hookFields(profile, claudeOriginal)
    await ask(hook, fields, 'Stop the run?', 'toolu_h7_stop')
    const question = change(page, 'Questions and requests', 'Stop the run?')
    await page.route('**/api/facts/**', (route) => route.fulfill({ status: 401, json: unauthorized }))
    await question.getByRole('button', { name: /^Grounds: / }).click()
    await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible()
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

      const replaced = change(page, 'Revised decisions', `Stage "${mainStageTitle}"`)
      await expect(replaced).toContainText('replaced', observed)
      await expect(replaced).toContainText(`replaced by stage "${continuedStageTitle}"`)
      await expect(replaced).toContainText('aang interpretation')
      await expect(replaced).toContainText(/map journal: version \d+/)
      await expect.poll(() => settled(page.request), observed).toBe(0)
      const replacement = await journalRecords(page.request, mainStageTitle, 'stage.replace')
      const creation = await journalRecords(page.request, mainStageTitle, 'stage.create')
      expect(replacement.filter((record) => creation.includes(record))).toEqual([])
      await expectGrounds(replaced, replacement)

      const continued = change(page, 'Stages', `"${continuedStageTitle}"`)
      await expect(continued).toContainText('new')
      await continued.getByRole('button', { name: /^Grounds: / }).click()
      await expect(continued).toContainText(/raw record #\d+/)
      const more = continued.getByRole('button', { name: /^Show all \d+ records$/ })
      await more.click()
      await expect(more).toHaveCount(0)
      await expect
        .poll(() => continued.getByRole('listitem').filter({ hasText: /raw record #\d+/ }).count())
        .toBeGreaterThan(6)

      const question = change(page, 'Questions and requests', continuationQuestionText)
      await expect(question).toContainText('opened', observed)
      await expect(question).toContainText('from the observer')

      await expect(sinceSection(page, 'Solver results')).toBeVisible(observed)
      const [first] = (await snapshotOf(page.request))?.model.cards ?? []
      expect(first).toBeDefined()
      const card = change(page, 'Solver results', first?.text ?? '')
      await expect(card).toContainText('new')
      await expect(card).toContainText(`stage "${continuedStageTitle}"`)
      await card.getByRole('button', { name: 'Show original' }).click()
      const original = card.getByRole('figure')
      await expect(original.locator('mark')).toHaveText(first?.text ?? '')
      await expect(original).toContainText('message')
      await expect(original).toContainText('solver')
      await card.getByRole('button', { name: 'Hide original' }).click()
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
      const delegated = change(page, 'Stages', `"${shown}"`)
      await expect(delegated).toContainText('new', observed)
      await expect(delegated).not.toContainText(agent.id)
      await expect(delegated.getByTitle(title, { exact: true })).toHaveText(`"${shown}"`)
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
      const sources = change(page, 'Revised decisions', `Stage "${outlineStageTitles.sources}"`)
      await expect(sources).toContainText('merged', observed)
      await expect.poll(() => settled(page.request), observed).toBe(0)

      const prepared = `"${reshapedStageTitles.prepared}"`
      await expect(sources).toContainText(`merged into stage ${prepared}`)
      const draft = change(page, 'Revised decisions', `Stage "${outlineStageTitles.draft}"`)
      await expect(draft).toContainText(`merged into stage ${prepared}`)
      const check = change(page, 'Revised decisions', `Stage "${outlineStageTitles.check}"`)
      await expect(check).toContainText('split')
      await expect(check).toContainText(
        `split into stages "${reshapedStageTitles.facts}", "${reshapedStageTitles.wording}"`,
      )
      await expect(check).toContainText('aang interpretation')
      const merge = await journalRecords(page.request, outlineStageTitles.sources, 'stage.merge')
      const creation = await journalRecords(page.request, outlineStageTitles.sources, 'stage.create')
      expect(merge.filter((record) => creation.includes(record))).toEqual([])
      await expectGrounds(sources, merge)
      await expectGrounds(check, await journalRecords(page.request, outlineStageTitles.check, 'stage.split'))

      const goal = change(page, 'Revised decisions', `Criterion "${goalCriterionText}"`)
      await expect(goal).toContainText('changed')
      await expect(goal).toContainText('before: not checked')
      await expect(goal).toContainText('after: partially confirmed')
      await expect(goal).toContainText('aang interpretation')
      await goal.getByRole('button', { name: /^Grounds: / }).click()
      await expect(goal).toContainText(/raw record #\d+/)
      const checked = change(page, 'Revised decisions', `Criterion "${checkedCriterionText}"`)
      await expect(checked).toContainText('new')
      await expect(checked).toContainText('not checked')
      await expect(checked).not.toContainText('before:')

      for (const title of Object.values(reshapedStageTitles)) {
        await expect(change(page, 'Stages', `"${title}"`)).toContainText('new')
      }
      const notify = change(page, 'Stages', `"${renamedStageTitle}"`)
      await expect(notify).toContainText('changed')
      await expect(notify).toContainText(`before: "${outlineStageTitles.notify}"`)
      await expect(notify).toContainText(`after: "${renamedStageTitle}"`)
      await expectGrounds(notify, await journalRecords(page.request, renamedStageTitle, 'stage.update'))
      const publish = change(page, 'Stages', `"${outlineStageTitles.publish}"`)
      await expect(publish).toContainText('changed')
      await expect(publish).toContainText(/map journal: version \d+/)
      await expectGrounds(publish, await journalRecords(page.request, outlineStageTitles.publish, 'stage.depends'))

      const returned = await context.newPage()
      const inspector = '**/api/runs/*/stages/*'
      await returned.route(inspector, (route) => route.abort('connectionfailed'))
      await returned.goto(`/?run=${run}&mode=changes`)
      const failed = change(returned, 'Stages', `"${outlineStageTitles.publish}"`)
      await expect(failed).toContainText('Grounds not loaded: the daemon did not respond.')
      await returned.unroute(inspector)
      await failed.getByRole('button', { name: 'Retry' }).click()
      await expect(failed.getByRole('button', { name: /^Grounds: / })).toBeVisible()
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
      await expect(mark(page)).toContainText('Reviewed just now')

      const failing: ClaudeScenario = {
        replies: [{ kind: 'limit', resetsAt: Math.floor(Date.now() / 1000) + 20 }],
        chatReplies: [],
      }
      fakeClaude.setScenario(failing)
      const fields = hookFields(profile, claudeOriginal)
      await hook.claude('UserPromptSubmit.json', fields)
      await writeFile(hook, fields, notesPath, 'toolu_h7_notes')
      await ask(hook, fields, 'Publish the notes?', 'toolu_h7_publish')
      await expect(lamp(page, 'Observer')).toContainText('subscription limit reached', observed)

      await sinceTab(page).click()
      await expect(change(page, 'Outputs', 'notes.md')).toContainText('new version')
      await expect(change(page, 'Questions and requests', 'Publish the notes?')).toContainText('by aang rule')
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
      await expect(lamp(page, 'Link')).toHaveText('Link stream connected')
      await expect(lamp(page, 'Observer')).toContainText('working', { timeout: 90_000 })
      await expect.poll(async () => (await snapshotOf(page.request))?.summary.observer.pending_facts, observed).toBe(0)

      expect(await markedVersion(page)).toBe(marked)
      await expect(since(page)).not.toContainText('notes.md')
      await expect(since(page)).not.toContainText('Publish the notes?')
      const returned = await context.newPage()
      await returned.goto(`/?run=${run}&mode=changes`)
      await expect(mark(returned)).toContainText(marked)
      await expect(since(returned)).not.toContainText('notes.md')
      await expect(since(returned)).not.toContainText('Publish the notes?')
      await expect(zoneItem(returned, 'Publish the notes?')).toContainText('awaiting an answer')
      await returned.close()
      expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
    })
  })
})
