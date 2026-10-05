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
  type ViewRuleSpec,
} from '@aang/contract'
import { runId } from '@aang/contract/ids'
import {
  type ClaudeReply,
  type FakeCall,
  type LoadedManifest,
  loadManifest,
  mainStageTitle,
  observerScenarios,
  type Player,
  type PlayerStep,
  type RunningDaemon,
  sampleScenarioManifest,
} from '@aang/testkit'
import type { Locator, Page } from '@playwright/test'
import { expect, type HookFields, test } from './fixtures.js'
import { codexRecording, threadsOf } from './recordings.js'
import { claudeOriginal, codexThread, hookFields, runOf } from './samples.js'
import { agentsOf, fact, stepsOf, trace, zoneItem } from './screens.js'

const observed = { timeout: 30_000 }

const claudeRun = runOf(claudeOriginal)

const reviewerAgent = 'aad616394e806288d'

const approvalText = 'Bash: touch probe-perm.txt'

test.use({ config: { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } } })

const chat = (page: Page): Locator => page.getByRole('region', { name: 'Чат', exact: true })

const rules = (page: Page): Locator => page.getByRole('region', { name: 'Правила вида', exact: true })

const activeRules = (page: Page): Locator =>
  rules(page).getByRole('list', { name: 'Активные правила' }).getByRole('listitem')

const entry = (page: Page, question: string): Locator =>
  chat(page)
    .getByRole('list', { name: 'Вопросы и ответы' })
    .getByRole('listitem')
    .filter({ has: page.getByText(question, { exact: true }) })

const ask = async (page: Page, question: string): Promise<Locator> => {
  await chat(page).getByRole('textbox', { name: 'Вопрос' }).fill(question)
  await chat(page).getByRole('button', { name: 'Спросить', exact: true }).click()
  return entry(page, question)
}

const citations = (asked: Locator): Locator => asked.getByRole('list', { name: 'Ссылки ответа' })

const detailOf = async (page: Page, disclosure: Locator): Promise<Locator> =>
  page.locator(`[id="${(await disclosure.getAttribute('aria-controls')) ?? ''}"]`)

const map = (page: Page): Locator => page.getByRole('region', { name: 'Карта этапов' })

const stage = (page: Page, title: string | RegExp): Locator =>
  map(page).getByRole('group', { name: typeof title === 'string' ? `Этап «${title}»` : title })

const pick = (locator: Locator, title: string | RegExp): Locator => locator.getByRole('button', { name: title, exact: true })

const versionNow = async (page: Page): Promise<number> => Number(await fact(page, 'Версия карты').textContent())

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
  const response = await page.request.get(endpoints.run.path.replace(':run', run))
  expect(response.status()).toBe(200)
  return endpoints.run.response.parse(await response.json())
}

const factOf = async (page: Page, id: FactId): Promise<Fact> => {
  const response = await page.request.get(endpoints.fact.path.replace(':id', id))
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
  readonly run: RunId
  readonly session: string
  readonly approval: string
  readonly reviewerStage: RegExp
  readonly reviewer: Locator
  readonly collapsed: string
  readonly untouched?: Locator
  readonly advance: () => Promise<void>
  readonly calls: () => FakeCall[]
}

const stepsInside = (agent: Locator): Locator => agent.getByRole('list', { name: /^Шаги: / })

