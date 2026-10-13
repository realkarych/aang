import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endpoints, type RunId, type RunSummary, type StatusResponse } from '@aang/contract'
import { aangHomePaths } from '@aang/contract/home'
import { observerScenarios, sampleScenarioManifest } from '@aang/testkit'
import type { Route } from '@playwright/test'
import { aangEntry, expect, test } from './fixtures.js'
import { claudeGoal, claudeOriginal, codexGoal, codexThread, hookFields, runOf, sessionFile } from './samples.js'
import { healthDot, healthLacks, healthProblems, runRowOf, waitingChip, waitingFor } from './screens.js'

const claudeSession = claudeOriginal.session
const claudeRun = runOf(claudeOriginal)
const codexRun = runOf(codexThread)
const claudeProject = 'projects/-tmp-aang-spike-cc-transcripts-run'

const watchAll = { watch: { all: true } }

const observed = { timeout: 30_000 }

const approvalText = 'Bash: touch probe-perm.txt'

test.use({ config: watchAll })

const readRunSummary = async (request: (path: string) => Promise<Response>, run: RunId): Promise<RunSummary | null> => {
  const response = await request(endpoints.run.path.replace(':run', run))
  return response.ok ? endpoints.run.response.parse(await response.json()).summary : null
}

const execution = async (request: (path: string) => Promise<Response>, run: RunId): Promise<string | null> => {
  const summary = await readRunSummary(request, run)
  return summary === null ? null : summary.execution.state === 'waiting' ? `waiting:${summary.execution.reason}` : summary.execution.state
}

test('a Claude session without hook events shows inactive hooks and the files-only mode until hooks arrive (E2E 9)', async ({
  page,
  player,
  profile,
  hook,
  daemon,
}) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto('/')

  const row = runRowOf(page, claudeRun)
  await expect(row.getByRole('link')).toContainText(claudeGoal)
  await expect(await healthProblems(page)).toContainText('Hooks: inactive in 1 session')
  await expect(await healthProblems(page)).toContainText('Claude Code: hooks inactive in 1 session, "files only" mode.')
  await healthLacks(page, 'Versions:')

  await row.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?run=${claudeRun}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(claudeGoal)
  expect((await readRunSummary(daemon.request, claudeRun))?.freshness).toBe('hooks_inactive')
  expect((await readRunSummary(daemon.request, claudeRun))?.support_modes).toEqual(['files_only'])
  await expect(await healthProblems(page)).toContainText('Mode: files only')
  await expect(await healthProblems(page)).toContainText(
    'Session 86f93ed5: files only: hooks inactive, events come from session files.',
  )

  expect((await readRunSummary(daemon.request, claudeRun))?.attention.open).toBe(0)

  await hook.claude('PermissionRequest.Bash.json', hookFields(profile, claudeOriginal))

  await expect(waitingFor(page)).toContainText(`Approval request: ${approvalText}`)
  await healthLacks(page, 'Mode:')
  await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.support_modes).toEqual(['full'])
  await expect
    .poll(async () => (await readRunSummary(daemon.request, claudeRun))?.attention.waiting_for_human)
    .toBe(1)
  await healthLacks(page, 'Hooks: inactive in')

  await page.getByRole('navigation').getByRole('link', { name: '← Chats' }).click()
  await expect(runRowOf(page, claudeRun)).toContainText('Waiting for you: 1')
})

test('a chat row shows the goal, the project folder, the state and the time, newest first', async ({ page, player, daemon }) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  const run = runOf(claudeOriginal)
  await expect.poll(async () => (await readRunSummary(daemon.request, run))?.cwd ?? null).toBeTruthy()
  const summary = await readRunSummary(daemon.request, run)
  const folder = (summary?.cwd ?? '').split(/[\\/]/).filter(Boolean).slice(-2).join('/')

  await page.goto('/')
  const row = runRowOf(page, run)
  await expect(row).toContainText(claudeGoal)
  await expect(row).toContainText(folder)
  await expect(row.getByTitle(summary?.cwd ?? '')).toBeVisible()
  await expect(row.locator('time')).toHaveText(/^(?:just now|\d+ (?:second|minute|hour)s? ago|[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}\s[AP]M)$/)
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(row).not.toContainText('Waiting for you')

  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
  await expect(runRowOf(page, codexRun)).toBeVisible()
  const listed = endpoints.runs.response.parse(await (await daemon.request(endpoints.runs.path)).json()).runs
  const newestFirst = [...listed]
    .sort((left, right) => (left.last_event_at === right.last_event_at ? 0 : left.last_event_at > right.last_event_at ? -1 : 1))
    .map(({ id }) => `?run=${id}`)
  expect(new Set(listed.map(({ last_event_at: at }) => at)).size).toBe(listed.length)
  await expect
    .poll(() =>
      page
        .getByRole('list', { name: 'Chats' })
        .getByRole('listitem')
        .getByRole('link')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
    )
    .toEqual(newestFirst)
})

