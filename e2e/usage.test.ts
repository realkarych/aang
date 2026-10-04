import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { endpoints, type RunId, type UsageReport } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { sampleScenarioManifest } from '@aang/testkit'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { aangEntry, expect, test } from './fixtures.js'

const originalSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const forkSession = 'cdfb3544-67c1-4590-a4d9-280593b6ed55'
const originalRun = runId({ kind: 'session', runtime: 'claude', session: originalSession })
const forkRun = runId({ kind: 'session', runtime: 'claude', session: forkSession })
const codexRun = runId({ kind: 'session', runtime: 'codex', session: '01a0f752-40a7-76b2-9df9-5b374f75f98f' })
const claudeProject = 'projects/-tmp-aang-spike-cc-transcripts-run'
const forkSample = new URL(
  '../docs/research/samples/claude-code-transcripts/session-cdfb3544-fork-full.jsonl',
  import.meta.url,
)

const codexSample = new URL(
  '../docs/research/samples/codex-cli/rollout/rollout-real-exec-then-resume-with-compaction.jsonl',
  import.meta.url,
)
const legacyThread = '019a0000-0000-7000-8000-000000000009'

const watchAll = { watch: { all: true } }

test.use({ config: watchAll })

const reportOf = async (request: APIRequestContext, run?: RunId): Promise<UsageReport> => {
  const response = await request.get(`${endpoints.usage.path}${run === undefined ? '' : `?run=${run}`}`)
  expect(response.status(), await response.text()).toBe(200)
  return endpoints.usage.response.parse(await response.json())
}

const ledger = (page: Page, title: string): Locator => page.getByRole('region', { name: title, exact: true })

const amounts = (scope: Locator, label: string): Locator =>
  scope
    .getByRole('row')
    .filter({ has: scope.page().getByRole('rowheader', { name: label, exact: true }) })
    .getByRole('cell')

const callFact = (scope: Locator, term: string): Locator =>
  scope
    .locator('dl > div')
    .filter({ has: scope.page().getByRole('term').getByText(term, { exact: true }) })
    .getByRole('definition')

const headFact = (page: Page, term: string): Locator => callFact(page.getByRole('article').locator('header'), term)

const runRows = (page: Page): Locator =>
  page.getByRole('table', { name: 'Расход по прогонам' }).getByRole('row').filter({ has: page.getByRole('cell') })

const session = (page: Page, short: string): Locator =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: `Сессия ${short}`, exact: true }) })

const expectSolverTokens = async (scope: Locator, rows: Record<string, readonly string[]>): Promise<void> => {
  for (const [label, cells] of Object.entries(rows)) {
    await expect(amounts(scope, label)).toHaveText([...cells])
  }
}

const nanosAgo = (minutes: number, plusSeconds = 0): bigint =>
  BigInt(Date.now() - minutes * 60_000 + plusSeconds * 1_000) * 1_000_000n

const callUsage = (cost: number, input: number, read: number, write: number, output: number): string =>
  JSON.stringify({
    model: 'claude-opus-5-5',
    tokens: {
      uncached_input_tokens: input,
      cache_read_input_tokens: read,
      cache_write_input_tokens: write,
      output_tokens: output,
      reasoning_output_tokens: null,
    },
    cost_usd: cost,
  })

const runInput = (run: RunId) => ({ id: run, runtime: 'claude', goal: null, brief: null, sessions: [], agents: [] })

const modelInput = { version: 1, stages: [], criteria: [], attention: [] }

const observerInput = (run: RunId): string =>
  JSON.stringify({
    run: runInput(run),
    context: null,
    model: modelInput,
    batch: { facts: [], collapsed: [], backlog: null, artifact_versions: [] },
    materials: [],
    previous_attempt: null,
  })

const chatInput = (run: RunId): string =>
  JSON.stringify({
    question: 'What is left?',
    history: [],
    run: runInput(run),
    model: modelInput,
    focus: { kind: 'run', attention: [], recent_changes: [] },
    materials: [],
  })

interface StoredCall {
  readonly id: string
  readonly kind: 'batch' | 'probe' | 'chat'
  readonly run: RunId | null
  readonly previous: string | null
  readonly input: string | null
  readonly output: string | null
  readonly verdict: string
  readonly usage: string
  readonly started: bigint
  readonly finished: bigint
  readonly delayMs: number | null
}

