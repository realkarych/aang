import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  type Agent,
  type AppliedViewRule,
  ChatInput,
  endpoints,
  type Fact,
  type FactId,
  type RunId,
  type RunSnapshot,
  type Runtime,
  type Stage,
  type StageId,
  type ViewElement,
  type ViewPlacement,
  type ViewRuleSpec,
} from '@aang/contract'
import { runId } from '@aang/contract/ids'
import {
  chatAnswerReport,
  type ClaudeReply,
  type FakeCall,
  type LoadedManifest,
  loadManifest,
  mainStageTitle,
  observerScenarios,
  type Player,
  type PlayerStep,
  preparationStageTitle,
  reportStageTitle,
  type RunningDaemon,
  sampleScenarioManifest,
} from '@aang/testkit'
import type { Locator, Page, Route } from '@playwright/test'
import { expect, getWithoutKeepAlive, type HookFields, test } from './fixtures.js'
import { codexRecording, threadsOf } from './recordings.js'
import { claudeOriginal, codexThread, hookFields, runOf } from './samples.js'
import { chips, versionOf, waitingFor } from './screens.js'

const observed = { timeout: 30_000 }

const claudeRun = runOf(claudeOriginal)

const reviewerAgent = 'aad616394e806288d'

const approvalText = 'Bash: touch probe-perm.txt'

test.use({ config: { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } } })

const chat = (page: Page): Locator => page.getByRole('region', { name: 'Chat', exact: true })

const entry = (page: Page, question: string): Locator =>
  chat(page)
    .getByRole('list', { name: 'Questions and answers' })
    .getByRole('listitem')
    .filter({ has: page.getByText(question, { exact: true }) })

const ask = async (page: Page, question: string): Promise<Locator> => {
  await chat(page).getByRole('textbox', { name: 'Question' }).fill(question)
  await chat(page).getByRole('button', { name: 'Ask', exact: true }).click()
  return entry(page, question)
}

const citations = (asked: Locator): Locator => asked.getByRole('list', { name: 'Answer citations' })

const detailOf = async (page: Page, disclosure: Locator): Promise<Locator> =>
  page.locator(`[id="${(await disclosure.getAttribute('aria-controls')) ?? ''}"]`)

const map = (page: Page): Locator => page.getByRole('region', { name: 'Stage map' })

const stage = (page: Page, title: string | RegExp): Locator =>
  map(page).getByRole('group', { name: typeof title === 'string' ? `Stage "${title}"` : title })

const pick = (locator: Locator, title: string | RegExp): Locator => locator.getByRole('button', { name: title, exact: true })

const admissionOf = async (daemon: RunningDaemon, vendor: Runtime) => {
  const { observer } = endpoints.status.response.parse(await (await daemon.request(endpoints.status.path)).json())
  return observer.backends.find((backend) => backend.vendor === vendor)?.admission ?? null
}

const admitted = async (daemon: RunningDaemon, vendor: Runtime): Promise<void> => {
  await expect.poll(async () => (await admissionOf(daemon, vendor))?.outcome ?? 'pending', observed).not.toBe('pending')
  expect(await admissionOf(daemon, vendor)).toMatchObject({ outcome: 'admitted', failure: null })
}

const chatInputs = (calls: readonly FakeCall[]): ChatInput[] =>
  calls.flatMap(({ purpose, prompt }) => (purpose === 'chat' && prompt !== null ? [ChatInput.parse(JSON.parse(prompt))] : []))

const snapshotOf = async (page: Page, run: RunId): Promise<RunSnapshot> => {
  const response = await getWithoutKeepAlive(page.request, endpoints.run.path.replace(':run', run))
  expect(response.status()).toBe(200)
  return endpoints.run.response.parse(await response.json())
}

const factOf = async (page: Page, id: FactId): Promise<Fact> => {
  const response = await getWithoutKeepAlive(page.request, endpoints.fact.path.replace(':id', id))
  expect(response.status()).toBe(200)
  return endpoints.fact.response.parse(await response.json()).fact
}

const stageTitled = async (page: Page, run: RunId, title: string): Promise<Stage> => {
  const found = (await snapshotOf(page, run)).model.stages.find((candidate) => candidate.title === title)
  if (found === undefined) {
    throw new Error(`the run has no stage ${title}`)
  }
  return found
}

const stageId = async (page: Page, run: RunId, title: string): Promise<StageId> =>
  (await stageTitled(page, run, title)).id

const encloses = async (outer: Locator, inner: Locator): Promise<boolean> => {
  const [frame, card] = [await outer.boundingBox(), await inner.boundingBox()]
  return (
    frame !== null &&
    card !== null &&
    card.x >= frame.x &&
    card.y >= frame.y &&
    card.x + card.width <= frame.x + frame.width &&
    card.y + card.height <= frame.y + frame.height
  )
}

