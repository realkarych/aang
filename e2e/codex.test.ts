import { ObserverInput, type RunId } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { type FakeCall, type LoadedManifest, loadManifest, observerScenarios } from '@aang/testkit'
import { expect, test } from './fixtures.js'
import { after, codexRecording, threadsOf, through, withoutHooks } from './recordings.js'
import {
  agentsOf,
  fact,
  lamp,
  lampDetails,
  runRowOf,
  sessionOf,
  step,
  stepsOf,
  trace,
  zone,
  zoneItem,
} from './screens.js'

const hourMs = 60 * 60 * 1_000

const observed = { timeout: 30_000 }

const recovery = { timeout: 90_000 }

const calmZone = 'Открытых пунктов нет.'

const codexRun = (session: string): RunId => runId({ kind: 'session', runtime: 'codex', session })

const threads = (manifest: LoadedManifest, count: number): string[] => {
  const found = threadsOf(manifest)
  expect(found.length, `Codex threads written by ${manifest.file}`).toBeGreaterThanOrEqual(count)
  return found
}

const thread = (manifest: LoadedManifest, index = 0): string => threads(manifest, index + 1)[index] ?? ''

const observerInputs = (calls: readonly FakeCall[]): ObserverInput[] =>
  calls.flatMap(({ purpose, prompt }) => {
    if (purpose !== 'observer' || prompt === null) {
      return []
    }
    const parsed = ObserverInput.safeParse(JSON.parse(prompt))
    return parsed.success ? [parsed.data] : []
  })

test.use({ config: { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } } })

test('an LLM failure leaves the facts flowing and the model ageing in plain sight, then the observer recovers and catches up (E2E 7)', async ({
  page,
  player,
  fakeCodex,
  otelEndpoint,
}) => {
  test.setTimeout(180_000)
  const { failing, recovered } = observerScenarios['llm-failure']
  expect(failing.replies.map(({ kind }) => kind)).toEqual(['limit'])
  const reconnect = await loadManifest(codexRecording('codex_exec', 'reconnect'))
  const session = thread(reconnect)
  const resetsAt = Math.floor(Date.now() / 1_000) + 30
  fakeCodex.setScenario({ ...failing, replies: [{ kind: 'limit', resetsAt }] })

  await page.goto(`/?run=${codexRun(session)}`)
  await (
    await player(withoutHooks(through(reconnect, 'daemon-restart')), {
      timeScale: 0,
      recordTime: { startsAt: Date.now() - 25 * hourMs },
    })
  ).play()

  await expect(step(page, 'Основной агент', 'echo first')).toBeVisible()
  await expect(lamp(page, 'Наблюдатель')).toHaveText('Наблюдатель недоступен: исчерпан лимит подписки', observed)
  const unavailable = await lampDetails(page, 'Наблюдатель')
  await expect(unavailable).toContainText(/Следующая проба наблюдателя — в \d{2}:\d{2}:\d{2}\./)
  await expect(unavailable).toContainText('Факты и пункты внимания продолжают поступать')
  await expect(unavailable).toContainText(/Догоняющий режим: \d+ ранн(?:ий факт|их факта|их фактов) наблюдатель видит только сводкой/)
  await expect(lamp(page, 'Модель')).toHaveText('Модель не строилась')
  const sent = observerInputs(fakeCodex.calls()).length
  fakeCodex.setScenario(recovered)

  await (
    await player(after(reconnect, 'daemon-restart'), { timeScale: 0, recordTime: 'playback', otlp: await otelEndpoint() })
  ).play()

  await expect(step(page, 'Основной агент', 'sleep 3')).toBeVisible()
  await expect(sessionOf(page, session)).toContainText('продолжение')
  await expect(sessionOf(page, session)).toContainText('режим полный')
  await expect(lamp(page, 'Наблюдатель')).toHaveText('Наблюдатель недоступен: исчерпан лимит подписки')
  const model = await lampDetails(page, 'Модель')
  await expect(model).toContainText(/Ждут наблюдателя: \d+ факт/)
  const waited = async (): Promise<number> => Number(/старейший — (\d+) с назад/.exec(await model.innerText())?.[1] ?? NaN)
  const before = await waited()
  expect(before).toBeGreaterThanOrEqual(0)
  await expect.poll(waited, observed).toBeGreaterThan(before)
  expect(observerInputs(fakeCodex.calls())).toHaveLength(sent)

  await expect(lamp(page, 'Наблюдатель')).toHaveText('Наблюдатель работает', recovery)
  await expect(lamp(page, 'Модель')).toHaveText(/^Модель обновлена /)
  const caughtUp = await lampDetails(page, 'Модель')
  await expect(caughtUp).toContainText('Смысл ранних фактов восстановлен по сводке, с пониженной детализацией.')
  await expect(caughtUp).not.toContainText('Ждут наблюдателя')
  await expect(fact(page, 'Версия карты')).not.toHaveText('1')
  await expect(await lampDetails(page, 'Наблюдатель')).toContainText('Догоняющий режим')

  const [catchUp] = observerInputs(fakeCodex.calls())
    .slice(sent)
    .filter(({ run }) => run.id === codexRun(session))
  expect(catchUp?.batch.backlog?.facts).toBeGreaterThan(0)
  expect(catchUp?.batch.facts.length).toBeGreaterThan(0)
})