const spentCalls = (): StoredCall[] => [
  {
    id: 'h9-batch',
    kind: 'batch',
    run: originalRun,
    previous: null,
    input: observerInput(originalRun),
    output: '{}',
    verdict: 'accepted',
    usage: callUsage(0.25, 100, 2000, 300, 50),
    started: nanosAgo(60),
    finished: nanosAgo(60, 12),
    delayMs: 3_010_000,
  },
  {
    id: 'h9-probe',
    kind: 'probe',
    run: null,
    previous: null,
    input: null,
    output: null,
    verdict: 'accepted',
    usage: callUsage(0.0625, 10, 0, 0, 5),
    started: nanosAgo(40),
    finished: nanosAgo(40, 2),
    delayMs: null,
  },
  {
    id: 'h9-question',
    kind: 'chat',
    run: forkRun,
    previous: null,
    input: chatInput(forkRun),
    output: null,
    verdict: 'needs_requested',
    usage: callUsage(0.03125, 30, 400, 50, 6),
    started: nanosAgo(20),
    finished: nanosAgo(20, 6),
    delayMs: null,
  },
  {
    id: 'h9-answer',
    kind: 'chat',
    run: forkRun,
    previous: 'h9-question',
    input: chatInput(forkRun),
    output: '{}',
    verdict: 'accepted',
    usage: callUsage(0.25, 40, 500, 0, 60),
    started: nanosAgo(20, 7),
    finished: nanosAgo(20, 15),
    delayMs: null,
  },
]