const postJson = (daemon: RunningDaemon, path: string, body: unknown): Promise<Response> =>
  daemon.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const createRule = async (daemon: RunningDaemon, run: RunId, spec: ViewRuleSpec): Promise<AppliedViewRule> => {
  const response = await daemon.request(endpoints.createViewRule.path.replace(':run', run), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return endpoints.createViewRule.response.parse(await response.json()).rule
}

const revokeRule = async (daemon: RunningDaemon, run: RunId, rule: AppliedViewRule): Promise<void> => {
  const path = endpoints.revokeViewRule.path.replace(':run', run).replace(':id', rule.rule.id)
  expect((await daemon.request(path, { method: 'DELETE' })).status).toBe(200)
}

const placements = async (page: Page, run: RunId, kind: ViewElement['kind']): Promise<ViewPlacement[]> =>
  (await snapshotOf(page, run)).view.placements.filter(({ element }) => element.kind === kind)

const withReviewer = async (directory: string): Promise<string> => {
  const original = sampleScenarioManifest('claude-subagent')
  const manifest = JSON.parse(await readFile(original, 'utf8')) as { steps: Array<{ source?: string }> }
  const sources = [...new Set(manifest.steps.flatMap(({ source }) => (source === undefined ? [] : [source])))]
  const local = new Map(sources.map((source, index) => [source, `${String(index)}-${basename(source)}`]))
  await mkdir(directory, { recursive: true })
  for (const [source, name] of local) {
    const text = await readFile(join(dirname(original), ...source.split('/')), 'utf8')
    await writeFile(join(directory, name), text.replaceAll('pinger', 'code-reviewer'))
  }
  const file = join(directory, 'manifest.json')
  const steps = manifest.steps.map((step) => (step.source === undefined ? step : { ...step, source: local.get(step.source) }))
  await writeFile(file, JSON.stringify({ ...manifest, steps }))
  return file
}

const { chat: chatScenario } = observerScenarios

const answerReply = { kind: 'script', script: 'chat-answer' } as const

const collapseReply = { kind: 'script', script: 'chat-collapse-reviewers' } as const

interface ReviewerChat {
  readonly page: Page
  readonly daemon: RunningDaemon
  readonly run: RunId
  readonly session: string
  readonly approval: string
  readonly reviewing: Agent
  readonly collapsed: string
  readonly advance: () => Promise<void>
  readonly calls: () => FakeCall[]
}

const collapsedAgents = async (page: Page, run: RunId): Promise<string[]> =>
  (await placements(page, run, 'agent')).flatMap(({ element, visibility }) =>
    visibility?.state === 'collapsed' ? [element.id] : [],
  )

const collapsesTheReviewers = async ({
  page,
  daemon,
  run,
  session,
  approval,
  reviewing,
  collapsed,
  advance,
  calls,
}: ReviewerChat): Promise<void> => {
  const request = waitingFor(page).getByText(`Approval request: ${approval}`)
  await expect(request).toHaveCount(1)
  const main = stage(page, mainStageTitle)

  const overview = await ask(page, 'What is happening in the run now?')
  await expect(chat(page).getByRole('textbox', { name: 'Question' })).toHaveValue('')
  await expect(overview).toContainText('about the whole run')
  const answer = overview.getByText(/^By map version \d+:/)
  await expect(answer).toBeVisible(observed)
  const asked = Number(/^By map version (\d+):/.exec(await answer.innerText())?.[1])
  await expect(overview.getByText(new RegExp(`^as of map version ${String(asked)}`))).toBeVisible()
  const links = citations(overview)
  const toMain = links.getByRole('link', { name: `Stage "${mainStageTitle}"` })
  await expect(toMain).toBeVisible()
  const short = reviewing.id.slice(0, 8)
  const toReviewer = links.getByRole('link', { name: new RegExp(`^Stage ".+ \\(${short}\\)"$`) })
  await expect(toReviewer).toBeVisible()
  await expect(toReviewer.getByTitle(new RegExp(`^.+ \\(${reviewing.id}\\)$`))).toHaveText(new RegExp(`^".+ \\(${short}\\)"$`))
  await expect(answer).not.toContainText(reviewing.id)
  await expect(answer.getByTitle(reviewing.id, { exact: true })).toHaveText(short)
  await expect(answer).toContainText(chatAnswerReport)
  const toRequest = links.getByRole('listitem').filter({ hasText: `Approval request ${approval}` })
  await expect(toRequest).toBeVisible()
  await expect(toRequest.getByRole('link')).toHaveCount(0)
  const ground = links.getByRole('button', { name: /^Fact / }).first()
  await expect(ground).toHaveAttribute('aria-expanded', 'false')
  await ground.click()
  await expect(ground).toHaveAttribute('aria-expanded', 'true')
  await expect(await detailOf(page, ground)).toContainText(/raw record #\d+/)

  await advance()
  await expect.poll(async () => versionOf(daemon, run), observed).toBeGreaterThan(asked)
  await expect(
    overview.getByText(new RegExp(`^as of map version ${String(asked)}, the map has since been updated to version \\d+$`)),
  ).toBeVisible()

  await toMain.click()
  await expect(pick(main, mainStageTitle)).toHaveAttribute('aria-pressed', 'true')
  await expect(map(page).getByRole('heading', { name: 'Stage map' })).toBeInViewport()
  await expect(chat(page)).toContainText(`Question about stage "${mainStageTitle}".`)

  const scoped = await ask(page, 'What does this stage include?')
  await expect(scoped).toContainText(`about stage "${mainStageTitle}"`)
  await expect(scoped.getByText(/^By map version \d+:/)).toBeVisible(observed)
  const mainId = await stageId(page, run, mainStageTitle)
  expect(chatInputs(calls()).map(({ focus }) => [focus.kind, focus.kind === 'stage' ? focus.stage : null])).toEqual([
    ['run', null],
    ['stage', mainId],
  ])
  const step = citations(scoped).getByRole('button', { name: /^Action / }).first()
  await step.click()
  await expect(await detailOf(page, step)).toContainText(`Session ${session.slice(0, 8)}`)
  await chat(page).getByRole('button', { name: 'Ask about the whole run' }).click()
  await expect(pick(main, mainStageTitle)).toHaveAttribute('aria-pressed', 'false')
  await expect(chat(page)).toContainText('Question about the whole run.')

  expect(await collapsedAgents(page, run)).toEqual([])
  const collapse = await ask(page, 'Collapse the reviewers')
  await expect(collapse).toContainText('Collapsed 1 reviewer agents', observed)
  await expect(collapse).toContainText(`Filter applied: collapse ${collapsed}. Remove it with its chip over the map.`)
  await expect(chips(page)).toHaveCount(1)
  await expect(chips(page)).toContainText(`Filter: collapse ${collapsed}`)
  const [applied, ...others] = (await snapshotOf(page, run)).view.rules
  expect(others).toEqual([])
  expect(applied?.rule).toMatchObject({ action: 'collapse', source: 'chat' })
  expect(applied?.affected).toHaveLength(1)
  expect(await collapsedAgents(page, run)).toEqual([reviewing.id])
  await expect(request).toHaveCount(1)

  await chips(page).getByRole('button', { name: `Remove filter: collapse ${collapsed}` }).click()
  await expect(chips(page)).toHaveCount(0)
  await expect(collapse).toContainText('The filter from this answer was removed.')
  expect(await collapsedAgents(page, run)).toEqual([])
  await expect(request).toHaveCount(1)
  expect((await snapshotOf(page, run)).view.rules).toEqual([])
}

const opensQuietly = async (page: Page, run: RunId): Promise<void> => {
  await page.goto(`/?run=${run}`)
  await expect(chat(page)).toContainText('No questions about this run yet.')
  expect((await snapshotOf(page, run)).view.rules).toEqual([])
}

test.describe('with the Claude observer answering the chat', () => {
  test.use({
    claudeScenario: { ...chatScenario.live, chatReplies: [answerReply, answerReply, collapseReply] },
  })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'claude')
  })

  test('the chat answers with links and the map version, collapses the reviewers on request, the filter chip removes the rule, and the reviewer request stays waiting (E2E 5)', async ({
    page,
    player,
    profile,
    hook,
    fakeClaude,
    daemon,
  }) => {
    test.setTimeout(120_000)
    const played = await player(await withReviewer(join(profile.root, 'reviewer')), {
      timeScale: 0,
      recordTime: 'playback',
    })
    await played.play()
    await opensQuietly(page, claudeRun)
    const reviewerStage = /^Stage "code-reviewer \(.+\)"$/
    await expect(stage(page, reviewerStage)).toBeVisible(observed)
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('PermissionRequest.Bash.json', { ...fields, agent_id: reviewerAgent })
    await expect(waitingFor(page)).toContainText(`Approval request: ${approvalText}`)

    await collapsesTheReviewers({
      page,
      daemon,
      run: claudeRun,
      session: claudeOriginal.session,
      approval: approvalText,
      reviewing: await agentOf(page, claudeRun, 'Ping the code-reviewer agent'),
      collapsed: 'agents of type "code-reviewer"',
      advance: () => hook.claude('UserPromptSubmit.json', fields),
      calls: () => fakeClaude.calls(),
    })
  })
})

