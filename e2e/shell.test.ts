import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endpoints, type RunId } from '@aang/contract'
import { aangHomePaths } from '@aang/contract/home'
import { sampleScenarioManifest } from '@aang/testkit'
import type { Route } from '@playwright/test'
import { aangEntry, expect, test } from './fixtures.js'
import { claudeGoal, claudeOriginal, codexGoal, codexThread, hookFields, runOf, sessionFile } from './samples.js'
import { fact, lamp, runRowOf } from './screens.js'

const claudeSession = claudeOriginal.session
const claudeRun = runOf(claudeOriginal)
const codexRun = runOf(codexThread)
const claudeProject = 'projects/-tmp-aang-spike-cc-transcripts-run'

const watchAll = { watch: { all: true } }

test.use({ config: watchAll })

test('a Claude session without hook events shows inactive hooks and the files-only mode until hooks arrive (E2E 9)', async ({
  page,
  player,
  profile,
  hook,
}) => {
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await page.goto('/')

  const row = runRowOf(page, claudeRun)
  await expect(row).toContainText('hooks inactive')
  await expect(row).toContainText('files only')
  await expect(row.getByRole('link')).toHaveText(claudeGoal)
  await expect(lamp(page, 'Hooks')).toHaveText('Hooks inactive in 1 session')
  await lamp(page, 'Hooks').getByRole('button').click()
  await expect(page.getByRole('region', { name: 'Hooks: details' })).toContainText(
    'Claude Code: hooks inactive in 1 session, "files only" mode.',
  )
  await expect(lamp(page, 'Versions')).toHaveText('Versions 1 version without full support')
  await lamp(page, 'Versions').getByRole('button').click()
  await expect(page.getByRole('region', { name: 'Versions: details' })).toHaveText(
    /^Claude Code \d+\.\d+\.\d+ \(surface unknown\), (macos|linux|windows), local: unverified, 1 session\.$/,
  )

  await row.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?run=${claudeRun}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(claudeGoal)
  await expect(fact(page, 'Freshness')).toHaveText('hooks inactive')
  await expect(fact(page, 'Mode')).toHaveText('files only')
  await expect(lamp(page, 'Mode')).toHaveText('Mode files only')
  await lamp(page, 'Mode').getByRole('button').click()
  await expect(page.getByRole('region', { name: 'Mode: details' })).toHaveText(
    'Session 86f93ed5: files only: hooks inactive, events come from session files.',
  )

  await expect(fact(page, 'Attention')).toHaveText('none')

  await hook.claude('PermissionRequest.Bash.json', hookFields(profile, claudeOriginal))

  await expect(lamp(page, 'Mode')).toHaveText('Mode full')
  await expect(fact(page, 'Mode')).toHaveText('full')
  await expect(fact(page, 'Attention')).toHaveText('awaiting an answer: 1')
  await expect(lamp(page, 'Hooks')).not.toContainText('inactive in')

  await page.getByRole('navigation').getByRole('link', { name: 'Runs' }).click()
  await expect(runRowOf(page, claudeRun)).toContainText('full')
  await expect(runRowOf(page, claudeRun)).toContainText('awaiting an answer: 1')
  await expect(runRowOf(page, claudeRun)).not.toContainText('hooks inactive')
})

test('a Codex session without hook events shows inactive hooks and the files-only mode (E2E 9)', async ({
  page,
  player,
}) => {
  await page.goto(`/?run=${codexRun}`)
  await expect(page.getByRole('heading', { name: 'Run not found' })).toBeVisible()
  await expect(lamp(page, 'Link')).toHaveText('Link run not found')

  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(codexGoal)
  await expect(fact(page, 'Freshness')).toHaveText('hooks inactive')
  await expect(lamp(page, 'Mode')).toHaveText('Mode files only')
  await expect(lamp(page, 'Hooks')).toHaveText('Hooks inactive in 1 session')
  await expect(lamp(page, 'Link')).toHaveText('Link stream connected')

  await page.getByRole('link', { name: 'aang' }).click()
  const row = runRowOf(page, codexRun)
  await expect(row).toContainText('hooks inactive')
  await expect(row).toContainText('files only')
})

test.describe('a session that loses its hooks mid-session', () => {
  test.use({ config: { ...watchAll, freshness: { hooksInactiveAfterMs: 1_000 } } })

  test('shows inactive hooks and the files-only mode from a turn without hook events until the next hook event', async ({
    page,
    player,
    profile,
    hook,
  }) => {
    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await hook.claude('UserPromptSubmit.json', { ...hookFields(profile, claudeOriginal), prompt_id: 'hooked-turn' })
    await page.goto(`/?run=${claudeRun}`)
    await expect(fact(page, 'Mode')).toHaveText('full')
    await expect(fact(page, 'Freshness')).not.toHaveText('hooks inactive')
    await expect(lamp(page, 'Hooks')).not.toContainText('inactive in')

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

    await expect(fact(page, 'Freshness')).toHaveText('hooks inactive')
    await expect(fact(page, 'Mode')).toHaveText('files only')
    await expect(lamp(page, 'Hooks')).toHaveText('Hooks inactive in 1 session')
    await lamp(page, 'Mode').getByRole('button').click()
    await expect(page.getByRole('region', { name: 'Mode: details' })).toHaveText(
      'Session 86f93ed5: files only: hooks inactive, events come from session files.',
    )

    await hook.claude('Stop.json', hookFields(profile, claudeOriginal))

    await expect(fact(page, 'Mode')).toHaveText('full')
    await expect(fact(page, 'Freshness')).not.toHaveText('hooks inactive')
    await expect(lamp(page, 'Hooks')).not.toContainText('inactive in')
  })
})