const recordCalls = (aangHome: string): void => {
  const database = new DatabaseSync(join(aangHome, 'aang.db'))
  try {
    const insert = database.prepare(
      `INSERT INTO observer_calls (id, kind, run_id, previous_id, backend, base_version, input, output, verdict, usage,
         started_at, finished_at, delay_ms, change_seq)
       VALUES (?, ?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    for (const call of spentCalls()) {
      insert.run(
        call.id,
        call.kind,
        call.run,
        call.previous,
        call.run === null ? null : 1,
        call.input,
        call.output,
        call.verdict,
        call.usage,
        call.started,
        call.finished,
        call.delayMs,
      )
    }
  } finally {
    database.close()
  }
}

const threadWithoutRecords = async (): Promise<string> =>
  (await readFile(codexSample, 'utf8'))
    .trimEnd()
    .split('\n')
    .flatMap((line) => {
      const record = JSON.parse(line) as { readonly type: string; readonly payload: Record<string, unknown> }
      if (record.type === 'token_usage_record') {
        return []
      }
      return record.type === 'session_meta'
        ? [JSON.stringify({ ...record, payload: { ...record.payload, id: legacyThread, session_id: legacyThread } })]
        : [line]
    })
    .map((line) => `${line}\n`)
    .join('')

const unfinishedReply = async (): Promise<string> => {
  const lines = (await readFile(forkSample, 'utf8')).trimEnd().split('\n')
  const last = lines
    .map((line) => JSON.parse(line) as { type: string; uuid?: string; message?: Record<string, unknown> })
    .findLast(({ type }) => type === 'assistant')
  if (last?.message === undefined) {
    throw new Error('the fork sample has no assistant record')
  }
  const usage = last.message['usage'] as Record<string, unknown>
  return JSON.stringify({
    ...last,
    parentUuid: last.uuid,
    uuid: 'h9-unfinished-reply',
    timestamp: '2026-10-01T11:56:00.000Z',
    message: {
      ...last.message,
      id: 'msg_h9_unfinished_reply',
      content: [{ type: 'text', text: 'Still writing' }],
      stop_reason: null,
      usage: { ...usage, output_tokens: 7 },
    },
  })
}

test('a Claude fork shares its origin without doubling usage, and the usage panel keeps the three journals apart (E2E 11)', async ({
  page,
  player,
  profile,
  daemon,
}) => {
  await (await player(sampleScenarioManifest('claude-fork'), { timeScale: 0 })).play()
  await expect
    .poll(async () => (await reportOf(page.request)).totals.solver.records, { timeout: 30_000 })
    .toBe(7)

  await page.goto('/')
  await page.getByRole('navigation').getByRole('link', { name: 'Расход', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Расход')
  await expect(headFact(page, 'Период')).toHaveText('за всё время')
  await expect(headFact(page, 'Активные часы решателя')).toHaveText('1 активный час')

  const solver = ledger(page, 'Решатель')
  await expect(solver.getByText('7 ответов модели', { exact: true })).toBeVisible()
  await expectSolverTokens(solver, {
    'Ввод без кэша': ['14', '14'],
    'Чтение кэша': ['100 625', '100 625'],
    'Запись в кэш': ['10 415', '10 415'],
    Вывод: ['228', '228'],
  })
  await expect(ledger(page, 'Наблюдатель').getByText('0 вызовов', { exact: true })).toBeVisible()
  await expect(ledger(page, 'Чат').getByText('0 вызовов', { exact: true })).toBeVisible()
  await expect(runRows(page)).toHaveCount(2)
  await expect(runRows(page).nth(0)).toContainText('ввод 92 284, вывод 223')
  await expect(runRows(page).nth(0)).toContainText('6 ответов модели')
  await expect(runRows(page).nth(1)).toContainText('ввод 18 770, вывод 5')
  await expect(runRows(page).nth(1)).toContainText('1 ответ модели')

  const runsRoute = `**${endpoints.runs.path}`
  await page.route(runsRoute, (route) => route.abort('connectionfailed'))
  await runRows(page).nth(1).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${forkRun}$`))
  await expect(page.getByText('Расход прогона', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Общее происхождение/)).toHaveText(
    'Общее происхождение с другими сессиями: унаследованная история здесь не учитывается.',
  )
  await page.unroute(runsRoute)
  const origin = page.getByText(/^Общее происхождение с прогоном/)
  await expect(origin).toContainText('унаследованная история учтена там и здесь не повторяется')
  await expect(ledger(page, 'Решатель').getByText('1 ответ модели', { exact: true })).toBeVisible()
  const fork = session(page, 'cdfb3544')
  await expect(fork.getByRole('columnheader')).toHaveText(['Учтено aang', 'Итог Claude Code'])
  await expectSolverTokens(fork, {
    'Ввод без кэша': ['2', '14'],
    'Чтение кэша': ['18 341', '100 625'],
    'Запись в кэш': ['427', '10 415'],
    Вывод: ['5', '228'],
    'Ответов модели': ['1', '—'],
    Деньги: ['—', '0,1026 $'],
  })
  await expect(fork.getByRole('listitem')).toHaveText([
    'Итог окончательный: Claude Code записал его, когда запуск завершился.',
    'Итог Claude Code включает историю, унаследованную при ответвлении; aang учитывает её в исходном прогоне.',
  ])
  const stages = page.getByRole('table', { name: 'Решатель по этапам' })
  await expect(page.getByText(/пока карты нет, весь расход решателя не привязан\.$/)).toBeVisible()
  await expect(amounts(stages, 'Не привязано к этапам')).toHaveText(['2', '18 341', '427', '5', '1'])

  await origin.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${originalRun}$`))
  await expect(page.getByText(/^Общее происхождение/)).toHaveCount(0)
  const original = session(page, '86f93ed5')
  await expectSolverTokens(original, {
    'Ввод без кэша': ['12', '12'],
    'Чтение кэша': ['82 284', '82 284'],
    'Запись в кэш': ['9 988', '9 988'],
    Вывод: ['223', '223'],
    'Ответов модели': ['6', '—'],
    Деньги: ['—', '0,0954 $'],
  })
  await expect(original.getByRole('listitem')).toHaveText([
    'Итог окончательный: Claude Code записал его, когда запуск завершился.',
  ])
  await expect(page.getByText(/^Деньги — по прейскуранту/)).toHaveText(
    'Деньги — по прейскуранту, как их сообщает рантайм; при подписке это не списание. Codex сообщает только токены.',
  )

  expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
  await expect(page.getByRole('status')).toHaveText(
    'Не удалось обновить отчёт о расходе. Показаны прежние данные, они могут устареть.',
    { timeout: 15_000 },
  )
  recordCalls(profile.aangHome)
  await profile.configure({ ...watchAll, collector: { rootsScanIntervalMs: 250 }, api: { port: daemon.api.port } })
  const restarted = await profile.startDaemon({ entry: aangEntry })
  expect(restarted.url).toBe(daemon.url)

  await page.getByRole('navigation').getByRole('link', { name: 'Расход', exact: true }).click()
  const observer = ledger(page, 'Наблюдатель')
  await expect(observer.getByText('1 вызов и 1 проверка допуска', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('status')).toHaveCount(0)
  await expectSolverTokens(observer, {
    'Ввод без кэша': ['110', '110'],
    'Чтение кэша': ['2 000', '2 000'],
    'Запись в кэш': ['300', '300'],
    Вывод: ['55', '55'],
  })
  await expect(amounts(observer, 'Деньги').first()).toHaveText('0,3125 $')
  await expect(callFact(observer, 'Задержка вызова')).toHaveText('медиана 12,0 с, p95 12,0 с, максимум 12,0 с')
  await expect(callFact(observer, 'Отставание карты')).toHaveText(
    'медиана 50 мин 10 с, p95 50 мин 10 с, максимум 50 мин 10 с',
  )
  await expect(callFact(observer, 'Проверки допуска')).toHaveText('1 вызов вне прогонов: ввод 10, вывод 5, 0,0625 $')
  const chat = ledger(page, 'Чат')
  await expect(chat.getByText('1 вызов', { exact: true })).toBeVisible()
  await expectSolverTokens(chat, {
    'Ввод без кэша': ['70', '70'],
    Вывод: ['66', '66'],
    Деньги: ['0,2813 $', '0,2813 $'],
  })
  await expect(callFact(chat, 'Задержка ответа')).toHaveText('медиана 15,0 с, p95 15,0 с, максимум 15,0 с')
  await expect(ledger(page, 'Решатель').getByText('7 ответов модели', { exact: true })).toBeVisible()

  await page.getByRole('navigation', { name: 'Период' }).getByRole('link', { name: '24 часа' }).click()
  await expect(page).toHaveURL(/\?view=usage&period=day$/)
  await expect(headFact(page, 'Период')).toHaveText(/^с /)
  await expect(headFact(page, 'Активные часы решателя')).toHaveText('нет: расход на активный час не считается')
  await expect(ledger(page, 'Решатель').getByText('0 ответов модели', { exact: true })).toBeVisible()
  await expect(amounts(ledger(page, 'Решатель'), 'Вывод')).toHaveText(['0'])
  await expect(amounts(ledger(page, 'Наблюдатель'), 'Вывод')).toHaveText(['55'])
  await expect(amounts(ledger(page, 'Чат'), 'Вывод')).toHaveText(['66'])
  await expect(runRows(page)).toHaveCount(2)
  await expect(runRows(page).nth(0)).toContainText('нет активности решателя')
  await expect(runRows(page).nth(0)).toContainText('ввод 2 400, вывод 50, 0,25 $')
  await expect(runRows(page).nth(1)).toContainText('ввод 1 020, вывод 66, 0,2813 $')

  await runRows(page).nth(1).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${forkRun}&period=day$`))
  await expect(headFact(page, 'Длительность')).toHaveText('нет активности решателя')
  await expect(page.getByText(/^Итог Claude Code и итог треда относятся/)).toHaveText(
    'Итог Claude Code и итог треда относятся ко всей сессии или треду, а не только к выбранному периоду.',
  )
  await expect(ledger(page, 'Чат').getByText('1 вызов', { exact: true })).toBeVisible()
  await expect(ledger(page, 'Наблюдатель').getByText('0 вызовов', { exact: true })).toBeVisible()
  expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
})