test.describe('with the Claude observer collapsing the reviewers from the chat', () => {
  test.use({ claudeScenario: { ...chatScenario.live, chatReplies: [collapseReply] } })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'claude')
  })

  const reviewerStage = /^Stage "code-reviewer \(.+\)"$/

  test('a filter asked in the chat shows as a chip over the map, a failed removal keeps the chip with the reason, removing the chip undoes the filter, and a rotated token signs out', async ({
    page,
    player,
    profile,
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(await withReviewer(join(profile.root, 'reviewer')), { timeScale: 0 })).play()
    await page.goto(`/?run=${claudeRun}`)
    const reviewer = stage(page, reviewerStage)
    await expect(reviewer).toBeVisible(observed)
    await expect(chips(page)).toHaveCount(0)

    const asked = await ask(page, 'Collapse the reviewers')
    await expect(chips(page)).toHaveCount(1, observed)
    await expect(chips(page)).toHaveText(/^Filter: collapse agents of type "code-reviewer"/)
    await expect(asked).toContainText('Filter applied: collapse agents of type "code-reviewer".')
    const reviewing = await agentOf(page, claudeRun, 'Ping the code-reviewer agent')
    expect(await collapsedAgents(page, claudeRun)).toEqual([reviewing.id])

    const removeFilter = /^Remove filter: /
    const revoke = '**/view-rules/**'
    const refuse = (route: Route): Promise<void> =>
      route.request().method() === 'DELETE' ? route.abort('connectionfailed') : route.continue()
    await page.route(revoke, refuse)
    await chips(page).first().getByRole('button', { name: removeFilter }).click()
    await expect(page.getByRole('alert')).toContainText('Filter not removed: ')
    await expect(chips(page)).toHaveCount(1)
    await expect(chips(page).first().getByRole('button', { name: removeFilter })).toBeEnabled()
    await page.unroute(revoke, refuse)

    await chips(page).first().getByRole('button', { name: removeFilter }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(chips(page)).toHaveCount(0, observed)
    await expect(asked).toContainText('The filter from this answer was removed.')
    await expect(asked).not.toContainText('Filter applied')
    expect(await collapsedAgents(page, claudeRun)).toEqual([])
    await expect(reviewer).toBeVisible()

    await ask(page, 'Collapse the reviewers')
    await expect(chips(page)).toHaveCount(1, observed)
    await page.route(revoke, (route: Route) =>
      route.request().method() === 'DELETE' ? route.fulfill({ status: 401 }) : route.continue(),
    )
    await chips(page).first().getByRole('button', { name: removeFilter }).click()
    await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible()
  })

  test('a filter rule that hides the selected stage keeps the summary and whole run clears it', async ({
    page,
    player,
    profile,
    daemon,
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1400, height: 900 })
    await (await player(await withReviewer(join(profile.root, 'reviewer')), { timeScale: 0 })).play()
    await page.goto(`/?run=${claudeRun}`)
    const reviewer = stage(page, reviewerStage)
    await expect(reviewer).toBeVisible(observed)
    const title = (await reviewer.getByRole('heading', { level: 3 }).innerText()).trim()
    const fullTitle = (await reviewer.getByRole('heading', { level: 3 }).getAttribute('title')) ?? title
    await pick(reviewer, title).click()
    const selected = page.getByRole('complementary', { name: 'Chat panel' }).getByRole('region', { name: 'Selected stage' })
    await expect(selected.getByRole('heading')).toHaveText(title)

    await createRule(daemon, claudeRun, {
      action: 'hide',
      selector: { kind: 'stage_ids', stages: [await stageId(page, claudeRun, fullTitle)] },
      params: null,
    })
    await expect(chips(page)).toHaveCount(1)
    await expect(reviewer).toHaveCount(0)
    await expect(selected.getByRole('heading')).toHaveText(title)
    await selected.getByRole('button', { name: 'Whole run' }).click()
    await expect(selected).toHaveCount(0)
  })
})