const readRunSummary = async (request: (path: string) => Promise<Response>, run: RunId) => {
  const response = await request(endpoints.run.path.replace(':run', run))
  return response.ok ? endpoints.run.response.parse(await response.json()).summary : null
}

test('the run page follows the stream live and re-reads the run when the stream resets on a replaced database', async ({
  page,
  context,
  player,
  profile,
  daemon,
}) => {
  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
  const claude = await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })
  await claude.play({ until: 'subagent' })
  const transcript = sessionFile(profile, claudeOriginal)
  const beforeSubagent = await readFile(transcript)
  await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.agents).toBe(1)

  await page.goto(`/?run=${claudeRun}`)
  await expect(fact(page, 'State')).toHaveText('running')
  await expect(fact(page, 'Agents')).toHaveText('1')
  await expect(lamp(page, 'Link')).toHaveText('Link stream connected')

  await claude.play()
  await expect(fact(page, 'Agents')).toHaveText('2')
  await expect(fact(page, 'State')).toHaveText('waiting for input')
  const complete = await readFile(transcript)

  await context.setOffline(true)
  expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
  await expect(lamp(page, 'Link')).toHaveText('Link no connection to the daemon')

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
  await expect(fact(page, 'Agents')).toHaveText('1')
  await expect(fact(page, 'State')).toHaveText('running')
  await expect(lamp(page, 'Link')).toHaveText('Link stream connected')

  await appendFile(transcript, complete.subarray(beforeSubagent.length))
  await expect(fact(page, 'State')).toHaveText('waiting for input')
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
  await expect(lamp(page, 'Link')).toHaveText('Link list not updating')

  await page.unroute(runsRoute, dropRuns)
  await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible()
  await expect(trouble).toHaveCount(0)
  await expect(lamp(page, 'Link')).toHaveText('Link connected')

  await page.route(runsRoute, dropRuns)
  await expect(trouble).toHaveText('Could not refresh the run list. Showing earlier data, which may be stale.')
  await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
  await expect.poll(async () => (await readRunSummary(daemon.request, claudeRun))?.agents).toBe(2)
  await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible()
  await expect(lamp(page, 'Link')).toHaveText('Link list not updating')
  await lamp(page, 'Link').getByRole('button').click()
  await expect(page.getByRole('region', { name: 'Link: details' })).toHaveText(
    'The daemon did not return the run list. aang keeps retrying; the list on screen may be stale.',
  )

  await page.unroute(runsRoute, dropRuns)
  await expect(runRowOf(page, claudeRun)).toBeVisible()
  await expect(trouble).toHaveCount(0)
  await expect(lamp(page, 'Link')).toHaveText('Link connected')
})

test.describe('the status strip', () => {
  test.use({ config: { ...watchAll, spool: { thresholdBytes: 4_096, checkIntervalMs: 50 } } })

  test('lights the lamps for unknown records, a lost source and an overfull spool', async ({
    page,
    player,
    profile,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'No runs yet' })).toBeVisible()
    await expect(page.getByText('aang watches all directories.', { exact: false })).toBeVisible()

    await (await player(sampleScenarioManifest('claude-subagent'), { timeScale: 0 })).play()
    await expect(runRowOf(page, claudeRun)).toBeVisible()
    await expect(lamp(page, 'Records')).toHaveText('Records all recognized')
    await expect(lamp(page, 'Sources')).toHaveText('Sources fine')
    await expect(lamp(page, 'Spool')).toHaveText('Spool empty')

    const transcript = sessionFile(profile, claudeOriginal)
    const unknownRecord = { type: 'h1-future-record', sessionId: claudeSession, cwd: claudeOriginal.cwd }
    await appendFile(transcript, `${JSON.stringify(unknownRecord)}\n`)
    await expect(lamp(page, 'Records')).toHaveText('Records 1 unrecognized record in total')
    await lamp(page, 'Records').getByRole('button').click()
    await expect(page.getByRole('region', { name: 'Records: details' })).toContainText(
      'Records in an unknown format are kept in the journal',
    )

    await rm(transcript)
    await expect(runRowOf(page, claudeRun)).toContainText('source lost')
    await expect(lamp(page, 'Sources')).toHaveText('Sources 1 source lost')

    await runRowOf(page, claudeRun).getByRole('link').click()
    await expect(fact(page, 'Freshness')).toHaveText('source lost')
    await expect(lamp(page, 'Sources')).toHaveText('Sources 1 source lost')
    await lamp(page, 'Sources').getByRole('button').click()
    await expect(page.getByRole('region', { name: 'Sources: details' })).toContainText('source lost')
    await expect(lamp(page, 'Records')).toHaveText('Records 1 unrecognized record in this run')

    const { spoolReady } = aangHomePaths(profile.aangHome)
    await mkdir(spoolReady, { recursive: true })
    await writeFile(join(spoolReady, 'h1-overflow.evt'), 'x'.repeat(5_000))
    await expect(lamp(page, 'Spool')).toHaveText('Spool over threshold')
    await lamp(page, 'Spool').getByRole('button').click()
    await expect(page.getByRole('region', { name: 'Spool: details' })).toContainText(
      'Lease released: hooks do not write to the spool.',
    )
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
