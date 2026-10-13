import { type Action, endpoints, ObserverInput, type RunId, type RunSnapshot, type Session } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { type FakeCall, type LoadedManifest, loadManifest, observerScenarios } from '@aang/testkit'
import type { Page, Route } from '@playwright/test'
import { expect, getWithoutKeepAlive, test } from './fixtures.js'
import { after, codexRecording, filesOnly, startingAt, threadsOf, through } from './recordings.js'
import { lamp, lampDetails, runRowOf, versionOf, waitingChip, waitingFor } from './screens.js'

const secondMs = 1_000

const hourMs = 60 * 60 * secondMs

const observed = { timeout: 30_000 }

const recovery = { timeout: 90_000 }

const earlyFacts = 'The map counts early facts only through a summary, with less detail.'

const codexRun = (session: string): RunId => runId({ kind: 'session', runtime: 'codex', session })

const threads = (manifest: LoadedManifest, count: number): string[] => {
  const found = threadsOf(manifest)
  expect(found.length, `Codex threads written by ${manifest.file}`).toBeGreaterThanOrEqual(count)
  return found
}

const thread = (manifest: LoadedManifest, index = 0): string => threads(manifest, index + 1)[index] ?? ''

const snapshotOf = async (page: Page, run: RunId): Promise<RunSnapshot | null> => {
  const response = await getWithoutKeepAlive(page.request, endpoints.run.path.replace(':run', run))
  return response.ok() ? endpoints.run.response.parse(await response.json()) : null
}

const sessionOf = async (page: Page, run: RunId, session: string): Promise<Session | null> =>
  (await snapshotOf(page, run))?.objects.sessions.find(({ key }) => key.session === session) ?? null

const actionsOf = async (page: Page, run: RunId, tool: string): Promise<Action[]> =>
  (await snapshotOf(page, run))?.objects.actions.filter((action) => action.tool === tool) ?? []

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
  daemon,
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

  await expect.poll(async () => (await snapshotOf(page, codexRun(session)))?.objects.actions.length ?? 0, observed).toBeGreaterThan(0)
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

  await expect
    .poll(async () => (await sessionOf(page, codexRun(session), session))?.launches.map(({ launch }) => launch) ?? [], observed)
    .toContain('resume')
  expect((await sessionOf(page, codexRun(session), session))?.support_mode).toBe('full')
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
  expect(await versionOf(daemon, codexRun(session))).toBeGreaterThan(1)
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

    await expect(waitingChip(page)).toContainText('1')
    await expect(waitingFor(page)).toHaveText('Approval request: Bash: touch approved.txt')
    await expect
      .poll(async () => (await snapshotOf(page, codexRun(asking)))?.summary.attention.waiting_for_human ?? null)
      .toBe(1)
    const asked = await sessionOf(page, codexRun(asking), asking)
    expect(asked?.execution).toEqual({ state: 'waiting', reason: 'human' })
    expect(asked?.support_mode).toBe('full')

    const granted = await player(startingAt(approval, 'approval-granted'), {
      ...played,
      recordTime: { startsAt: Date.now() + secondMs },
    })
    await granted.play()
    await expect(waitingChip(page)).toHaveCount(0)
    await expect
      .poll(async () => (await snapshotOf(page, codexRun(asking)))?.summary.attention.waiting_for_human ?? null)
      .toBe(0)

    const subagents = await loadManifest(codexRecording('codex_exec', 'subagents'))
    const root = thread(subagents)
    await (await player(subagents, played)).play()
    await page.goto(`/?run=${codexRun(root)}`)
    const goal = '[aang:subagent] Spawn subagents scout and builder, wait for them, then reply done.'
    await expect.poll(async () => (await snapshotOf(page, codexRun(root)))?.summary.agents ?? null).toBe(3)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(goal)
    expect((await snapshotOf(page, codexRun(root)))?.summary.goal).toBe(goal)
    await expect
      .poll(async () => {
        const brief = (await snapshotOf(page, codexRun(root)))?.run.brief ?? null
        return brief === null ? null : { working: brief.text.startsWith('Working towards: [aang:subagent]'), basis: brief.basis.kind }
      }, observed)
      .toEqual({ working: true, basis: 'interpreted' })
    expect(await actionsOf(page, codexRun(root), 'collaboration/spawn_agent')).toHaveLength(2)
    expect(await actionsOf(page, codexRun(root), 'collaboration/wait_agent')).not.toHaveLength(0)

    const forking = await loadManifest(codexRecording('codex_exec', 'fork'))
    const source = thread(forking)
    const fork = thread(forking, 1)
    await (await player(forking, played)).play()
    await page.getByRole('navigation').getByRole('link', { name: '← Chats' }).click()
    const forkRow = runRowOf(page, codexRun(fork))
    const sourceRow = runRowOf(page, codexRun(source))
    await expect(sourceRow).toBeVisible()
    await expect(forkRow).toContainText('fork of "')
    await expect(sourceRow.getByText(/^fork(?: of ".*")?$/)).toHaveCount(0)

    await forkRow.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`\\?run=${codexRun(fork)}$`))
    expect((await sessionOf(page, codexRun(fork), fork))?.launches.map(({ launch }) => launch)).toContain('fork')
    expect((await snapshotOf(page, codexRun(fork)))?.summary.forked_from).toBe(codexRun(source))
    const runsRoute = `**${endpoints.runs.path}`
    const dropRuns = (route: Route): Promise<void> => route.abort('connectionfailed')
    await page.route(runsRoute, dropRuns)
    await expect(lamp(page, 'Link')).toHaveText('Link branches not updating')
    await expect(await lampDetails(page, 'Link')).toContainText(
      'branches and names of linked runs may be stale',
    )
    await page.unroute(runsRoute, dropRuns)
    await expect(lamp(page, 'Link')).toHaveText('Link stream connected')
  })
})