test.describe('with the Codex observer drawing the map', () => {
  test.use({ codexScenario: observerScenarios['live-map'].live })

  test('hooks raise a permission request, OTel brings the human decision, subagents join the run and a fork becomes a linked run (E2E 8)', async ({
    page,
    player,
    otelEndpoint,
  }) => {
    test.setTimeout(120_000)
    const otlp = await otelEndpoint()
    const played = { timeScale: 0, recordTime: 'playback', otlp } as const

    const approval = await loadManifest(codexRecording('codex_tui', 'approval'))
    const asking = thread(approval)
    await page.goto(`/?run=${codexRun(asking)}`)
    const approving = await player(approval, played)
    await approving.play({ until: 'approval-granted' })

    const request = zoneItem(page, 'Bash: touch approved.txt')
    await expect(request).toContainText('Запрос одобрения')
    await expect(request).toContainText('ждёт ответа')
    await expect(fact(page, 'Внимание')).toHaveText('ждут ответа: 1')
    await expect(sessionOf(page, asking)).toContainText('ждёт человека')
    await expect(sessionOf(page, asking)).toContainText('режим полный')
    const permission = step(page, 'Основной агент', 'Запрос одобрения')
    await expect(permission).toContainText('ждёт решения')

    await approving.play()
    await expect(permission).toContainText('одобрено')
    await expect(permission).not.toContainText('интерпретация aang')
    await expect(permission).not.toContainText('ждёт решения')
    await expect(zone(page)).toContainText(calmZone)
    await expect(fact(page, 'Внимание')).toHaveText('нет')
    await expect(step(page, 'Основной агент', 'touch approved.txt').first()).toBeVisible()

    const subagents = await loadManifest(codexRecording('codex_exec', 'subagents'))
    const root = thread(subagents)
    await (await player(subagents, played)).play()
    await page.goto(`/?run=${codexRun(root)}`)
    await expect(fact(page, 'Агенты')).toHaveText('3')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Working towards: \[aang:subagent\]/, observed)
    const spawned = trace(page).getByRole('list', { name: 'Агенты, запущенные: Основной агент', exact: true })
    for (const task of ['builder', 'scout']) {
      const child = spawned.getByRole('listitem').filter({ hasText: `/root/${task}` })
      await expect(child).toContainText('субагент, тип default')
      await expect(child).toContainText('завершён')
      await expect(child).toContainText(`echo ${task}`)
    }
    await expect(agentsOf(page, root).getByRole('listitem', { name: /./ })).toHaveCount(3)
    await expect(stepsOf(page, 'Основной агент').getByRole('listitem').filter({ hasText: 'collaboration/spawn_agent' })).toHaveCount(2)
    await expect(step(page, 'Основной агент', 'collaboration/wait_agent')).toBeVisible()

    const forking = await loadManifest(codexRecording('codex_exec', 'fork'))
    const source = thread(forking)
    const fork = thread(forking, 1)
    await (await player(forking, played)).play()
    await page.getByRole('navigation').getByRole('link', { name: 'Прогоны' }).click()
    const forkRow = runRowOf(page, codexRun(fork))
    const sourceRow = runRowOf(page, codexRun(source))
    await expect(sourceRow).toBeVisible()
    await expect(forkRow).toContainText('ответвление от «')
    await expect(sourceRow).not.toContainText('ответвление')

    await forkRow.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`\\?run=${codexRun(fork)}$`))
    await expect(sessionOf(page, fork)).toContainText('ответвление')
    const origin = fact(page, 'Ответвление от').getByRole('link')
    await expect(origin).toHaveText(/^Working towards: \[aang:fork-source\]/, observed)
    const sourceTitle = await origin.innerText()
    await origin.click()
    await expect(page).toHaveURL(new RegExp(`\\?run=${codexRun(source)}$`))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(sourceTitle)
    const forks = fact(page, 'Ответвления').getByRole('link')
    await expect(forks).toHaveCount(1)
    await forks.click()
    await expect(page).toHaveURL(new RegExp(`\\?run=${codexRun(fork)}$`))
  })
})