const reviewerTask = (manifest: LoadedManifest): LoadedManifest => ({
  ...manifest,
  sources: new Map(
    [...manifest.sources].map(([name, content]) => [
      name,
      Buffer.from(content.toString('utf8').replaceAll('scout', 'reviewer')),
    ]),
  ),
})

type HookPayload = Readonly<Record<string, unknown>>

const payloadsOf = ({ sources }: LoadedManifest, step: PlayerStep): HookPayload[] => {
  const content = step.kind === 'hook' ? sources.get(step.source) : undefined
  return content === undefined ? [] : [JSON.parse(content.toString('utf8')) as HookPayload]
}

const rootTurnOpen = (manifest: LoadedManifest): LoadedManifest => {
  const stop = manifest.steps.findIndex((step) =>
    payloadsOf(manifest, step).some(
      ({ hook_event_name: event, agent_id: agent }) => event === 'Stop' && agent === undefined,
    ),
  )
  expect(stop, `the root turn of ${manifest.file} ends with Stop`).toBeGreaterThan(0)
  return { ...manifest, steps: manifest.steps.slice(0, stop) }
}

const codexApproval = { command: 'touch review.txt', description: 'Write the review notes outside the sandbox' }

const reviewerRequest = (manifest: LoadedManifest): HookFields => {
  const call = manifest.steps
    .flatMap((step) => payloadsOf(manifest, step))
    .find(
      (payload) =>
        payload.hook_event_name === 'PreToolUse' &&
        JSON.stringify(payload.tool_input) === JSON.stringify({ command: 'echo reviewer' }),
    )
  if (call === undefined) {
    throw new Error(`${manifest.file} has no command of the reviewer subagent`)
  }
  return {
    ...Object.fromEntries(Object.entries(call).filter(([field]) => field !== 'tool_use_id')),
    hook_event_name: 'PermissionRequest',
    permission_mode: 'default',
    tool_input: codexApproval,
  }
}