test('a Codex session without hook events shows inactive hooks and the files-only mode (E2E 9)', async ({
  page,
  player,
  daemon,
}) => {
  await page.goto(`/?run=${codexRun}`)
  await expect(page.getByRole('heading', { name: 'Run not found' })).toBeVisible()
  await expect(await healthProblems(page)).toContainText('Link: run not found')

  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(codexGoal)
  expect((await readRunSummary(daemon.request, codexRun))?.freshness).toBe('hooks_inactive')
  await expect(await healthProblems(page)).toContainText('Mode: files only')
  await expect(await healthProblems(page)).toContainText('Hooks: inactive in 1 session')
  await healthLacks(page, 'Link:')

  await page.getByRole('link', { name: 'aang' }).click()
  await expect(runRowOf(page, codexRun)).toContainText(codexGoal)
})

test.describe('a session that loses its hooks mid-session', () => {
  test.use({ config: { ...watchAll, freshness: { hooksInactiveAfterMs: 1_000 } } })

  test('shows inactive hooks and the files-only mode from a turn without hook events until the next hook event', async ({
    page,
    player,
    profile,
    hook,
    daemon,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await hook.claude('UserPromptSubmit.json', { ...hookFields(profile, claudeOriginal), prompt_id: 'hooked-turn' })
    await page.goto(`/?run=${claudeRun}`)
    await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.support_modes).toEqual(['full'])
    expect((await readRunSummary(daemon.request, claudeRun))?.freshness).not.toBe('hooks_inactive')
    await healthLacks(page, 'Hooks: inactive in')

    const prompt = {
      type: 'user',
      sessionId: claudeSession,
      cwd: claudeOriginal.cwd,
      uuid: 'turn-without-hooks',
      promptId: 'turn-without-hooks',
      timestamp: new Date().toISOString(),
      promptSource: 'typed',
      message: { role: 'user', content: 'A turn without hook events' },
    }
    await appendFile(sessionFile(profile, claudeOriginal), `${JSON.stringify(prompt)}\n`)

    await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.freshness).toBe('hooks_inactive')
    expect((await readRunSummary(daemon.request, claudeRun))?.support_modes).toEqual(['files_only'])
    await expect(await healthProblems(page)).toContainText('Hooks: inactive in 1 session')
    await expect(await healthProblems(page)).toContainText('Mode: files only')
    await expect(await healthProblems(page)).toContainText(
      'Session 86f93ed5: files only: hooks inactive, events come from session files.',
    )

    await hook.claude('Stop.json', hookFields(profile, claudeOriginal))

    await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.support_modes).toEqual(['full'])
    expect((await readRunSummary(daemon.request, claudeRun))?.freshness).not.toBe('hooks_inactive')
    await healthLacks(page, 'Hooks: inactive in')
    await healthLacks(page, 'Mode:')
  })
})

