import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
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
import {
  type ClaudeReply,
  type FakeCall,
  mainStageTitle,
  observerScenarios,
  type Player,
  preparationStageTitle,
  reportStageTitle,
  type RunningDaemon,
  sampleScenarioManifest,
} from '@aang/testkit'
import type { Locator, Page, Route } from '@playwright/test'
import { expect, test } from './fixtures.js'
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

const answerReply: ClaudeReply = { kind: 'script', script: 'chat-answer' }

const collapseReply: ClaudeReply = { kind: 'script', script: 'chat-collapse-reviewers' }

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
    await page.goto(`/?run=${claudeRun}`)
    await expect(chat(page)).toContainText('Вопросов по этому прогону ещё не было.')
    await expect(rules(page)).toContainText('Активных правил нет.')
    const main = stage(page, mainStageTitle)
    await expect(stage(page, /^Этап «code-reviewer \(.+\)»$/)).toBeVisible(observed)
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('PermissionRequest.Bash.json', { ...fields, agent_id: reviewerAgent })
    const request = zoneItem(page, approvalText)
    await expect(request).toContainText('code-reviewer')

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
    await expect(links.getByRole('link', { name: /^Этап «code-reviewer \(.+\)»$/ })).toBeVisible()
    const toRequest = links.getByRole('link', { name: `Запрос одобрения ${approvalText}` })
    await expect(toRequest).toBeVisible()
    const ground = links.getByRole('button', { name: /^Факт / }).first()
    await expect(ground).toHaveAttribute('aria-expanded', 'false')
    await ground.click()
    await expect(ground).toHaveAttribute('aria-expanded', 'true')
    await expect(await detailOf(page, ground)).toContainText(/сырая запись № \d+/)

    await hook.claude('UserPromptSubmit.json', fields)
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
    const mainId = await stageId(page, claudeRun, mainStageTitle)
    expect(chatInputs(fakeClaude.calls()).map(({ focus }) => [focus.kind, focus.kind === 'stage' ? focus.stage : null])).toEqual([
      ['run', null],
      ['stage', mainId],
    ])
    const step = citations(scoped).getByRole('button', { name: /^Действие / }).first()
    await step.click()
    await expect(await detailOf(page, step)).toContainText('Сессия 86f93ed5')
    await chat(page).getByRole('button', { name: 'Спросить по всему прогону' }).click()
    await expect(pick(main, mainStageTitle)).toHaveAttribute('aria-pressed', 'false')
    await expect(chat(page)).toContainText('Вопрос по всему прогону.')

    const reviewer = agentsOf(page, claudeOriginal.session).getByRole('listitem', { name: 'code-reviewer', exact: true })
    await expect(stepsOf(page, 'code-reviewer').getByRole('listitem').first()).toBeVisible()
    const collapse = await ask(page, 'Сверни ревьюеров')
    await expect(collapse).toContainText('Collapsed 1 reviewer agents', observed)
    await expect(collapse).toContainText(
      'Правило вида применено: свернуть агентов типа «code-reviewer». Отменить его можно в списке правил.',
    )
    const rule = activeRules(page)
    await expect(rule).toHaveCount(1)
    await expect(rule).toContainText('Свернуть агентов типа «code-reviewer»')
    await expect(rule).toContainText('из чата')
    await expect(rule).toContainText('затронуто: 1 элемент')
    await expect(reviewer).toContainText('свёрнут правилом вида')
    await expect(reviewer).toContainText(/1 агент · \d+ действи/)
    await expect(reviewer).toContainText('1 пункт внимания внутри — в зоне внимания')
    await expect(stepsOf(page, 'code-reviewer')).toHaveCount(0)
    await expect(request).toBeVisible()
    await expect(request).toContainText('ждёт ответа')

    await rules(page).getByRole('button', { name: 'Отменить правило: Свернуть агентов типа «code-reviewer»' }).click()
    await expect(rule).toHaveCount(0)
    await expect(rules(page)).toContainText('Активных правил нет.')
    await expect(reviewer).not.toContainText('свёрнут правилом вида')
    await expect(stepsOf(page, 'code-reviewer').getByRole('listitem').first()).toBeVisible()
    await expect(collapse).toContainText('Правило вида из этого ответа отменено.')
    await expect(request).toBeVisible()
    expect((await snapshotOf(page, claudeRun)).view.rules).toEqual([])
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
    const earlier = 'Что было до открытия страницы?'
    const question = { question: earlier, stage: null }
    expect((await postJson(daemon, endpoints.chatQuestion.path.replace(':run', claudeRun), question)).status).toBe(200)
    const firstStatus = async (): Promise<string | undefined> =>
      endpoints.chatHistory.response.parse(await (await daemon.request(historyPath)).json()).messages[0]?.status
    await expect.poll(firstStatus, observed).toBe('answered')

    const dropHistory = (route: Route): Promise<void> =>
      route.request().method() === 'GET' ? route.abort('connectionfailed') : route.continue()
    await page.route(`**${historyPath}`, dropHistory)
    await page.goto(`/?run=${claudeRun}`)
    await expect(stage(page, mainStageTitle)).toBeVisible(observed)
    await expect(fact(page, 'Сессии')).toHaveText('1')
    const trouble = chat(page).getByRole('status').filter({ hasText: 'История чата не загружена' })
    await expect(trouble).toHaveText('История чата не загружена: нет связи с демоном. aang повторяет запрос.')
    const before = entry(page, earlier)
    await expect(before).toHaveCount(0)
    await expect(chat(page)).not.toContainText('Вопросов по этому прогону ещё не было.')
    const fields = hookFields(profile, claudeOriginal)
    await hook.claude('PermissionRequest.Bash.json', fields)
    await expect(zoneItem(page, approvalText)).toContainText('ждёт ответа')

    await page.unroute(`**${historyPath}`, dropHistory)
    await expect(before.getByText(/^By map version \d+:/)).toBeVisible()
    await expect(trouble).toHaveCount(0)

    await page.route(`**${historyPath}`, dropHistory)
    const reread = page.waitForResponse(
      (response) => new URL(response.url()).pathname === runPath && response.request().method() === 'GET',
    )
    const pruned = await postJson(daemon, endpoints.prune.path, { scope: 'run', run: runOf(codexThread) })
    expect(pruned.status).toBe(200)
    await hook.claude('PreToolUse.Bash.json', {
      ...fields,
      tool_use_id: 'toolu_h8_after_reset',
      tool_input: { command: 'echo after-reset', description: 'After the reset' },
    })
    expect((await reread).status()).toBe(200)
    await expect(trouble).toHaveText('История чата не загружена: нет связи с демоном. aang повторяет запрос.')
    await expect(before).toBeVisible()
    await expect(trace(page)).toContainText('echo after-reset')
    await hook.claude('PreToolUse.Bash.json', {
      ...fields,
      tool_use_id: 'toolu_h8_still_live',
      tool_input: { command: 'echo still-live', description: 'Still live' },
    })
    await expect(trace(page)).toContainText('echo still-live')
    await expect(zoneItem(page, approvalText)).toContainText('ждёт ответа')

    await page.unroute(`**${historyPath}`, dropHistory)
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

  test('view rules of the interface collapse, hide, group and set the detail of stages, agents and actions, and every active rule is listed', async ({
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
    const pinger = stage(page, /^Этап «pinger \(.+\)»$/)
    await expect(pinger).toBeVisible(observed)
    await expect(stage(page, reportStageTitle)).toBeVisible(observed)
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

    const preparation = stage(page, preparationStageTitle)
    const report = stage(page, reportStageTitle)
    const grouped = [await stageId(page, claudeRun, preparationStageTitle), await stageId(page, claudeRun, reportStageTitle)]
    const pair = await createRule(daemon, claudeRun, {
      action: 'group',
      selector: { kind: 'stage_ids', stages: grouped },
      params: { name: 'Подготовка и отчёт' },
    })
    const frame = map(page).getByRole('group', { name: 'Группа этапов «Подготовка и отчёт»' })
    await expect(frame).toHaveText('Группа «Подготовка и отчёт» · 2 этапа')
    await expect.poll(async () => (await encloses(frame, preparation)) && (await encloses(frame, report))).toBe(true)
    expect(await encloses(frame, pinger)).toBe(false)
    expect(await encloses(main, frame)).toBe(true)
    const uses = map(page).getByRole('img', { name: /^«Report» использует результат «pinger \(.+\)», основание: / })
    await expect(uses).toHaveCount(1)
    await expect(rule('Сгруппировать этапы «Preparation», «Report» под «Подготовка и отчёт»')).toContainText(
      'затронуто: 2 элемента',
    )
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
      action: 'detail',
      selector: { kind: 'action_tool', tool: 'Bash' },
      params: { level: 'stages_and_agents' },
    })
    await expect(checks.getByRole('listitem').first()).toContainText('детализация: этапы и агенты')
    await expect(rule('Показать действия инструмента «Bash» с детализацией «этапы и агенты»')).toHaveCount(1)
    await createRule(daemon, claudeRun, {
      action: 'collapse',
      selector: { kind: 'action_kind', action_kind: 'agent' },
      params: null,
    })
    await expect(stepsOf(page, 'Основной агент').getByRole('listitem').filter({ hasText: 'Agent' })).toContainText(
      /свёрнуто правилом вида: 1 действие · (успешно|ошибка|отказ|прервано|исход неизвестен): 1/,
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
    await expect(activeRules(page)).toHaveCount(8)
  })
})