const agentOf = async (page: Page, run: RunId, description: string): Promise<Agent> => {
  await expect
    .poll(async () => (await snapshotOf(page, run)).objects.agents.some((agent) => agent.description === description), observed)
    .toBe(true)
  const found = (await snapshotOf(page, run)).objects.agents.find((agent) => agent.description === description)
  if (found === undefined) {
    throw new Error(`the run has no agent ${description}`)
  }
  return found
}

test.describe('with the Codex observer answering the chat', () => {
  test.use({
    codexScenario: { ...chatScenario.live, chatReplies: [answerReply, answerReply, collapseReply] },
  })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'codex')
  })

  test('on the R.4 codex exec subagents recording the chat answers with links and the map version, collapses the reviewer subagent on request, the filter chip removes the rule, and the reviewer request stays waiting (E2E 5, Codex)', async ({
    page,
    player,
    hook,
    otelEndpoint,
    fakeCodex,
    daemon,
  }) => {
    test.setTimeout(120_000)
    const recording = reviewerTask(await loadManifest(codexRecording('codex_exec', 'subagents')))
    const [root = ''] = threadsOf(recording)
    const run = runId({ kind: 'session', runtime: 'codex', session: root })
    const played = await player(rootTurnOpen(recording), {
      timeScale: 1,
      recordTime: 'playback',
      otlp: await otelEndpoint(),
    })
    await played.play({ until: 'child-finished' })
    await opensQuietly(page, run)
    const reviewing = await agentOf(page, run, '/root/reviewer')
    await expect(stage(page, new RegExp(`^Stage ".+ \\(${reviewing.id.slice(0, 8)}\\)"$`))).toBeVisible(observed)
    await hook.codex('PermissionRequest.json', reviewerRequest(recording))

    await collapsesTheReviewers({
      page,
      daemon,
      run,
      session: root,
      approval: `Bash: ${codexApproval.command}`,
      reviewing,
      collapsed: `agents named "${reviewing.name ?? ''}"`,
      advance: async () => {
        await played.play()
      },
      calls: () => fakeCodex.calls(),
    })
  })
})

interface OldGround {
  readonly page: Page
  readonly daemon: RunningDaemon
  readonly run: RunId
  readonly played: Player
  readonly phases: readonly [string, string]
  readonly calls: () => FakeCall[]
  readonly gate: string
}

const answersAnOldGround = async ({ page, daemon, run, played, phases, calls, gate }: OldGround): Promise<void> => {
  const [created, updated] = phases
  await page.goto(`/?run=${run}`)
  await played.play({ until: created })
  const main = stage(page, mainStageTitle)
  await expect(main).toBeVisible(observed)
  const { evidence } = await stageTitled(page, run, mainStageTitle)
  await played.play({ until: updated })
  await expect
    .poll(async () => (await stageTitled(page, run, mainStageTitle)).evidence, observed)
    .not.toEqual(evidence)
  await pick(main, mainStageTitle).click()
  await expect(chat(page)).toContainText(`Question about stage "${mainStageTitle}".`)

  const question = await ask(page, 'How did this stage begin?')
  await expect(question.getByRole('status')).toHaveText('The observer is preparing an answer…')
  await expect.poll(() => chatInputs(calls()).length, observed).toBe(1)
  const [opening] = chatInputs(calls())
  const version = opening?.model.version ?? 0
  await played.play()
  await expect.poll(async () => versionOf(daemon, run), observed).toBeGreaterThan(version)
  await writeFile(gate, '')

  await expect(question.getByText(`${mainStageTitle} began from a ground the first input did not carry.`)).toBeVisible(
    observed,
  )
  const [, followUp] = chatInputs(calls())
  const mainId = await stageId(page, run, mainStageTitle)
  expect(chatInputs(calls()).map(({ model }) => model.version)).toEqual([version, version])
  expect(opening?.focus).toMatchObject({ kind: 'stage', stage: mainId })
  expect(followUp?.materials).toMatchObject([{ kind: 'journal', entity: { kind: 'stage', id: mainId } }])
  const history = endpoints.chatHistory.response.parse(
    await (await getWithoutKeepAlive(page.request, endpoints.chatHistory.path.replace(':run', run))).json(),
  )
  const [message] = history.messages
  expect(message).toMatchObject({ status: 'answered', version, stage: mainId, unconfirmed_citations: false })
  const cited = message?.citations.find(({ kind }) => kind === 'fact')
  const ground = cited?.kind === 'fact' ? cited.id : null
  if (ground === null) {
    throw new Error('the answer must cite the old ground')
  }
  expect(message?.citations).toEqual([
    { kind: 'stage', id: mainId },
    { kind: 'fact', id: ground },
  ])
  expect(JSON.stringify(opening)).not.toContain(ground)
  expect(JSON.stringify(followUp?.materials)).toContain(ground)

  await expect(
    question.getByText(new RegExp(`^as of map version ${String(version)}, the map has since been updated to version \\d+$`)),
  ).toBeVisible()
  const links = citations(question)
  await expect(links.getByRole('link', { name: `Stage "${mainStageTitle}"` })).toBeVisible()
  const link = links.getByRole('button', { name: /^Fact / })
  await expect(link).toHaveCount(1)
  await link.click()
  await expect(await detailOf(page, link)).toContainText(`raw record #${String((await factOf(page, ground)).seq)}`)
}