test('the run page follows the stream live and re-reads the run when the stream resets on a replaced database', async ({
  page,
  context,
  player,
  profile,
  hook,
  daemon,
}) => {
  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
  const claude = await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })
  await claude.play({ until: 'subagent' })
  const transcript = sessionFile(profile, claudeOriginal)
  const beforeSubagent = await readFile(transcript)
  await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.agents).toBe(1)

  await page.goto(`/?run=${claudeRun}`)
  expect(await execution(daemon.request, claudeRun)).toBe('running')
  await healthLacks(page, 'Link:')
  await expect(waitingChip(page)).toHaveCount(0)

  await claude.play()
  await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.agents).toBe(2)
  await expect.poll(async () => execution(daemon.request, claudeRun)).toBe('waiting:idle')
  const fields = hookFields(profile, claudeOriginal)
  await hook.claude('PermissionRequest.Bash.json', fields)
  await expect(waitingFor(page)).toContainText(`Approval request: ${approvalText}`)
  const complete = await readFile(transcript)

  await context.setOffline(true)
  expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
  await expect(await healthProblems(page)).toContainText('Link: no connection to the daemon')
  await expect(await healthProblems(page)).toContainText('The daemon is not responding.')

  for (const file of ['aang.db', 'aang.db-wal', 'aang.db-shm']) {
    await rm(join(profile.aangHome, file), { force: true })
  }
  await rm(join(profile.codex, 'sessions'), { recursive: true, force: true })
  await rm(join(profile.claude, ...claudeProject.split('/'), claudeSession), { recursive: true, force: true })
  await writeFile(transcript, beforeSubagent)
  await profile.configure({ ...watchAll, collector: { rootsScanIntervalMs: 250 }, api: { port: daemon.api.port } })
  const restarted = await profile.startDaemon({ entry: aangEntry })
  expect(restarted.url).toBe(daemon.url)
  await expect.poll(async () => (await readRunSummary(restarted.request, claudeRun))?.agents).toBe(1)

  await context.setOffline(false)
  expect(await execution(restarted.request, claudeRun)).toBe('running')
  await healthLacks(page, 'Link:')
  await expect(waitingChip(page)).toHaveCount(0)

  await appendFile(transcript, complete.subarray(beforeSubagent.length))
  await expect.poll(async () => execution(restarted.request, claudeRun)).toBe('waiting:idle')
  await hook.claude('PermissionRequest.Bash.json', {
    ...fields,
    tool_input: { command: 'echo after-reset', description: 'After the reset' },
  })
  await expect(waitingFor(page)).toContainText('Approval request: Bash: echo after-reset')
  await expect(waitingFor(page)).not.toContainText(approvalText)
  expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
})

