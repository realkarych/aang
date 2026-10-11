import { endpoints, ObserverInput, type RunId } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { type FakeCall, type LoadedManifest, loadManifest, observerScenarios } from '@aang/testkit'
import type { Route } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { after, codexRecording, filesOnly, startingAt, threadsOf, through } from './recordings.js'
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

const secondMs = 1_000

const hourMs = 60 * 60 * secondMs

const observed = { timeout: 30_000 }

const recovery = { timeout: 90_000 }

const calmZone = 'No open items.'

const earlyFacts = 'The map counts early facts only through a summary, with less detail.'

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
    await player(filesOnly(through(reconnect, 'daemon-restart')), {
      timeScale: 0,
      recordTime: { startsAt: Date.now() - 25 * hourMs },
    })
  ).play()

  await expect(step(page, 'Main agent', 'echo first')).toBeVisible()
  await expect(lamp(page, 'Observer')).toHaveText('Observer unavailable: subscription limit reached', observed)
  const unavailable = await lampDetails(page, 'Observer')
  await expect(unavailable).toContainText(/Next observer probe at \d{2}:\d{2}:\d{2}\s[AP]M\./)
  await expect(unavailable).toContainText('Facts and attention items keep arriving')
  await expect(unavailable).toContainText(/Catching up: the observer sees \d+ early facts? only as a summary/)
  await expect(lamp(page, 'Model')).toHaveText('Model not built')
  await expect(await lampDetails(page, 'Model')).toContainText(earlyFacts)
  const sent = observerInputs(fakeCodex.calls()).length
  fakeCodex.setScenario(recovered)

  await (
    await player(after(reconnect, 'daemon-restart'), { timeScale: 0, recordTime: 'playback', otlp: await otelEndpoint() })
  ).play()

  await expect(step(page, 'Main agent', 'sleep 3')).toBeVisible()
  await expect(sessionOf(page, session)).toContainText('resume')
  await expect(sessionOf(page, session)).toContainText('mode full')
  await expect(lamp(page, 'Observer')).toHaveText('Observer unavailable: subscription limit reached')
  const model = await lampDetails(page, 'Model')
  await expect(model).toContainText(/Waiting for the observer: \d+ fact/)
  const waited = async (): Promise<number> => Number(/oldest (\d+) s ago/.exec(await model.innerText())?.[1] ?? NaN)
  const before = await waited()
  expect(before).toBeGreaterThanOrEqual(0)
  await expect.poll(waited, observed).toBeGreaterThan(before)
  expect(observerInputs(fakeCodex.calls())).toHaveLength(sent)

  await expect(lamp(page, 'Observer')).toHaveText('Observer working', recovery)
  await expect(lamp(page, 'Model')).toHaveText(/^Model updated /)
  const caughtUp = await lampDetails(page, 'Model')
  await expect(caughtUp).toContainText(earlyFacts)
  await expect(caughtUp).not.toContainText('Waiting for the observer')
  await expect(fact(page, 'Map version')).not.toHaveText('1')
  await expect(await lampDetails(page, 'Observer')).toContainText('Catching up')

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
    await (await player(approval, played)).play({ until: 'approval-granted' })

    const request = zoneItem(page, 'Bash: touch approved.txt')
    await expect(request).toContainText('Approval request')
    await expect(request).toContainText('awaiting an answer')
    await expect(fact(page, 'Attention')).toHaveText('awaiting an answer: 1')
    await expect(sessionOf(page, asking)).toContainText('waiting for a human')
    await expect(sessionOf(page, asking)).toContainText('mode full')
    const permission = step(page, 'Main agent', 'Approval request')
    await expect(permission).toContainText('awaiting decision')

    const granted = await player(startingAt(approval, 'approval-granted'), {
      ...played,
      recordTime: { startsAt: Date.now() + secondMs },
    })
    await granted.play()
    await expect(permission).toContainText('approved')
    await expect(permission).not.toContainText('aang interpretation')
    await expect(permission).not.toContainText('awaiting decision')
    await expect(zone(page)).toContainText(calmZone)
    await expect(fact(page, 'Attention')).toHaveText('none')
    await expect(step(page, 'Main agent', 'touch approved.txt').first()).toBeVisible()

    const subagents = await loadManifest(codexRecording('codex_exec', 'subagents'))
    const root = thread(subagents)
    await (await player(subagents, played)).play()
    await page.goto(`/?run=${codexRun(root)}`)
    await expect(fact(page, 'Agents')).toHaveText('3')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      '[aang:subagent] Spawn subagents scout and builder, wait for them, then reply done.',
    )
    await expect(page.getByText('goal from the first prompt')).toBeVisible()
    await expect(page.getByRole('paragraph').filter({ hasText: /^Working towards: \[aang:subagent\]/ })).toContainText(
      'aang interpretation',
      observed,
    )
    const spawned = trace(page).getByRole('list', { name: 'Agents launched by: Main agent', exact: true })
    for (const task of ['builder', 'scout']) {
      const child = spawned.getByRole('listitem').filter({ hasText: `/root/${task}` })
      await expect(child).toContainText('subagent, type default')
      await expect(child).toContainText('done')
      await expect(child).toContainText(`echo ${task}`)
    }
    await expect(agentsOf(page, root).getByRole('listitem', { name: /./ })).toHaveCount(3)
    await expect(stepsOf(page, 'Main agent').getByRole('listitem').filter({ hasText: 'collaboration/spawn_agent' })).toHaveCount(2)
    await expect(step(page, 'Main agent', 'collaboration/wait_agent')).toBeVisible()

    const forking = await loadManifest(codexRecording('codex_exec', 'fork'))
    const source = thread(forking)
    const fork = thread(forking, 1)
    await (await player(forking, played)).play()
    await page.getByRole('navigation').getByRole('link', { name: 'Runs' }).click()
    const forkRow = runRowOf(page, codexRun(fork))
    const sourceRow = runRowOf(page, codexRun(source))
    await expect(sourceRow).toBeVisible()
    await expect(forkRow).toContainText('fork of "')
    await expect(sourceRow.getByText(/^fork(?: of ".*")?$/)).toHaveCount(0)

    await forkRow.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`\\?run=${codexRun(fork)}$`))
    await expect(sessionOf(page, fork)).toContainText(/fork [A-Z][a-z]{2} \d+, /)
    const origin = fact(page, 'Forked from').getByRole('link')
    await expect(origin).toHaveText('[aang:fork-source] Run `echo source`, then reply done.')
    const sourceTitle = await origin.innerText()
    await origin.click()
    await expect(page).toHaveURL(new RegExp(`\\?run=${codexRun(source)}$`))
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(sourceTitle)
    const forks = fact(page, 'Forks').getByRole('link')
    await expect(forks).toHaveCount(1)
    const runsRoute = `**${endpoints.runs.path}`
    const dropRuns = (route: Route): Promise<void> => route.abort('connectionfailed')
    await page.route(runsRoute, dropRuns)
    await expect(lamp(page, 'Link')).toHaveText('Link branches not updating')
    await expect(await lampDetails(page, 'Link')).toContainText(
      'branches and names of linked runs may be stale',
    )
    await expect(forks).toHaveCount(1)
    await page.unroute(runsRoute, dropRuns)
    await expect(lamp(page, 'Link')).toHaveText('Link stream connected')
    await forks.click()
    await expect(page).toHaveURL(new RegExp(`\\?run=${codexRun(fork)}$`))
  })
})