test.describe('with the Claude observer tracing an old ground', () => {
  test.use({ claudeScenario: observerScenarios['old-ground'].live })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'claude')
  })

  test('a Claude chat question about an old ground outside the first input is answered through needs with a link to it on the same map version (E2E 18)', async ({
    page,
    player,
    profile,
    fakeClaude,
    daemon,
  }) => {
    test.setTimeout(120_000)
    const gate = join(profile.root, 'chat-gate')
    fakeClaude.setScenario({
      ...observerScenarios['old-ground'].live,
      chatReplies: [{ kind: 'script', script: 'chat-old-ground', gate }],
    })
    await answersAnOldGround({
      page,
      daemon,
      run: claudeRun,
      played: await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' }),
      phases: ['subagent', 'subagent-result'],
      calls: () => fakeClaude.calls(),
      gate,
    })
  })
})

test.describe('with the Codex observer tracing an old ground', () => {
  test.use({ codexScenario: observerScenarios['old-ground'].live })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'codex')
  })

  test('a Codex chat question about an old ground outside the first input is answered through needs with a link to it on the same map version (E2E 18)', async ({
    page,
    player,
    profile,
    fakeCodex,
    daemon,
  }) => {
    test.setTimeout(120_000)
    const gate = join(profile.root, 'chat-gate')
    fakeCodex.setScenario({
      ...observerScenarios['old-ground'].live,
      chatReplies: [{ kind: 'script', script: 'chat-old-ground', gate }],
    })
    await answersAnOldGround({
      page,
      daemon,
      run: runOf(codexThread),
      played: await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0, recordTime: 'playback' }),
      phases: ['resume', 'compaction'],
      calls: () => fakeCodex.calls(),
      gate,
    })
  })
})

const chatAnswer = (fields: Record<string, unknown>): ClaudeReply => ({
  kind: 'answer',
  output: { needs: [], answer: null, citations: [], insufficient_data: false, view_rule: null, ...fields },
})

test.describe('with the Claude observer answering the chat in every state', () => {
  test.use({
    claudeScenario: {
      ...chatScenario.live,
      chatReplies: [
        chatAnswer({ insufficient_data: true }),
        chatAnswer({
          answer: 'Only the main stage is known.',
          citations: [
            { kind: 'stage', id: { $input: '/model/stages/0/id' } },
            { kind: 'fact', id: { $input: '/focus/recent_changes/0/evidence/0' } },
            { kind: 'fact', id: 'f'.repeat(32) },
          ],
          view_rule: { action: 'hide', selector: { kind: 'stage_ids', stages: ['h8-missing-stage'] }, params: null },
        }),
        { kind: 'limit' },
      ],
    },
  })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'claude')
  })

  test('the chat shows insufficient data, unconfirmed links, a refused rule, a failed call and the failures of its own requests', async ({
    page,
    player,
  }) => {
    test.setTimeout(120_000)
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })).play()
    await page.goto(`/?run=${claudeRun}`)
    await expect(stage(page, mainStageTitle)).toBeVisible(observed)

    const chatPath = `**${endpoints.chatQuestion.path.replace(':run', claudeRun)}`
    await page.route(chatPath, (route) => route.abort('connectionfailed'))
    const field = chat(page).getByRole('textbox', { name: 'Question' })
    await field.fill('Who decided this?')
    await chat(page).getByRole('button', { name: 'Ask', exact: true }).click()
    await expect(chat(page).getByRole('alert')).toHaveText('Question not sent: no connection to the daemon')
    await expect(field).toHaveValue('Who decided this?')
    await page.unroute(chatPath)
    await field.press('Control+Enter')
    const unknown = entry(page, 'Who decided this?')
    await expect(unknown).toContainText('The observer found no answer in the run data.', observed)
    await expect(unknown).toContainText('not enough data')
    await expect(chat(page).getByRole('alert')).toHaveCount(0)

    const factsPath = '**/api/facts/*'
    await page.route(factsPath, (route) => route.abort('connectionfailed'))
    const partial = await ask(page, 'What is known?')
    await expect(partial).toContainText('Only the main stage is known.', observed)
    await expect(partial).toContainText('some citations were unconfirmed and removed')
    await expect(partial).toContainText(
      'Filter not applied: invalid_selector: the run has no stages h8-missing-stage',
    )
    await expect(citations(partial).getByRole('listitem')).toHaveCount(2)
    await expect(citations(partial)).toContainText('Fact not read, retrying in a few seconds')
    await page.unroute(factsPath)
    await expect(citations(partial).getByRole('button', { name: /^Fact / })).toBeVisible({ timeout: 15_000 })

    const failed = await ask(page, 'And now?')
    await expect(failed).toContainText('No answer: limit: ', observed)
  })
})