test('the run list says when only the list request fails and shows the run once the request succeeds again', async ({
  page,
  player,
  daemon,
}) => {
  const runsRoute = `**${endpoints.runs.path}`
  const dropRuns = (route: Route): Promise<void> => route.abort('connectionfailed')
  const trouble = page.getByRole('main').getByRole('status')

  await page.route(runsRoute, dropRuns)
  await page.goto('/')
  await expect(trouble).toHaveText('Could not load the run list. aang keeps retrying.')
  const listProblems = await healthProblems(page)
  await expect(listProblems).toContainText('Link: list not updating')
  await expect(healthDot(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(healthDot(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(listProblems).toHaveCount(0)
  await expect(healthDot(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(healthDot(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(await healthProblems(page)).toContainText('Link: list not updating')

  await page.unroute(runsRoute, dropRuns)
  await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible()
  await expect(trouble).toHaveCount(0)
  await healthLacks(page, 'Link:')

  await page.route(runsRoute, dropRuns)
  await expect(trouble).toHaveText('Could not refresh the run list. Showing earlier data, which may be stale.')
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.agents).toBe(2)
  await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible()
  await expect(await healthProblems(page)).toContainText('Link: list not updating')
  await expect(await healthProblems(page)).toContainText(
    'The daemon did not return the run list. aang keeps retrying; the list on screen may be stale.',
  )

  await page.unroute(runsRoute, dropRuns)
  await expect(runRowOf(page, claudeRun)).toBeVisible()
  await expect(trouble).toHaveCount(0)
  await healthLacks(page, 'Link:')
})

test.describe('a Claude-only install', () => {
  test.skip(
    process.platform === 'win32',
    'on Windows the fake claude needs node with a script and cannot be the configured observer CLI',
  )
  test.use({ claudeScenario: observerScenarios['map-layout'].live })

  test('shows no health dot on the list or the run although Codex is absent and cloud surfaces are not observable', async ({
    page,
    daemon,
    profile,
    aang,
    fakeClaude,
    player,
    hook,
  }) => {
    await aang('install', '--claude')
    expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
    const gate = join(profile.root, 'admission-gate')
    fakeClaude.setScenario({ ...observerScenarios['map-layout'].live, admissionGate: gate })
    await profile.configure({ ...watchAll, cli: { claude: fakeClaude.path }, api: { port: daemon.api.port } })
    const restarted = await profile.startDaemon({ entry: aangEntry })
    expect(restarted.url).toBe(daemon.url)
    const status = async (): Promise<StatusResponse> =>
      endpoints.status.response.parse(await (await restarted.request(endpoints.status.path)).json())
    expect((await status()).not_observable.length).toBeGreaterThan(0)
    const health = async (): Promise<string[]> => {
      const { runtimes, observer } = await status()
      return [
        ...runtimes.map(({ runtime, hooks }) => `${runtime} hooks ${hooks}`),
        ...observer.backends.map(({ vendor, state, admission }) =>
          state.state === 'disabled'
            ? `${vendor} observer disabled: ${state.reason}, admission ${admission?.outcome ?? 'not checked'}`
            : `${vendor} observer ${state.state}`,
        ),
      ]
    }
    await expect
      .poll(health, observed)
      .toEqual([
        'claude hooks active',
        'codex hooks not_installed',
        'claude observer disabled: version_not_admitted, admission pending',
        'codex observer disabled: cli_missing, admission not checked',
      ])

    await page.goto('/')
    await expect(page.getByText('aang watches all directories.', { exact: false })).toBeVisible()
    await expect(healthDot(page)).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Observation status' })).toHaveCount(0)

    await writeFile(gate, '')
    await expect
      .poll(health, observed)
      .toEqual([
        'claude hooks active',
        'codex hooks not_installed',
        'claude observer ok',
        'codex observer disabled: cli_missing, admission not checked',
      ])
    await expect(healthDot(page)).toHaveCount(0)

    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await hook.claude('UserPromptSubmit.json', { ...hookFields(profile, claudeOriginal), prompt_id: 'hooked-turn' })
    await expect.poll(async () => (await readRunSummary(restarted.request, claudeRun))?.support_modes).toEqual(['full'])
    await expect
      .poll(async () => (await readRunSummary(restarted.request, claudeRun))?.observer.last_success_at ?? null, observed)
      .not.toBeNull()
    await expect(runRowOf(page, claudeRun)).toBeVisible()
    await expect(healthDot(page)).toHaveCount(0)

    await runRowOf(page, claudeRun).getByRole('link').click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(claudeGoal)
    await expect(healthDot(page)).toHaveCount(0)
    expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
  })
})

test.describe('a Claude CLI that reports an unrecognizable version', () => {
  test.use({ claudeScenario: { version: 'nightly build' } })

  test('lights the health dot and names the disabled observer', async ({ page, daemon }) => {
    await expect
      .poll(async () => {
        const { observer } = endpoints.status.response.parse(await (await daemon.request(endpoints.status.path)).json())
        const claude = observer.backends.find(({ vendor }) => vendor === 'claude')
        return claude === undefined
          ? 'no backend'
          : claude.state.state === 'disabled'
            ? `disabled: ${claude.state.reason}, admission ${claude.admission?.outcome ?? 'none'}`
            : claude.state.state
      }, observed)
      .toBe('disabled: version_not_admitted, admission none')

    await page.goto('/')
    const problems = await healthProblems(page)
    await expect(problems).toContainText('Observer: Claude Code: disabled: CLI version not admitted')
    await expect(problems).toContainText('Claude Code, model ')
  })
})

test.describe('the health dot', () => {
  test.use({ config: { ...watchAll, spool: { thresholdBytes: 4_096, checkIntervalMs: 50 } } })

  test('lists unknown records, a lost source and an overfull spool', async ({
    page,
    player,
    profile,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible()
    await expect(page.getByText('aang watches all directories.', { exact: false })).toBeVisible()

    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await expect(runRowOf(page, claudeRun)).toBeVisible()
    await healthLacks(page, 'Records:')
    await healthLacks(page, 'Sources:')
    await healthLacks(page, 'Spool:')

    const transcript = sessionFile(profile, claudeOriginal)
    const unknownRecord = { type: 'h1-future-record', sessionId: claudeSession, cwd: claudeOriginal.cwd }
    await appendFile(transcript, `${JSON.stringify(unknownRecord)}\n`)
    await expect(await healthProblems(page)).toContainText('Records: 1 unrecognized record in total')
    await expect(await healthProblems(page)).toContainText('Records in an unknown format are kept in the journal')

    await rm(transcript)
    await expect(await healthProblems(page)).toContainText('Sources: 1 source lost')

    await runRowOf(page, claudeRun).getByRole('link').click()
    await expect(await healthProblems(page)).toContainText('Sources: 1 source lost')
    await expect(await healthProblems(page)).toContainText(/source lost(?:: .*)? since \d/)
    await expect(await healthProblems(page)).toContainText('Records: 1 unrecognized record in this run')

    const { spoolReady } = aangHomePaths(profile.aangHome)
    await mkdir(spoolReady, { recursive: true })
    await writeFile(join(spoolReady, 'h1-overflow.evt'), 'x'.repeat(5_000))
    await expect(await healthProblems(page)).toContainText('Spool: over threshold')
    await expect(await healthProblems(page)).toContainText('Lease released: hooks do not write to the spool.')
  })
})

test.describe('an empty list with watched directories', () => {
  const watched = join(tmpdir(), 'aang-h1-watched-project')

  test.use({ config: { watch: { roots: [{ path: watched }] } } })

  test('names the directories where a run would come from', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: watched })).toBeVisible()
  })
})