const collapsesTheReviewers = async ({
  page,
  run,
  session,
  approval,
  reviewerStage,
  reviewer,
  collapsed,
  untouched,
  advance,
  calls,
}: ReviewerChat): Promise<void> => {
  const request = zoneItem(page, approval)
  await expect(request).toContainText('ждёт ответа')
  const main = stage(page, mainStageTitle)

  const overview = await ask(page, 'Что сейчас происходит в прогоне?')
  await expect(chat(page).getByRole('textbox', { name: 'Вопрос' })).toHaveValue('')
  await expect(overview).toContainText('по всему прогону')
  const answer = overview.getByText(/^By map version \d+:/)
  await expect(answer).toBeVisible(observed)
  const asked = Number(/^By map version (\d+):/.exec(await answer.innerText())?.[1])
  await expect(overview.getByText(new RegExp(`^по версии карты ${String(asked)}`))).toBeVisible()
  const links = citations(overview)
  const toMain = links.getByRole('link', { name: `Этап «${mainStageTitle}»` })
  await expect(toMain).toBeVisible()
  await expect(links.getByRole('link', { name: reviewerStage })).toBeVisible()
  const toRequest = links.getByRole('link', { name: `Запрос одобрения ${approval}` })
  await expect(toRequest).toBeVisible()
  const ground = links.getByRole('button', { name: /^Факт / }).first()
  await expect(ground).toHaveAttribute('aria-expanded', 'false')
  await ground.click()
  await expect(ground).toHaveAttribute('aria-expanded', 'true')
  await expect(await detailOf(page, ground)).toContainText(/сырая запись № \d+/)

  await advance()
  await expect.poll(async () => versionNow(page), observed).toBeGreaterThan(asked)
  await expect(
    overview.getByText(new RegExp(`^по версии карты ${String(asked)}, карта с тех пор обновилась до версии \\d+$`)),
  ).toBeVisible()

  await toRequest.click()
  await expect(page).toHaveURL(/#attention-/)
  await expect(request).toBeInViewport()
  await toMain.click()
  await expect(pick(main, mainStageTitle)).toHaveAttribute('aria-pressed', 'true')
  await expect(map(page).getByRole('heading', { name: 'Карта этапов' })).toBeInViewport()
  await expect(chat(page)).toContainText(`Вопрос по этапу «${mainStageTitle}».`)

  const scoped = await ask(page, 'Что входит в этот этап?')
  await expect(scoped).toContainText(`по этапу «${mainStageTitle}»`)
  await expect(scoped.getByText(/^By map version \d+:/)).toBeVisible(observed)
  const mainId = await stageId(page, run, mainStageTitle)
  expect(chatInputs(calls()).map(({ focus }) => [focus.kind, focus.kind === 'stage' ? focus.stage : null])).toEqual([
    ['run', null],
    ['stage', mainId],
  ])
  const step = citations(scoped).getByRole('button', { name: /^Действие / }).first()
  await step.click()
  await expect(await detailOf(page, step)).toContainText(`Сессия ${session.slice(0, 8)}`)
  await chat(page).getByRole('button', { name: 'Спросить по всему прогону' }).click()
  await expect(pick(main, mainStageTitle)).toHaveAttribute('aria-pressed', 'false')
  await expect(chat(page)).toContainText('Вопрос по всему прогону.')

  await expect(stepsInside(reviewer).getByRole('listitem').first()).toBeVisible()
  const collapse = await ask(page, 'Сверни ревьюеров')
  await expect(collapse).toContainText('Collapsed 1 reviewer agents', observed)
  await expect(collapse).toContainText(
    `Правило вида применено: свернуть ${collapsed}. Отменить его можно в списке правил.`,
  )
  const rule = activeRules(page)
  await expect(rule).toHaveCount(1)
  await expect(rule).toContainText(`Свернуть ${collapsed}`)
  await expect(rule).toContainText('из чата')
  await expect(rule).toContainText('затронуто: 1 элемент')
  await expect(reviewer).toContainText('свёрнут правилом вида')
  await expect(reviewer).toContainText(/1 агент · \d+ действи/)
  await expect(reviewer).toContainText('1 пункт внимания внутри — в зоне внимания')
  await expect(stepsInside(reviewer)).toHaveCount(0)
  if (untouched !== undefined) {
    await expect(untouched).not.toContainText('свёрнут правилом вида')
    await expect(stepsInside(untouched).getByRole('listitem').first()).toBeVisible()
  }
  await expect(request).toBeVisible()
  await expect(request).toContainText('ждёт ответа')

  await rules(page).getByRole('button', { name: `Отменить правило: Свернуть ${collapsed}` }).click()
  await expect(rule).toHaveCount(0)
  await expect(rules(page)).toContainText('Активных правил нет.')
  await expect(reviewer).not.toContainText('свёрнут правилом вида')
  await expect(stepsInside(reviewer).getByRole('listitem').first()).toBeVisible()
  await expect(collapse).toContainText('Правило вида из этого ответа отменено.')
  await expect(request).toBeVisible()
  expect((await snapshotOf(page, run)).view.rules).toEqual([])
}

const opensQuietly = async (page: Page, run: RunId): Promise<void> => {
  await page.goto(`/?run=${run}`)
  await expect(chat(page)).toContainText('Вопросов по этому прогону ещё не было.')
  await expect(rules(page)).toContainText('Активных правил нет.')
}

test.describe('with the Claude observer answering the chat', () => {
  test.use({
    claudeScenario: { ...chatScenario.live, chatReplies: [answerReply, answerReply, collapseReply] },
  })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'claude')
  })

  test('the chat answers with links and the map version, collapses the reviewers on request, the rule is revoked from the list, and the reviewer request stays in the attention zone (E2E 5)', async ({
    page,
    player,
    profile,
    hook,
    fakeClaude,
  }) => {
    test.setTimeout(120_000)
    const played = await player(await withReviewer(join(profile.root, 'reviewer')), {
      timeScale: 0,
      recordTime: 'playback',
    })
    await played.play()
    await opensQuietly(page, claudeRun)
    const reviewerStage = /^Этап «code-reviewer \(.+\)»$/
    await expect(stage(page, reviewerStage)).toBeVisible(observed)
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('PermissionRequest.Bash.json', { ...fields, agent_id: reviewerAgent })
    await expect(zoneItem(page, approvalText)).toContainText('code-reviewer')

    await collapsesTheReviewers({
      page,
      run: claudeRun,
      session: claudeOriginal.session,
      approval: approvalText,
      reviewerStage,
      reviewer: agentsOf(page, claudeOriginal.session).getByRole('listitem', { name: 'code-reviewer', exact: true }),
      collapsed: 'агентов типа «code-reviewer»',
      advance: () => hook.claude('UserPromptSubmit.json', fields),
      calls: () => fakeClaude.calls(),
    })
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

  test('on the R.4 codex exec subagents recording the chat answers with links and the map version, collapses the reviewer subagent on request, the rule is revoked from the list, and the reviewer request stays in the attention zone (E2E 5, Codex)', async ({
    page,
    player,
    hook,
    otelEndpoint,
    fakeCodex,
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
    const reviewerStage = new RegExp(`^Этап «.+ \\(${reviewing.id}\\)»$`)
    await expect(stage(page, reviewerStage)).toBeVisible(observed)
    await hook.codex('PermissionRequest.json', reviewerRequest(recording))
    const spawned = trace(page).getByRole('list', { name: 'Агенты, запущенные: Основной агент', exact: true })
    const subagent = (path: string): Locator =>
      spawned.getByRole('listitem').filter({ has: page.getByText(path, { exact: true }) })

    await collapsesTheReviewers({
      page,
      run,
      session: root,
      approval: `Bash: ${codexApproval.command}`,
      reviewerStage,
      reviewer: subagent('/root/reviewer'),
      collapsed: `агентов с именем «${reviewing.name ?? ''}»`,
      untouched: subagent('/root/builder'),
      advance: async () => {
        await played.play()
      },
      calls: () => fakeCodex.calls(),
    })
  })
})

interface OldGround {
  readonly page: Page
  readonly run: RunId
  readonly played: Player
  readonly phases: readonly [string, string]
  readonly calls: () => FakeCall[]
  readonly gate: string
}

const answersAnOldGround = async ({ page, run, played, phases, calls, gate }: OldGround): Promise<void> => {
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
  await expect(chat(page)).toContainText(`Вопрос по этапу «${mainStageTitle}».`)

  const question = await ask(page, 'С чего начался этот этап?')
  await expect(question.getByRole('status')).toHaveText('Наблюдатель готовит ответ…')
  await expect.poll(() => chatInputs(calls()).length, observed).toBe(1)
  const [opening] = chatInputs(calls())
  const version = opening?.model.version ?? 0
  await played.play()
  await expect.poll(async () => versionNow(page), observed).toBeGreaterThan(version)
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
    await (await page.request.get(endpoints.chatHistory.path.replace(':run', run))).json(),
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
    question.getByText(new RegExp(`^по версии карты ${String(version)}, карта с тех пор обновилась до версии \\d+$`)),
  ).toBeVisible()
  const links = citations(question)
  await expect(links.getByRole('link', { name: `Этап «${mainStageTitle}»` })).toBeVisible()
  const link = links.getByRole('button', { name: /^Факт / })
  await expect(link).toHaveCount(1)
  await link.click()
  await expect(await detailOf(page, link)).toContainText(`сырая запись № ${String((await factOf(page, ground)).seq)}`)
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
  }) => {
    test.setTimeout(120_000)
    const gate = join(profile.root, 'chat-gate')
    fakeClaude.setScenario({
      ...observerScenarios['old-ground'].live,
      chatReplies: [{ kind: 'script', script: 'chat-old-ground', gate }],
    })
    await answersAnOldGround({
      page,
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
  }) => {
    test.setTimeout(120_000)
    const gate = join(profile.root, 'chat-gate')
    fakeCodex.setScenario({
      ...observerScenarios['old-ground'].live,
      chatReplies: [{ kind: 'script', script: 'chat-old-ground', gate }],
    })
    await answersAnOldGround({
      page,
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
    daemon,
  }) => {
    test.setTimeout(120_000)
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })).play()
    await page.goto(`/?run=${claudeRun}`)
    await expect(stage(page, mainStageTitle)).toBeVisible(observed)

    const chatPath = `**${endpoints.chatQuestion.path.replace(':run', claudeRun)}`
    await page.route(chatPath, (route) => route.abort('connectionfailed'))
    const field = chat(page).getByRole('textbox', { name: 'Вопрос' })
    await field.fill('Кто это решил?')
    await chat(page).getByRole('button', { name: 'Спросить', exact: true }).click()
    await expect(chat(page).getByRole('alert')).toHaveText('Вопрос не отправлен: нет связи с демоном')
    await expect(field).toHaveValue('Кто это решил?')
    await page.unroute(chatPath)
    await field.press('Control+Enter')
    const unknown = entry(page, 'Кто это решил?')
    await expect(unknown).toContainText('Наблюдатель не нашёл ответа в данных прогона.', observed)
    await expect(unknown).toContainText('недостаточно данных')
    await expect(chat(page).getByRole('alert')).toHaveCount(0)

    const factsPath = '**/api/facts/*'
    await page.route(factsPath, (route) => route.abort('connectionfailed'))
    const partial = await ask(page, 'Что известно?')
    await expect(partial).toContainText('Only the main stage is known.', observed)
    await expect(partial).toContainText('часть ссылок не подтверждена и убрана')
    await expect(partial).toContainText(
      'Правило вида не применено: invalid_selector: the run has no stages h8-missing-stage',
    )
    await expect(citations(partial).getByRole('listitem')).toHaveCount(2)
    await expect(citations(partial)).toContainText('Факт не прочитан, повтор через несколько секунд')
    await page.unroute(factsPath)
    await expect(citations(partial).getByRole('button', { name: /^Факт / })).toBeVisible({ timeout: 15_000 })

    const failed = await ask(page, 'А теперь?')
    await expect(failed).toContainText('Ответа нет: limit: ', observed)

    const pinger = await createRule(daemon, claudeRun, {
      action: 'collapse',
      selector: { kind: 'agent_type', agent_type: 'pinger' },
      params: null,
    })
    await expect(activeRules(page)).toHaveCount(1)
    const rulesPath = `**${endpoints.revokeViewRule.path.replace(':run', claudeRun).replace(':id', pinger.rule.id)}`
    await page.route(rulesPath, (route) => route.abort('connectionfailed'))
    const revoke = rules(page).getByRole('button', { name: 'Отменить правило: Свернуть агентов типа «pinger»' })
    await revoke.click()
    await expect(rules(page).getByRole('alert')).toHaveText('Правило не отменено: нет связи с демоном')
    await expect(revoke).toBeEnabled()
    await page.unroute(rulesPath)
    await revoke.click()
    await expect(activeRules(page)).toHaveCount(0)
    await expect(rules(page).getByRole('alert')).toHaveCount(0)
  })
})