test.describe('with the Claude observer answering while the chat history cannot be read', () => {
  test.use({ claudeScenario: { ...chatScenario.live, chatReplies: [answerReply] } })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'claude')
  })

  test('a failed read of the chat history holds back neither the run nor its stream, on opening and after a stream reset, and the history comes back once the read succeeds', async ({
    page,
    player,
    profile,
    hook,
    daemon,
  }) => {
    test.setTimeout(120_000)
    await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })).play()
    const runPath = endpoints.run.path.replace(':run', claudeRun)
    const historyPath = endpoints.chatHistory.path.replace(':run', claudeRun)
    const stagesNow = async (): Promise<number> => {
      const response = await daemon.request(runPath)
      return response.ok ? endpoints.run.response.parse(await response.json()).model.stages.length : 0
    }
    await expect.poll(stagesNow, observed).toBeGreaterThan(0)
    const earlier = 'What happened before the page was opened?'
    const question = { question: earlier, stage: null }
    expect((await postJson(daemon, endpoints.chatQuestion.path.replace(':run', claudeRun), question)).status).toBe(200)
    const firstStatus = async (): Promise<string | undefined> =>
      endpoints.chatHistory.response.parse(await (await daemon.request(historyPath)).json()).messages[0]?.status
    await expect.poll(firstStatus, observed).toBe('answered')

    let dropping = true
    const dropHistory = (route: Route): Promise<void> =>
      dropping && route.request().method() === 'GET' ? route.abort('connectionfailed') : route.continue()
    await page.route(`**${historyPath}`, dropHistory)
    await page.goto(`/?run=${claudeRun}`)
    await expect(stage(page, mainStageTitle)).toBeVisible(observed)
    const trouble = chat(page).getByRole('status').filter({ hasText: 'Chat history not loaded' })
    await expect(trouble).toHaveText('Chat history not loaded: no connection to the daemon. aang keeps retrying.')
    const before = entry(page, earlier)
    await expect(before).toHaveCount(0)
    await expect(chat(page)).not.toContainText('No questions about this run yet.')
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('PermissionRequest.Bash.json', fields)
    await expect(waitingFor(page)).toContainText(`Approval request: ${approvalText}`)

    dropping = false
    await expect(before.getByText(/^By map version \d+:/)).toBeVisible()
    await expect(trouble).toHaveCount(0)

    dropping = true
    const reread = page.waitForResponse(
      (response) => new URL(response.url()).pathname === runPath && response.request().method() === 'GET',
    )
    const pruned = await postJson(daemon, endpoints.prune.path, { scope: 'run', run: runOf(codexThread) })
    expect(pruned.status).toBe(200)
    await hook.claude('PermissionRequest.Bash.json', {
      ...fields,
      tool_input: { command: 'echo after-reset', description: 'After the reset' },
    })
    expect((await reread).status()).toBe(200)
    await expect(trouble).toHaveText('Chat history not loaded: no connection to the daemon. aang keeps retrying.')
    await expect(before).toBeVisible()
    await expect(waitingFor(page)).toContainText('Approval request: Bash: echo after-reset')
    await hook.claude('PermissionRequest.Bash.json', {
      ...fields,
      tool_input: { command: 'echo still-live', description: 'Still live' },
    })
    await expect(waitingFor(page)).toContainText('Approval request: Bash: echo still-live')
    await expect(waitingFor(page)).toContainText(`Approval request: ${approvalText}`)

    dropping = false
    await expect(trouble).toHaveCount(0)
    await expect(before.getByText(/^By map version \d+:/)).toBeVisible()
    await expect(before).toHaveCount(1)
  })
})