test('a Claude total waits for the exit, and a reply without its closing record makes the output a lower bound', async ({
  page,
  player,
  profile,
}) => {
  const sample = await player(sampleScenarioManifest('claude-fork'), { timeScale: 0 })
  await sample.play({ until: 'subagent' })
  await expect
    .poll(async () => (await reportOf(page.request)).totals.solver.records, { timeout: 30_000 })
    .toBeGreaterThan(0)

  await page.goto(`/?run=${originalRun}`)
  await page.getByRole('article').getByRole('link', { name: 'три журнала' }).click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${originalRun}$`))
  const original = session(page, '86f93ed5')
  await expect(original.getByRole('columnheader')).toHaveText(['Учтено aang'])
  await expect(original.getByRole('listitem')).toHaveText([
    'Итога Claude Code пока нет: интерактивная сессия записывает его только при выходе. До выхода нет денег и расхода на сжатие контекста.',
  ])
  await expect(page.getByText(/^Деньги — по прейскуранту/)).toHaveCount(0)

  await sample.play()
  await expect(original.getByRole('columnheader')).toHaveText(['Учтено aang', 'Итог Claude Code'], {
    timeout: 15_000,
  })

  await page.getByRole('navigation', { name: 'Навигация' }).getByRole('link', { name: 'Расход', exact: true }).click()
  await expect(runRows(page)).toHaveCount(2, { timeout: 15_000 })
  await runRows(page).nth(1).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${forkRun}$`))
  const fork = session(page, 'cdfb3544')
  await expect(amounts(fork, 'Вывод')).toHaveText(['5', '228'])
  await appendFile(join(profile.claude, claudeProject, `${forkSession}.jsonl`), `${await unfinishedReply()}\n`)
  await expect(amounts(fork, 'Вывод')).toHaveText(['не меньше 12', '228'], { timeout: 15_000 })
  await expect(fork.getByRole('listitem').first()).toHaveText(
    'Итог промежуточный: сессия продолжилась после его записи, Claude Code обновит итог при выходе.',
  )
  await expect(amounts(ledger(page, 'Решатель'), 'Вывод').first()).toHaveText('не меньше 12')
  await expect(page.getByText(/^«Не меньше»/)).toHaveText(
    '«Не меньше» — нижняя оценка вывода: у части ответов нет завершающей записи, и модель могла вывести больше.',
  )
})

