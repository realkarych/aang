import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { endpoints, type RunId, type RunSnapshot, type StageId, type StageInspector } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import {
  goalCriterionText,
  mainStageTitle,
  observerScenarios,
  type Profile,
  type RunningDaemon,
  sampleScenarioManifest,
} from '@aang/testkit'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { aangEntry, expect, test } from './fixtures.js'
import { freshManifest } from './fresh.js'
import { trace } from './screens.js'

const claudeSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const claudeRun = runId({ kind: 'session', runtime: 'claude', session: claudeSession })

test.use({ config: { watch: { all: true } } })

const snapshotOf = async (request: APIRequestContext, run: RunId): Promise<RunSnapshot | null> => {
  const response = await request.get(endpoints.run.path.replace(':run', run))
  return response.ok() ? endpoints.run.response.parse(await response.json()) : null
}

const interpreted = async (request: APIRequestContext, run: RunId): Promise<RunSnapshot> => {
  const settled: { snapshot: RunSnapshot | null } = { snapshot: null }
  await expect
    .poll(
      async () => {
        const snapshot = await snapshotOf(request, run)
        settled.snapshot =
          snapshot !== null && snapshot.model.stages.length > 0 && snapshot.summary.observer.pending_facts === 0
            ? snapshot
            : null
        return settled.snapshot !== null
      },
      { timeout: 45_000 },
    )
    .toBe(true)
  if (settled.snapshot === null) {
    throw new Error('the observer must interpret the run')
  }
  return settled.snapshot
}

const stageTitled = (snapshot: RunSnapshot, title: (text: string) => boolean): StageId => {
  const stage = snapshot.model.stages.find((candidate) => title(candidate.title))
  if (stage === undefined) {
    throw new Error('the stage must exist')
  }
  return stage.id
}

const liveSample = (): Promise<string> =>
  freshManifest(sampleScenarioManifest('claude-subagent'), test.info().outputPath('live-sample'))

const jsonText = (value: string): string => JSON.stringify(value).slice(1, -1)

const inspector = (page: Page): Locator => page.getByRole('complementary')

const section = (page: Page, title: string): Locator =>
  inspector(page).getByRole('region', { name: new RegExp(`^${title}`) })

test('the inspector of a stage shows its axes, criteria, work and relations, and its grounds lead to the raw record (E2E 1)', async ({
  page,
  player,
  fakeClaude,
}) => {
  fakeClaude.setScenario(observerScenarios['live-map'].live)
  await (await player(await liveSample(), { timeScale: 0 })).play()
  const main = stageTitled(await interpreted(page.request, claudeRun), (title) => title === mainStageTitle)

  await page.goto(`/?run=${claudeRun}&stage=${main}`)
  const panel = inspector(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(mainStageTitle)
  await expect(panel.getByRole('heading', { level: 2 })).toBeFocused()
  await expect(panel).toContainText('восстановлен наблюдателем')
  await expect(section(page, 'Критерии')).toContainText('The goal of the run is reached')
  await expect(section(page, 'Критерии')).toContainText('не проверен')
  await expect(section(page, 'Участники и действия')).toContainText('Основной агент')
  await expect(section(page, 'Участники и действия').getByRole('list', { name: 'Действия этапа' })).toContainText('echo hi')
  await expect(section(page, 'Время и расход')).toContainText('Расход решателя, токены')

  await section(page, 'Связи').getByRole('link', { name: /^pinger/ }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(/^pinger/)
  await expect(page).toHaveURL(/&stage=/)
  await section(page, 'Связи').getByRole('link', { name: mainStageTitle }).click()
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(mainStageTitle)

  const grounds = section(page, 'Основания')
  await grounds.getByRole('button', { name: /^Этап и его описание: \d+ факт/ }).click()
  const prompt = grounds
    .getByRole('list', { name: 'Основания: Этап и его описание' })
    .getByRole('listitem')
    .filter({ hasText: /^Промпт/ })
    .first()
  await expect(prompt).toContainText('человек')
  await prompt.getByRole('button', { name: 'Сырая запись' }).click()
  const raw = prompt.getByRole('region', { name: /^Сырая запись: Промпт/ })
  await expect(raw).toContainText('транскрипт, Claude Code')
  await expect(raw).toContainText(`${claudeSession}.jsonl, строка`)
  await expect(raw.locator('pre')).toContainText(`"sessionId": "${claudeSession}"`)

  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`\\?run=${claudeRun}$`))
})