test.describe('with the Claude observer drawing the map for rules of the interface', () => {
  test.use({ claudeScenario: observerScenarios['map-layout'].live })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'claude')
  })

  test('view rules of the interface collapse, hide, group and set the detail of stages, agents and actions, and every active rule stays in the view', async ({
    page,
    player,
    daemon,
  }) => {
    test.setTimeout(120_000)
    const played = await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })
    await page.goto(`/?run=${claudeRun}`)
    await played.play({ until: 'subagent' })
    await expect(stage(page, preparationStageTitle)).toBeVisible(observed)
    await played.play()
    const main = stage(page, mainStageTitle)
    const pinger = stage(page, /^Stage "pinger \(.+\)"$/)
    await expect(pinger).toBeVisible(observed)
    await expect(stage(page, reportStageTitle)).toBeVisible(observed)
    const mainId = await stageId(page, claudeRun, mainStageTitle)
    const countOf = async (kind: ViewElement['kind'], matches: (placement: ViewPlacement) => boolean): Promise<number> =>
      (await placements(page, claudeRun, kind)).filter(matches).length

    const folded = await createRule(daemon, claudeRun, {
      action: 'collapse',
      selector: { kind: 'stage_ids', stages: [mainId] },
      params: null,
    })
    await expect(main).toContainText(/collapsed by a filter: .*\d+ action/)
    await expect(pinger).toHaveCount(0)
    await expect(main.getByRole('button', { name: `Collapse "${mainStageTitle}"` })).toHaveCount(0)
    expect(folded.rule.source).toBe('ui')
    expect(folded.affected).toEqual([{ kind: 'stage', id: mainId }])
    const mainDetail = await createRule(daemon, claudeRun, {
      action: 'detail',
      selector: { kind: 'stage_title', contains: 'Main' },
      params: { level: 'stages' },
    })
    await expect(chips(page).filter({ hasText: 'show stages whose title contains "Main" with detail level "stages only"' })).toHaveCount(1)
    expect(mainDetail.affected).toEqual([{ kind: 'stage', id: mainId }])
    await revokeRule(daemon, claudeRun, folded)
    await expect(pinger).toBeVisible()
    await expect(main).not.toContainText('collapsed by a filter')

    const preparation = stage(page, preparationStageTitle)
    const report = stage(page, reportStageTitle)
    const grouped = [await stageId(page, claudeRun, preparationStageTitle), await stageId(page, claudeRun, reportStageTitle)]
    const pair = await createRule(daemon, claudeRun, {
      action: 'group',
      selector: { kind: 'stage_ids', stages: grouped },
      params: { name: 'Preparation and report' },
    })
    const frame = map(page).getByRole('group', { name: 'Stage group "Preparation and report"' })
    await expect(frame).toHaveText('Group "Preparation and report" · 2 stages')
    await expect.poll(async () => (await encloses(frame, preparation)) && (await encloses(frame, report))).toBe(true)
    expect(await encloses(frame, pinger)).toBe(false)
    expect(await encloses(main, frame)).toBe(true)
    const uses = map(page).getByRole('img', { name: /^"Report" uses the output of "pinger \(.+\)", basis: / })
    await expect(uses).toHaveCount(1)
    expect(pair.affected).toHaveLength(2)
    await revokeRule(daemon, claudeRun, pair)
    await expect(frame).toHaveCount(0)
    await expect(preparation).toBeVisible()
    await expect(report).toBeVisible()

    await createRule(daemon, claudeRun, {
      action: 'hide',
      selector: { kind: 'stage_title', contains: 'pinger' },
      params: null,
    })
    await expect(pinger).toHaveCount(0)
    await expect(chips(page).filter({ hasText: 'Filter: hide stages whose title contains "pinger"' })).toHaveCount(1)

    const team = await createRule(daemon, claudeRun, {
      action: 'group',
      selector: { kind: 'agent_role', role: 'subagent' },
      params: { name: 'Helpers' },
    })
    const helpers = (placement: ViewPlacement): boolean => placement.group?.name === 'Helpers'
    expect(team.affected).toHaveLength(1)
    await expect.poll(async () => countOf('agent', helpers)).toBe(1)
    const level = await createRule(daemon, claudeRun, {
      action: 'detail',
      selector: { kind: 'agent_role', role: 'main' },
      params: { level: 'stages_and_agents' },
    })
    const agentsOnly = (placement: ViewPlacement): boolean => placement.detail?.level === 'stages_and_agents'
    expect(level.affected).toHaveLength(1)
    await expect.poll(async () => countOf('agent', agentsOnly)).toBe(1)
    expect(await countOf('agent', helpers)).toBe(1)
    await revokeRule(daemon, claudeRun, level)
    await revokeRule(daemon, claudeRun, team)
    await expect.poll(async () => countOf('agent', (placement) => helpers(placement) || agentsOnly(placement))).toBe(0)

    await createRule(daemon, claudeRun, {
      action: 'group',
      selector: { kind: 'action_tool', tool: 'Bash' },
      params: { name: 'Checks' },
    })
    await expect.poll(async () => countOf('action', ({ group }) => group?.name === 'Checks')).toBeGreaterThan(0)
    const bashDetail = await createRule(daemon, claudeRun, {
      action: 'detail',
      selector: { kind: 'action_tool', tool: 'Bash' },
      params: { level: 'stages_and_agents' },
    })
    expect(bashDetail.affected).not.toHaveLength(0)
    await expect
      .poll(async () => countOf('action', ({ detail }) => detail?.level === 'stages_and_agents'))
      .toBe(bashDetail.affected.length)
    const agentStarts = await createRule(daemon, claudeRun, {
      action: 'collapse',
      selector: { kind: 'action_kind', action_kind: 'agent' },
      params: null,
    })
    expect(agentStarts.affected).toHaveLength(1)
    await expect.poll(async () => countOf('action', ({ visibility }) => visibility?.state === 'collapsed')).toBe(1)
    const bashHidden = await createRule(daemon, claudeRun, {
      action: 'hide',
      selector: { kind: 'action_tool', tool: 'Bash' },
      params: null,
    })
    await expect
      .poll(async () => countOf('action', ({ visibility }) => visibility?.state === 'hidden'))
      .toBe(bashHidden.affected.length)
    const service = await createRule(daemon, claudeRun, {
      action: 'collapse',
      selector: { kind: 'service_agents' },
      params: null,
    })
    await createRule(daemon, claudeRun, {
      action: 'hide',
      selector: { kind: 'agent_name', name: 'nobody' },
      params: null,
    })
    expect(service.affected).toEqual([])
    expect((await snapshotOf(page, claudeRun)).view.rules).toHaveLength(8)
  })
})