test.describe('with the Claude observer drawing the map for rules of the interface', () => {
  test.use({ claudeScenario: observerScenarios['live-map'].live })
  test.beforeEach(async ({ daemon }) => {
    await admitted(daemon, 'claude')
  })

  test('view rules of the interface collapse, hide, group and set the detail of stages, agents and actions, and every active rule is listed', async ({
    page,
    player,
    daemon,
  }) => {
    test.setTimeout(120_000)
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0, recordTime: 'playback' })).play()
    await page.goto(`/?run=${claudeRun}`)
    const main = stage(page, mainStageTitle)
    const pinger = stage(page, /^Этап «pinger \(.+\)»$/)
    await expect(pinger).toBeVisible(observed)
    const mainId = await stageId(page, claudeRun, mainStageTitle)
    const rule = (text: string): Locator => activeRules(page).filter({ hasText: text })

    const folded = await createRule(daemon, claudeRun, {
      action: 'collapse',
      selector: { kind: 'stage_ids', stages: [mainId] },
      params: null,
    })
    await expect(main).toContainText(/свёрнут правилом вида: .*\d+ действи/)
    await expect(pinger).toHaveCount(0)
    await expect(main.getByRole('button', { name: `Свернуть «${mainStageTitle}»` })).toHaveCount(0)
    await expect(rule(`Свернуть этап «${mainStageTitle}»`)).toContainText('из интерфейса')
    await expect(rule(`Свернуть этап «${mainStageTitle}»`)).toContainText('затронуто: 1 элемент')
    await createRule(daemon, claudeRun, {
      action: 'detail',
      selector: { kind: 'stage_title', contains: 'Main' },
      params: { level: 'stages' },
    })
    await expect(main).toContainText('детализация: только этапы')
    await expect(rule('Показать этапы, в названии которых есть «Main» с детализацией «только этапы»')).toHaveCount(1)
    await revokeRule(daemon, claudeRun, folded)
    await expect(pinger).toBeVisible()
    await expect(main).not.toContainText('свёрнут правилом вида')
    await expect(pinger).not.toContainText('агент: pinger')

    await createRule(daemon, claudeRun, {
      action: 'hide',
      selector: { kind: 'stage_title', contains: 'pinger' },
      params: null,
    })
    await expect(pinger).toHaveCount(0)
    await expect(map(page)).toContainText('скрыто правилами вида: 1 этап')

    const team = await createRule(daemon, claudeRun, {
      action: 'group',
      selector: { kind: 'agent_role', role: 'subagent' },
      params: { name: 'Помощники' },
    })
    const helpers = trace(page).getByRole('list', { name: 'Агенты группы «Помощники»' })
    await expect(helpers.getByRole('listitem', { name: 'pinger', exact: true })).toBeVisible()
    await expect(trace(page)).toContainText('Группа «Помощники» · 1 агент')
    await expect(rule('Сгруппировать агентов с ролью «subagent» под «Помощники»')).toHaveCount(1)
    const level = await createRule(daemon, claudeRun, {
      action: 'detail',
      selector: { kind: 'agent_role', role: 'main' },
      params: { level: 'stages_and_agents' },
    })
    const root = agentsOf(page, claudeOriginal.session).getByRole('listitem', { name: 'Основной агент', exact: true })
    await expect(root).toContainText('детализация: этапы и агенты')
    await expect(stepsOf(page, 'Основной агент')).toHaveCount(0)
    await expect(stepsOf(page, 'pinger')).toHaveCount(0)
    await expect(helpers.getByRole('listitem', { name: 'pinger', exact: true })).toBeVisible()
    await revokeRule(daemon, claudeRun, level)
    await revokeRule(daemon, claudeRun, team)
    await expect(stepsOf(page, 'Основной агент')).toBeVisible()

    await createRule(daemon, claudeRun, {
      action: 'group',
      selector: { kind: 'action_tool', tool: 'Bash' },
      params: { name: 'Проверки' },
    })
    const checks = trace(page).getByRole('list', { name: 'Шаги группы «Проверки»' }).first()
    await expect(checks).toContainText('echo hi')
    await expect(trace(page)).toContainText(/Группа «Проверки» · \d+ шаг/)
    await createRule(daemon, claudeRun, {
      action: 'collapse',
      selector: { kind: 'action_kind', action_kind: 'agent' },
      params: null,
    })
    await expect(stepsOf(page, 'Основной агент').getByRole('listitem').filter({ hasText: 'Agent' })).toContainText(
      'свёрнуто правилом вида',
    )
    await expect(rule('Свернуть действия вида «запуск агента»')).toHaveCount(1)
    await createRule(daemon, claudeRun, {
      action: 'hide',
      selector: { kind: 'action_tool', tool: 'Bash' },
      params: null,
    })
    await expect(trace(page).getByRole('list', { name: 'Шаги группы «Проверки»' })).toHaveCount(0)
    await expect(trace(page)).toContainText(/Скрыто правилами вида: \d+ действи.*\. Их вопросы остаются в зоне внимания\./)
    await createRule(daemon, claudeRun, { action: 'collapse', selector: { kind: 'service_agents' }, params: null })
    await createRule(daemon, claudeRun, {
      action: 'hide',
      selector: { kind: 'agent_name', name: 'nobody' },
      params: null,
    })
    await expect(rule('Свернуть служебных агентов')).toContainText('затронуто: 0 элементов')
    await expect(rule('Скрыть агентов с именем «nobody»')).toHaveCount(1)
    await expect(activeRules(page)).toHaveCount(7)
  })
})