test('the open inspector follows the model live and lists the observer answer the daemon rejected', async ({
  page,
  player,
  fakeClaude,
}) => {
  fakeClaude.setScenario(observerScenarios['rejected-answer'].live)
  const playback = await player(await liveSample(), { timeScale: 0 })
  await playback.play({ until: 'subagent' })
  const main = stageTitled(await interpreted(page.request, claudeRun), (title) => title === mainStageTitle)

  await page.goto(`/?run=${claudeRun}&stage=${main}`)
  await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText(mainStageTitle)
  await expect(section(page, 'Связи')).toContainText('Связей с другими этапами нет.')

  await playback.play()
  await expect(section(page, 'Связи').getByRole('link', { name: /^pinger/ })).toBeVisible({ timeout: 45_000 })
  const rejected = section(page, 'Отклонённые ответы наблюдателя')
  await expect(rejected).toContainText('Ответ отклонён целиком')
  await expect(rejected).toContainText('нарушает правила модели')
  await expect(rejected).toContainText('операция 1')
})

test('a report written by a Bash command becomes an output, its copy read later is not passed off as what the command wrote, and it opens after the file changed, vanished and the daemon restarted (E2E 17)', async ({
  page,
  player,
  profile,
  daemon,
  fakeClaude,
}) => {
  fakeClaude.setScenario(observerScenarios.report.live)
  const project = join(profile.home, 'project')
  await mkdir(project, { recursive: true })
  const report = join(project, 'report.md')
  const written = 'report-v1\n'
  const retained = `${written}${'all checks passed\n'.repeat(6_000)}end of report\n`
  await writeFile(report, retained)
  const sample = await freshManifest(sampleScenarioManifest('claude-subagent'), test.info().outputPath('report-sample'), [
    ['/tmp/aang-spike/cc-transcripts/run', jsonText(project)],
    ['"command": "echo hi"', `"command": "echo ${written.trim()} > report.md"`],
  ])
  await (await player(sample, { timeScale: 0 })).play()
  const main = stageTitled(await interpreted(page.request, claudeRun), (title) => title === mainStageTitle)

  await page.goto(`/?run=${claudeRun}&stage=${main}`)
  const outputs = section(page, 'Входы и выходы')
  await expect(outputs.getByRole('list', { name: 'Выходы' })).toContainText(report)
  await expect(outputs).toContainText('сохранена: состояние файла на момент чтения', { timeout: 15_000 })
  await expect(outputs).toContainText('в файл писало действие Bash; что копия — записанное им содержимое, не доказано')
  await expect(outputs).not.toContainText('записана действием')

  await writeFile(report, 'report-v2\n')
  await rm(report)
  expect(await readFile(report, 'utf8').catch(() => null)).toBeNull()
  expect(await daemon.stop()).toEqual({ code: 0, signal: null })
  const restarted = await profile.startDaemon({ entry: aangEntry })
  try {
    await page.goto(`${restarted.url}/?run=${claudeRun}&stage=${main}`)
    const saved = section(page, 'Входы и выходы')
    await saved.getByRole('button', { name: 'Открыть сохранённую версию' }).click()
    const version = saved.getByRole('region', { name: `Сохранённая версия: ${report}` })
    await expect(version).toContainText('состояние файла на момент чтения')
    await expect(version.locator('pre')).toHaveText(retained.slice(0, 100_000))
    await expect(version).toContainText('Показаны первые 100 000 символов из 108 024.')
    await version.getByRole('button', { name: 'Показать полностью' }).click()
    await expect(version.locator('pre')).toHaveText(retained)
  } finally {
    expect(await restarted.stop()).toEqual({ code: 0, signal: null })
  }
})

const runFile = promisify(execFile)

const projectsRoot = realpathSync(tmpdir())

const projectAt = (name: string): string => join(projectsRoot, `aang-e2e-${name}-${String(process.pid)}`)

const git = async (cwd: string, ...args: readonly string[]): Promise<string> => {
  const { stdout } = await runFile('git', ['-c', 'user.name=aang', '-c', 'user.email=aang@example.invalid', ...args], {
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(projectsRoot, 'aang-e2e-no-gitconfig'),
    },
  })
  return stdout.trim()
}

const appFile = (project: string): string => join(project, 'src', 'app.ts')