test('a Codex run reports tokens only and a thread without usage records its thread total; an unknown run is not found, and a failed report request is retried', async ({
  page,
  player,
  profile,
}) => {
  await page.route(`**${endpoints.usage.path}*`, (route) => route.abort('connectionfailed'))
  await page.goto(`/?view=usage&run=${'0'.repeat(32)}`)
  await expect(page.getByRole('heading', { name: 'Прогон не найден' })).toBeVisible()

  await page.getByRole('navigation', { name: 'Навигация' }).getByRole('link', { name: 'Расход', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Не удалось загрузить отчёт о расходе. aang повторяет запрос.')
  await page.unrouteAll()
  await expect(page.getByText('За этот период нет ни активности решателя, ни вызовов наблюдателя и чата.')).toBeVisible(
    { timeout: 15_000 },
  )

  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
  await expect
    .poll(async () => (await reportOf(page.request)).totals.solver.records, { timeout: 30_000 })
    .toBeGreaterThan(0)
  const [usage] = (await reportOf(page.request, codexRun)).runs
  const output = new Intl.NumberFormat('ru').format(usage?.solver.totals.tokens.output_tokens ?? -1)

  await expect(runRows(page)).toHaveCount(1, { timeout: 15_000 })
  await runRows(page).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${codexRun}$`))
  await expect(page.getByRole('article').locator('header').getByText('Codex', { exact: true })).toBeVisible()
  const codex = session(page, '01a0f752')
  await expect(codex.getByRole('columnheader')).toHaveText(['Учтено aang'])
  await expect(amounts(codex, 'Вывод')).toHaveText([output])
  await expect(codex.getByRole('listitem')).toHaveCount(0)
  await expect(page.getByText(/^Деньги — по прейскуранту/)).toHaveCount(0)

  const rollout = `sessions/2026/10/01/rollout-2026-10-01T12-00-00-${legacyThread}.jsonl`
  await profile.write('codex', rollout, await threadWithoutRecords())
  await page.getByRole('navigation', { name: 'Навигация' }).getByRole('link', { name: 'Расход', exact: true }).click()
  await expect(runRows(page)).toHaveCount(2, { timeout: 15_000 })
  await runRows(page).filter({ hasNotText: 'ответ' }).getByRole('link').click()
  const legacy = session(page, legacyThread.slice(0, 8))
  await expect(legacy.getByRole('columnheader')).toHaveText(['Учтено aang', 'Итог треда'])
  await expectSolverTokens(legacy, {
    'Ввод без кэша': ['0', '4 366'],
    'Чтение кэша': ['0', '38 656'],
    'Запись в кэш': ['0', '0'],
    Вывод: ['0', '38'],
  })
  await expect(legacy.getByRole('listitem')).toHaveText([
    'Итог треда — накопительный итог Codex для треда без записей usage; журнал решателя его не включает.',
  ])
})