const repositoryAt = async (project: string): Promise<string> => {
  await mkdir(join(project, 'src'), { recursive: true })
  await writeFile(appFile(project), 'export const app = 1\n')
  await git(project, 'init', '--quiet', '--initial-branch=main')
  await git(project, 'add', '--all')
  await git(project, 'commit', '--quiet', '--message=init')
  return git(project, 'rev-parse', 'HEAD')
}

const shortSha = (sha: string): string => sha.slice(0, 12)

type TranscriptEntry = Readonly<Record<string, unknown>> & { readonly type: 'user' | 'assistant' }

const prompt = (text: string): TranscriptEntry => ({ type: 'user', message: { role: 'user', content: text } })

const command = (call: string, text: string): TranscriptEntry => ({
  type: 'assistant',
  message: {
    id: `message-${call}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id: call, name: 'Bash', input: { command: text } }],
  },
})

const failedWith = (call: string, output: string): TranscriptEntry => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: output, is_error: true }] },
})

const passedWith = (call: string, output: string): TranscriptEntry => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: output, is_error: false }] },
  toolUseResult: { stdout: output, stderr: '', interrupted: false, isImage: false },
})

const reply = (id: string, text: string): TranscriptEntry => ({
  type: 'assistant',
  message: { id, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
})

interface Transcript {
  readonly run: RunId
  readonly append: (...entries: readonly TranscriptEntry[]) => Promise<void>
}

const transcriptOf = (profile: Profile, project: string, session: string): Transcript => {
  const started = Date.now() - 60_000
  let path: string | null = null
  let lines = 0
  return {
    run: runId({ kind: 'session', runtime: 'claude', session }),
    append: async (...entries) => {
      const text = entries
        .map((entry, offset) => {
          const index = lines + offset
          return `${JSON.stringify({
            ...entry,
            sessionId: session,
            uuid: `${session}-${String(index)}`,
            parentUuid: index === 0 ? null : `${session}-${String(index - 1)}`,
            timestamp: new Date(started + index * 1_000).toISOString(),
            cwd: project,
          })}\n`
        })
        .join('')
      lines += entries.length
      if (path === null) {
        path = await profile.write('claude', `projects/e2e-inspector/${session}.jsonl`, text)
      } else {
        await appendFile(path, text)
      }
    },
  }
}

const snapshotRecords = async (request: APIRequestContext, seq = 1): Promise<number> => {
  const response = await request.get(endpoints.raw.path.replace(':seq', String(seq)))
  if (!response.ok()) {
    return 0
  }
  const { raw } = endpoints.raw.response.parse(await response.json())
  return (raw.channel === 'snapshot' ? 1 : 0) + (await snapshotRecords(request, seq + 1))
}

const contractCriterion = (page: Page): Locator =>
  section(page, 'Критерии').getByRole('listitem').filter({ hasText: 'Check "test" passes' })

const statusGrounds = async (criterion: Locator): Promise<Locator> => {
  const toggle = criterion.getByRole('button', { name: /^Статус критерия/ })
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click()
  }
  return criterion.getByRole('list', { name: /^Основания: Статус критерия/ })
}

const snapshotRows = (criterion: Locator, text: string): Locator =>
  criterion.getByRole('table', { name: /^Снимки рабочего дерева/ }).getByRole('row').filter({ hasText: text })

const verifiedProject = projectAt('verified')

test.describe('a claim of done over a failed check, then a passing repeat that reports its commit', () => {
  test.use({
    config: {
      watch: {
        roots: [
          {
            path: verifiedProject,
            contracts: [
              { name: 'test', command: '^pnpm test', inputMasks: ['src'], commitPattern: 'verified commit ([0-9a-f]+)' },
            ],
          },
        ],
      },
    },
  })

  test.afterEach(async () => {
    await rm(verifiedProject, { recursive: true, force: true })
  })

  test('the open inspector shows the claimed done stage with its open failed check, confirms the repeat on the reported commit and marks it stale after an edit under the mask (E2E 3)', async ({
    page,
    profile,
    fakeClaude,
  }) => {
    fakeClaude.setScenario(observerScenarios['claimed-done'].live)
    const head = await repositoryAt(verifiedProject)
    const transcript = transcriptOf(profile, verifiedProject, 'e2e-claimed-done')
    await transcript.append(
      prompt('Run the tests and report.'),
      command('toolu_check', 'pnpm test'),
      failedWith('toolu_check', 'Exit code 1\nfailed'),
      reply('message-done', 'All done: the tests pass.'),
    )
    const main = stageTitled(await interpreted(page.request, transcript.run), (title) => title === mainStageTitle)

    await page.goto(`/?run=${transcript.run}&stage=${main}`)
    const panel = inspector(page)
    await expect(panel.getByRole('definition').filter({ hasText: 'завершён' }).first()).toContainText('заявление решателя')
    await expect(panel).toContainText('Завершён, но есть упавшая проверка')
    const attention = section(page, 'Внимание')
    await expect(attention).toContainText('Упавшая проверка')
    await expect(attention).toContainText('открыт')
    const criteria = section(page, 'Критерии')
    await expect(criteria).toContainText('агент сообщил о завершении')
    const contract = contractCriterion(page)
    await expect(contract).toContainText('не выполнен')
    await expect(contract).toContainText('по контракту проверки test')
    await expect(contract).toContainText('Критерий всего прогона')
    const goal = criteria.getByRole('listitem').filter({ hasText: goalCriterionText })
    await expect(await statusGrounds(goal)).toContainText('All done: the tests pass.')

    await transcript.append(
      prompt('The check failed. Fix the code and run the check again.'),
      command('toolu_verify', 'pnpm test && echo "verified commit $(git rev-parse HEAD)"'),
      passedWith('toolu_verify', `Tests passed\nverified commit ${head}\n`),
      reply('message-verified', 'Fixed: the tests pass on the checked commit.'),
    )
    await expect(contract).toContainText('подтверждён', { timeout: 45_000 })
    await expect(contract).toContainText(`Проверенная версия — коммит ${shortSha(head)}`)
    await expect(contract).toContainText('Критерий всего прогона')
    await expect(await statusGrounds(contract)).toContainText(`verified commit ${head}`)

    let edit = 1
    await expect(async () => {
      edit += 1
      await writeFile(appFile(verifiedProject), `export const app = ${String(edit)}\n`)
      await expect(contract).toContainText('проверен на другой версии', { timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await expect(contract).toContainText(`Проверен на коммите ${shortSha(head)}, текущее состояние уже другое`)
    await expect(contract).not.toContainText('подтверждён')
    const edited = snapshotRows(contract, 'после изменения файлов')
    await expect(edited).toContainText('есть изменения')
    await expect(edited).toContainText(shortSha(head))
    const grounds = await statusGrounds(contract)
    await expect(grounds).toContainText('Снимок рабочего дерева')
    await expect(grounds).toContainText('есть изменения под масками')
  })
})

const unversionedProject = projectAt('unversioned')

test.describe('a passing check by a contract without a reported commit', () => {
  test.use({
    config: {
      watch: { roots: [{ path: unversionedProject, contracts: [{ name: 'test', command: '^pnpm test', inputMasks: ['src'] }] }] },
    },
  })

  test.afterEach(async () => {
    await rm(unversionedProject, { recursive: true, force: true })
  })

  test('the open inspector shows passed_unversioned with the clean tree note and never a confirmation, for a tree clean around the check and for an input changed and restored between its snapshots (E2E 3)', async ({
    page,
    profile,
    fakeClaude,
  }) => {
    fakeClaude.setScenario(observerScenarios['live-map'].live)
    const first = await repositoryAt(unversionedProject)
    const transcript = transcriptOf(profile, unversionedProject, 'e2e-unversioned')
    await transcript.append(prompt('Run the tests.'), command('toolu_first', 'pnpm test'))
    await expect.poll(() => snapshotRecords(page.request), { timeout: 15_000 }).toBe(1)
    await transcript.append(passedWith('toolu_first', 'Tests passed\n'), reply('message-first', 'The tests pass.'))
    const main = stageTitled(await interpreted(page.request, transcript.run), (title) => title === mainStageTitle)

    await page.goto(`/?run=${transcript.run}&stage=${main}`)
    const contract = contractCriterion(page)
    await expect(contract).toContainText('проверка прошла, версия не установлена')
    await expect(contract).toContainText('какую версию она проверила, неизвестно: подтверждением это не считается.')
    await expect(contract).toContainText(`Справочно: дерево было чистым на коммите ${shortSha(first)} в обоих снимках.`)
    await expect(snapshotRows(contract, 'при проверке')).toHaveCount(2)
    await expect(snapshotRows(contract, 'чисто')).toHaveCount(2)
    await expect(contract).not.toContainText('подтверждён')
    await expect(contract).not.toContainText('Проверенная версия')
    const firstGrounds = await statusGrounds(contract)
    await expect(firstGrounds).toContainText('Снимок рабочего дерева')
    await expect(firstGrounds).toContainText('дерево чистое')

    await writeFile(appFile(unversionedProject), 'export const app = 2\n')
    await git(unversionedProject, 'commit', '--quiet', '--all', '--message=fix')
    const second = await git(unversionedProject, 'rev-parse', 'HEAD')
    await transcript.append(prompt('Run the app tests on the fix.'), command('toolu_second', 'pnpm test --filter app'))
    await expect.poll(() => snapshotRecords(page.request), { timeout: 15_000 }).toBe(3)
    await writeFile(appFile(unversionedProject), 'export const app = 3\n')
    await writeFile(appFile(unversionedProject), 'export const app = 2\n')
    await transcript.append(passedWith('toolu_second', 'Tests passed\n'), reply('message-second', 'The app tests pass.'))

    await expect(contract).toContainText(`Справочно: дерево было чистым на коммите ${shortSha(second)} в обоих снимках.`, {
      timeout: 45_000,
    })
    await expect(contract).toContainText('проверка прошла, версия не установлена')
    await expect(contract).not.toContainText('подтверждён')
    await expect(contract).not.toContainText('Проверенная версия')
    await expect(snapshotRows(contract, shortSha(second))).toHaveCount(2)
    await expect(snapshotRows(contract, 'чисто')).toHaveCount(2)
    await expect(await statusGrounds(contract)).toContainText('pnpm test --filter app')
  })
})

const resetProject = projectAt('reset')

const markerTranscript = async (profile: Profile, session: string): Promise<Transcript> => {
  await mkdir(resetProject, { recursive: true })
  const transcript = transcriptOf(profile, resetProject, session)
  await transcript.append(
    prompt('Print a marker.'),
    command('toolu_marker', 'echo review-reset'),
    passedWith('toolu_marker', 'review-reset\n'),
    reply('message-marker', 'Printed the marker.'),
  )
  return transcript
}

const transcriptFile = (profile: Profile, session: string): string =>
  join(profile.claude, 'projects', 'e2e-inspector', `${session}.jsonl`)

const stageReads = (page: Page): readonly string[] => {
  const reads: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/stages/')) {
      reads.push(request.url())
    }
  })
  return reads
}

const openMarkerStage = async (page: Page, run: RunId, stage: StageId): Promise<void> => {
  await page.goto(`/?run=${run}&stage=${stage}`)
  await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText(mainStageTitle)
  const actions = section(page, 'Участники и действия').getByRole('list', { name: 'Действия этапа' })
  await expect(actions).toContainText('echo review-reset')
}

const restartedOnNewDatabase = async (
  profile: Profile,
  daemon: RunningDaemon,
  rewrite: () => Promise<void>,
  observer: string | null = null,
): Promise<RunningDaemon> => {
  expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
  for (const file of ['aang.db', 'aang.db-wal', 'aang.db-shm']) {
    await rm(join(profile.aangHome, file), { force: true })
  }
  await rewrite()
  await profile.configure({
    watch: { all: true },
    collector: { rootsScanIntervalMs: 250 },
    api: { port: daemon.api.port },
    ...(observer === null ? {} : { cli: { claude: observer } }),
  })
  const restarted = await profile.startDaemon({ entry: aangEntry })
  expect(restarted.url).toBe(daemon.url)
  return restarted
}

const reportTranscript = async (profile: Profile, session: string, marker: string, notes = 0): Promise<Transcript> => {
  await mkdir(resetProject, { recursive: true })
  await writeFile(join(resetProject, 'report.md'), `${marker} report\n`)
  const transcript = transcriptOf(profile, resetProject, session)
  await transcript.append(
    prompt(`Write the ${marker} report.`),
    command('toolu_report', `echo ${marker} report > report.md`),
    passedWith('toolu_report', 'ok\n'),
    reply('message-report', `Wrote the ${marker} report.`),
    ...Array.from({ length: notes }, (_, note) => reply(`message-note-${String(note)}`, `Note ${String(note)} on the report.`)),
  )
  return transcript
}

const inspectedStage = async (request: APIRequestContext, run: RunId, stage: StageId): Promise<StageInspector> => {
  const response = await request.get(endpoints.stage.path.replace(':run', run).replace(':stage', stage))
  expect(response.ok()).toBe(true)
  return endpoints.stage.response.parse(await response.json())
}

const reported = async (request: APIRequestContext, run: RunId): Promise<{ stage: StageId; inspected: StageInspector }> => {
  const stage = stageTitled(await interpreted(request, run), (title) => title === mainStageTitle)
  await expect.poll(async () => (await inspectedStage(request, run, stage)).outputs.length, { timeout: 45_000 }).toBe(1)
  return { stage, inspected: await inspectedStage(request, run, stage) }
}

const cacheKeys = ({ evidence, actions }: StageInspector): { prompt: number | undefined; input: string | null | undefined } => ({
  prompt: evidence.find(({ kind }) => kind === 'prompt')?.seq,
  input: actions[0]?.input_fact,
})

const expandAll = async (panel: Locator): Promise<void> => {
  for (const name of [/: \d+ факт/, /^Сырая запись$/, /^Открыть сохранённую версию$/]) {
    const closed = panel.getByRole('button', { name, expanded: false })
    const count = await closed.count()
    for (let opened = 0; opened < count; opened += 1) {
      await closed.first().click()
    }
    await expect(panel.getByText(/^Загрузка/)).toHaveCount(0)
  }
}

const shows = async (page: Page, marker: string, stale: string): Promise<void> => {
  const panel = inspector(page)
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(mainStageTitle)
  await expect(section(page, 'Критерии')).toContainText(goalCriterionText)
  await expandAll(panel)
  const outputs = section(page, 'Входы и выходы')
  await expect(outputs.getByRole('list', { name: 'Выходы' })).toContainText(join(resetProject, 'report.md'))
  await expect(outputs.getByRole('region', { name: /^Сохранённая версия/ }).locator('pre')).toHaveText(`${marker} report\n`)
  await expect(outputs.getByRole('region', { name: /^Сырая запись/ }).filter({ hasText: `echo ${marker} report` })).not.toHaveCount(0)
  await expect(section(page, 'Время и расход')).toContainText('Расход решателя, токены')
  await expect(section(page, 'Участники и действия').getByRole('list', { name: 'Действия этапа' })).toContainText(
    `echo ${marker} report > report.md`,
  )
  await expect(section(page, 'Связи')).toContainText('Связей с другими этапами нет.')
  const grounds = section(page, 'Основания')
  const promptFact = grounds.getByRole('listitem').filter({ hasText: /^Промпт/ }).first()
  await expect(promptFact).toContainText(`Write the ${marker} report.`)
  await expect(promptFact.getByRole('region', { name: /^Сырая запись: Промпт/ }).locator('pre')).toContainText(
    `Write the ${marker} report.`,
  )
  await expect(section(page, 'История')).toContainText('создание этапа')
  await expect(panel).not.toContainText(stale)
  await expect(trace(page)).toContainText(`echo ${marker} report > report.md`)
  await expect(trace(page)).not.toContainText(stale)
}

const selectByAddress = (page: Page, run: RunId, stage: StageId): Promise<void> =>
  page.evaluate((href) => {
    window.history.pushState(null, '', href)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, `/?run=${run}&stage=${stage}`)

const goneStage = (stage: StageId): string =>
  `В этом прогоне нет этапа ${stage.slice(0, 8)}: ссылка устарела или прогон собран заново.`

const quietMs = 2_000

test.describe('a database replaced under the open inspector', () => {
  test.afterEach(async () => {
    await rm(resetProject, { recursive: true, force: true })
  })

  test('the open inspector reads its stage again when the stream resets to a lower position and says the stage is gone, without a read loop', async ({
    page,
    context,
    profile,
    daemon,
    fakeClaude,
  }) => {
    fakeClaude.setScenario(observerScenarios['live-map'].live)
    const session = 'e2e-reset-lower'
    const transcript = await markerTranscript(profile, session)
    const before = await interpreted(page.request, transcript.run)
    const main = stageTitled(before, (title) => title === mainStageTitle)
    const reads = stageReads(page)
    await openMarkerStage(page, transcript.run, main)

    await context.setOffline(true)
    const restarted = await restartedOnNewDatabase(profile, daemon, async () => {
      const file = transcriptFile(profile, session)
      const [first] = (await readFile(file, 'utf8')).split('\n')
      await writeFile(file, `${first ?? ''}\n`)
    })
    try {
      await expect.poll(async () => (await snapshotOf(page.request, transcript.run)) !== null).toBe(true)
      const after = await snapshotOf(page.request, transcript.run)
      expect(after?.model.stages).toEqual([])
      expect(after?.change_seq).toBeLessThan(before.change_seq)
      const stagePath = endpoints.stage.path.replace(':run', transcript.run).replace(':stage', main)
      expect((await page.request.get(stagePath)).status()).toBe(404)
      const offline = reads.length

      await context.setOffline(false)
      const panel = inspector(page)
      await expect(panel).toContainText(goneStage(main))
      await expect(panel.getByRole('heading', { level: 2 })).toHaveText(`Этап ${main.slice(0, 8)}`)
      await expect(panel).not.toContainText('echo review-reset')
      expect(reads.length).toBeGreaterThan(offline)
      const settled = reads.length
      await page.waitForTimeout(quietMs)
      expect(reads).toHaveLength(settled)
    } finally {
      expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
    }
  })

  test('after the database is replaced under the open inspector, no section of it or of the trace shows the old base, and a stage of the new base grounds its facts to its own raw records without a page reload', async ({
    page,
    context,
    profile,
    daemon,
    fakeClaude,
  }) => {
    fakeClaude.setScenario(observerScenarios.report.live)
    const session = 'e2e-replaced-base'
    const transcript = await reportTranscript(profile, session, 'old-marker', 6)
    const before = await reported(page.request, transcript.run)

    await page.goto(`/?run=${transcript.run}&stage=${before.stage}`)
    await page.evaluate(() => Reflect.set(window, 'aangDocument', 'kept'))
    await shows(page, 'old-marker', 'new-marker')

    await context.setOffline(true)
    const restarted = await restartedOnNewDatabase(
      profile,
      daemon,
      async () => {
        await reportTranscript(profile, session, 'new-marker')
      },
      fakeClaude.path,
    )
    try {
      const after = await reported(page.request, transcript.run)
      expect(after.stage).not.toBe(before.stage)
      expect(after.inspected.change_seq).toBeLessThan(before.inspected.change_seq)
      expect(cacheKeys(after.inspected)).toEqual(cacheKeys(before.inspected))
      expect(cacheKeys(after.inspected).prompt).toBeDefined()
      expect(cacheKeys(after.inspected).input).toEqual(expect.any(String))

      await context.setOffline(false)
      const panel = inspector(page)
      await expect(panel).toContainText(goneStage(before.stage))
      await expect(panel.getByRole('region')).toHaveCount(0)
      await expect(panel).not.toContainText('old-marker')
      await expect(trace(page)).toContainText('echo new-marker report > report.md')
      await expect(trace(page)).not.toContainText('old-marker')

      await selectByAddress(page, transcript.run, after.stage)
      await shows(page, 'new-marker', 'old-marker')
      expect(await page.evaluate(() => Reflect.get(window, 'aangDocument') as unknown)).toBe('kept')
    } finally {
      expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
    }
  })

  test('the open inspector reads its stage again when its run vanishes from the replaced database and says the stage is gone, without a read loop', async ({
    page,
    context,
    profile,
    daemon,
    fakeClaude,
  }) => {
    fakeClaude.setScenario(observerScenarios['live-map'].live)
    const session = 'e2e-reset-vanished'
    const transcript = await markerTranscript(profile, session)
    const main = stageTitled(await interpreted(page.request, transcript.run), (title) => title === mainStageTitle)
    const reads = stageReads(page)
    await openMarkerStage(page, transcript.run, main)

    await context.setOffline(true)
    const restarted = await restartedOnNewDatabase(profile, daemon, () => rm(transcriptFile(profile, session)))
    try {
      expect(await snapshotOf(page.request, transcript.run)).toBeNull()
      const offline = reads.length

      await context.setOffline(false)
      await expect(page.getByRole('heading', { name: 'Прогон не найден' })).toBeVisible()
      const panel = inspector(page)
      await expect(panel).toContainText(goneStage(main))
      await expect(panel.getByRole('heading', { level: 2 })).toHaveText(`Этап ${main.slice(0, 8)}`)
      await expect(panel).not.toContainText('echo review-reset')
      expect(reads.length).toBeGreaterThan(offline)
      const settled = reads.length
      await page.waitForTimeout(quietMs)
      expect(reads).toHaveLength(settled)
    } finally {
      expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
    }
  })
})
