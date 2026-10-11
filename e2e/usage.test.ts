import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import {
  type ActionId,
  type Adapter,
  type CreateBindingRequest,
  EpochNs,
  endpoints,
  LinkId,
  type RunId,
  type Runtime,
  StageId,
  type SurfaceClaim,
  type UsageReport,
} from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { applyChangeSet, createEngine } from '@aang/engine'
import { openStore } from '@aang/store'
import { type Profile, type RunningDaemon, sampleScenarioManifest } from '@aang/testkit'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { aangEntry, expect, getWithoutKeepAlive, test } from './fixtures.js'

const originalSession = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const forkSession = 'cdfb3544-67c1-4590-a4d9-280593b6ed55'
const secondForkSession = 'f2f2f2f2-67c1-4590-a4d9-280593b6ed55'
const codexSession = '01a0f752-40a7-76b2-9df9-5b374f75f98f'
const originalRun = runId({ kind: 'session', runtime: 'claude', session: originalSession })
const forkRun = runId({ kind: 'session', runtime: 'claude', session: forkSession })
const secondForkRun = runId({ kind: 'session', runtime: 'claude', session: secondForkSession })
const codexRun = runId({ kind: 'session', runtime: 'codex', session: codexSession })
const claudeProject = 'projects/-tmp-aang-spike-cc-transcripts-run'
const claudeCwd = '/tmp/aang-spike/cc-transcripts/run'
const transcriptOf = (session: string): string => `${claudeProject}/${session}.jsonl`
const originalSample = new URL(
  '../docs/research/samples/claude-code-transcripts/session-86f93ed5-main-full.jsonl',
  import.meta.url,
)
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

const usageLink = (run: RunId): string => `?view=usage&run=${run}`

const finalTotal = 'Final total: Claude Code wrote it when the launch ended.'
const continuedTotal = 'Interim total: the session continued after it was written; Claude Code will update it on exit.'
const inheritedTotal = 'The Claude Code total includes history inherited on fork; "Counted by aang" does not.'
const desktopSummaries =
  'Usage of the Claude Desktop summary helper model is unavailable: its calls are visible only in the Desktop engine stream, which aang does not read. Whether this usage is part of the Claude Code total is unknown.'
const guessedSource =
  /^Common origin\. Likely source: run .+\. Among visible sessions only it holds the same history, but it may be a fork too\. Inherited history is not counted here\.$/
const unsettledSource =
  /^Common origin with runs .+, .+; source unknown\. Inherited history is not counted here\.$/

test.use({ config: watchAll })

const reportOf = async (request: APIRequestContext, run?: RunId): Promise<UsageReport> => {
  const response = await getWithoutKeepAlive(
    request,
    `${endpoints.usage.path}${run === undefined ? '' : `?run=${run}`}`,
  )
  expect(response.status(), await response.text()).toBe(200)
  return endpoints.usage.response.parse(await response.json())
}

const surfacesOf = async (request: APIRequestContext, run: RunId): Promise<(SurfaceClaim | null)[] | null> => {
  const response = await getWithoutKeepAlive(request, endpoints.run.path.replace(':run', run))
  return response.ok()
    ? endpoints.run.response.parse(await response.json()).objects.sessions.map(({ surface }) => surface)
    : null
}

const restart = async (daemon: RunningDaemon, profile: Profile): Promise<RunningDaemon> => {
  await profile.configure({ ...watchAll, collector: { rootsScanIntervalMs: 250 }, api: { port: daemon.api.port } })
  const restarted = await profile.startDaemon({ entry: aangEntry })
  expect(restarted.url).toBe(daemon.url)
  return restarted
}

const stopped = async (daemon: RunningDaemon): Promise<void> => {
  expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
}

const adapters = new Map<Runtime, Adapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
])

const bindSessions = async (aangHome: string, requests: readonly CreateBindingRequest[]): Promise<void> => {
  const store = openStore({ home: aangHome })
  const engine = createEngine({ store, adapters, watch: { all: true, roots: [] }, fsWatch: false })
  try {
    for (const request of requests) {
      await engine.bind(request)
    }
  } finally {
    await engine.close()
    store.close()
  }
}

const assignStage = (aangHome: string, run: RunId, title: string, actions: readonly ActionId[]): void => {
  const store = openStore({ home: aangHome })
  const stage = StageId.parse(`stage-${randomUUID()}`)
  const observed = { kind: 'observed' } as const
  try {
    store.transaction((transaction) =>
      applyChangeSet(transaction, {
        run,
        author: 'rule',
        at: EpochNs.parse(BigInt(Date.now()) * 1_000_000n),
        changes: [
          {
            op: 'stage.create',
            put: {
              kind: 'stage',
              value: {
                id: stage,
                run,
                title,
                expected_result: null,
                summary: null,
                parent: null,
                origin: 'inferred',
                lifecycle: { state: 'active' },
                execution: { value: { state: 'running' }, basis: observed, evidence: [] },
                execution_claim: null,
                decision: { value: 'none', basis: observed, evidence: [] },
                session_moved: false,
                basis: observed,
                evidence: [],
              },
            },
            basis: observed,
            evidence: [],
          },
          ...actions.map((action) => ({
            op: 'actions.assign' as const,
            put: {
              kind: 'link' as const,
              value: {
                id: LinkId.parse(`assign-${action}-${stage}`),
                run,
                kind: 'assignment' as const,
                action,
                stage,
                basis: observed,
                evidence: [],
              },
            },
            basis: observed,
            evidence: [],
          })),
        ],
      }),
    )
  } finally {
    store.close()
  }
}

const desktopStart = async (directory: string, profile: Profile, session: string): Promise<string> => {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'session-start.json'),
    JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: session,
      transcript_path: join(profile.claude, transcriptOf(session)),
      cwd: claudeCwd,
      source: 'resume',
    }),
  )
  const manifest = join(directory, 'manifest.json')
  await writeFile(
    manifest,
    JSON.stringify({
      steps: [
        {
          at: 0,
          kind: 'hook',
          runtime: 'claude',
          registration: 'plugin',
          env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
          source: 'session-start.json',
        },
      ],
    }),
  )
  return manifest
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
  page.getByRole('table', { name: 'Usage by run' }).getByRole('row').filter({ has: page.getByRole('cell') })

const session = (page: Page, short: string): Locator =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: `Session ${short}`, exact: true }) })

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

const codexResponses = async (): Promise<number> =>
  (await readFile(codexSample, 'utf8'))
    .trimEnd()
    .split('\n')
    .filter((line) => (JSON.parse(line) as { readonly type: string }).type === 'token_usage_record').length

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

const secondFork = async (): Promise<string> => {
  const lines = (await readFile(forkSample, 'utf8')).trimEnd().split('\n')
  const records = lines.map(
    (line) => JSON.parse(line) as { readonly type: string; readonly uuid?: string; readonly timestamp?: string },
  )
  const launch = records.find(({ type }) => type === 'queue-operation')?.timestamp ?? ''
  const ownFrom = records.findIndex(({ uuid, timestamp }) => uuid !== undefined && (timestamp ?? '') >= launch)
  if (launch === '' || ownFrom < 0) {
    throw new Error('the fork sample has no records of its own launch')
  }
  const renamed = new Map(records.slice(ownFrom).flatMap(({ uuid }) => (uuid === undefined ? [] : [[uuid, randomUUID()]])))
  return lines
    .map((line, index) =>
      index < ownFrom
        ? line
        : [...renamed].reduce((text, [from, to]) => text.replaceAll(from, to), line).replaceAll('"msg_', '"msg_h9_'),
    )
    .map((line) => `${line.replaceAll(forkSession, secondForkSession)}\n`)
    .join('')
}

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

test.describe('with the LLM unavailable', () => {
  test.use({ claudeScenario: { loggedIn: false }, codexScenario: { loggedIn: false } })

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
    await page.getByRole('navigation').getByRole('link', { name: 'Usage', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Usage')
    await expect(headFact(page, 'Period')).toHaveText('for all time')
    await expect(headFact(page, 'Solver active hours')).toHaveText('1 active hour')

    const solver = ledger(page, 'Solver')
    await expect(solver.getByText('7 model responses', { exact: true })).toBeVisible()
    await expectSolverTokens(solver, {
      'Uncached input': ['14', '14'],
      'Cache read': ['100,625', '100,625'],
      'Cache write': ['10,415', '10,415'],
      Output: ['228', '228'],
    })
    await expect(ledger(page, 'Observer').getByText('0 calls', { exact: true })).toBeVisible()
    await expect(ledger(page, 'Chat').getByText('0 calls', { exact: true })).toBeVisible()
    await expect(runRows(page)).toHaveCount(2)
    await expect(runRows(page).nth(0)).toContainText('input 92,284, output 223')
    await expect(runRows(page).nth(0)).toContainText('6 model responses')
    await expect(runRows(page).nth(1)).toContainText('input 18,770, output 5')
    await expect(runRows(page).nth(1)).toContainText('1 model response')

    const runsRoute = `**${endpoints.runs.path}`
    await page.route(runsRoute, (route) => route.abort('connectionfailed'))
    await runRows(page).nth(1).getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${forkRun}$`))
    await expect(page.getByText('Run usage', { exact: true })).toBeVisible()
    const origin = page.getByText(/^Common origin/)
    await expect(origin).toHaveText(
      'Common origin with other sessions. Inherited history is not counted here.',
    )
    await page.unroute(runsRoute)
    await expect(origin).toHaveText(guessedSource)
    await expect(origin.getByRole('link')).toHaveAttribute('href', usageLink(originalRun))
    await expect(ledger(page, 'Solver').getByText('1 model response', { exact: true })).toBeVisible()
    const fork = session(page, 'cdfb3544')
    await expect(fork.getByRole('columnheader')).toHaveText(['Counted by aang', 'Claude Code total'])
    await expectSolverTokens(fork, {
      'Uncached input': ['2', '14'],
      'Cache read': ['18,341', '100,625'],
      'Cache write': ['427', '10,415'],
      Output: ['5', '228'],
      'Model responses': ['1', '—'],
      Money: ['—', '$0.1026'],
    })
    await expect(fork.getByRole('listitem')).toHaveText([finalTotal, inheritedTotal])
    const stages = page.getByRole('table', { name: 'Solver by stage' })
    await expect(page.getByText(/until there is a map, all solver usage is unassigned\.$/)).toBeVisible()
    await expect(amounts(stages, 'Not assigned to stages')).toHaveText(['2', '18,341', '427', '5', '1'])

    await origin.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${originalRun}$`))
    await expect(page.getByText(/^Common origin/)).toHaveCount(0)
    const original = session(page, '86f93ed5')
    await expectSolverTokens(original, {
      'Uncached input': ['12', '12'],
      'Cache read': ['82,284', '82,284'],
      'Cache write': ['9,988', '9,988'],
      Output: ['223', '223'],
      'Model responses': ['6', '—'],
      Money: ['—', '$0.0954'],
    })
    await expect(original.getByRole('listitem')).toHaveText([finalTotal])
    await expect(page.getByText(/^Money is at list price/)).toHaveText(
      'Money is at list price, as the runtime reports it; under a subscription it is not a charge. Codex reports only tokens.',
    )

    await stopped(daemon)
    await expect(page.getByRole('status')).toHaveText(
      'Could not refresh the usage report. Showing earlier data, which may be stale.',
      { timeout: 15_000 },
    )
    recordCalls(profile.aangHome)
    const restarted = await restart(daemon, profile)

    await page.getByRole('navigation').getByRole('link', { name: 'Usage', exact: true }).click()
    const observer = ledger(page, 'Observer')
    await expect(observer.getByText('1 call and 1 admission probe', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('status')).toHaveCount(0)
    await expectSolverTokens(observer, {
      'Uncached input': ['110', '110'],
      'Cache read': ['2,000', '2,000'],
      'Cache write': ['300', '300'],
      Output: ['55', '55'],
    })
    await expect(amounts(observer, 'Money').first()).toHaveText('$0.3125')
    await expect(callFact(observer, 'Call latency')).toHaveText('median 12.0 s, p95 12.0 s, max 12.0 s')
    await expect(callFact(observer, 'Map lag')).toHaveText(
      'median 50 min 10 s, p95 50 min 10 s, max 50 min 10 s',
    )
    await expect(callFact(observer, 'Admission probes')).toHaveText('1 call outside runs: input 10, output 5, $0.0625')
    const chat = ledger(page, 'Chat')
    await expect(chat.getByText('1 call', { exact: true })).toBeVisible()
    await expectSolverTokens(chat, {
      'Uncached input': ['70', '70'],
      Output: ['66', '66'],
      Money: ['$0.2813', '$0.2813'],
    })
    await expect(callFact(chat, 'Response latency')).toHaveText('median 15.0 s, p95 15.0 s, max 15.0 s')
    await expect(ledger(page, 'Solver').getByText('7 model responses', { exact: true })).toBeVisible()

    await page.getByRole('navigation', { name: 'Period' }).getByRole('link', { name: '24 hours' }).click()
    await expect(page).toHaveURL(/\?view=usage&period=day$/)
    await expect(headFact(page, 'Period')).toHaveText(/^since /)
    await expect(headFact(page, 'Solver active hours')).toHaveText('none: per-active-hour usage is not computed')
    await expect(ledger(page, 'Solver').getByText('0 model responses', { exact: true })).toBeVisible()
    await expect(amounts(ledger(page, 'Solver'), 'Output')).toHaveText(['0'])
    await expect(amounts(ledger(page, 'Observer'), 'Output')).toHaveText(['55'])
    await expect(amounts(ledger(page, 'Chat'), 'Output')).toHaveText(['66'])
    await expect(runRows(page)).toHaveCount(2)
    await expect(runRows(page).nth(0)).toContainText('no solver activity')
    await expect(runRows(page).nth(0)).toContainText('input 2,400, output 50, $0.25')
    await expect(runRows(page).nth(1)).toContainText('input 1,020, output 66, $0.2813')

    await runRows(page).nth(1).getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${forkRun}&period=day$`))
    await expect(headFact(page, 'Duration')).toHaveText('no solver activity')
    await expect(page.getByText(/^The Claude Code total and the thread total cover/)).toHaveText(
      'The Claude Code total and the thread total cover the whole session or thread, not just the selected period.',
    )
    await expect(ledger(page, 'Chat').getByText('1 call', { exact: true })).toBeVisible()
    await expect(ledger(page, 'Observer').getByText('0 calls', { exact: true })).toBeVisible()
    await stopped(restarted)
  })
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
  await page.getByRole('article').getByRole('link', { name: 'three journals' }).click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${originalRun}$`))
  const original = session(page, '86f93ed5')
  await expect(original.getByRole('columnheader')).toHaveText(['Counted by aang'])
  await expect(original.getByRole('listitem')).toHaveText([
    'No Claude Code total yet: an interactive session writes it only on exit. Until then there is no money and no context compaction usage.',
  ])
  await expect(page.getByText(/^Money is at list price/)).toHaveCount(0)

  await sample.play()
  await expect(original.getByRole('columnheader')).toHaveText(['Counted by aang', 'Claude Code total'], {
    timeout: 15_000,
  })

  await page.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: 'Usage', exact: true }).click()
  await expect(runRows(page)).toHaveCount(2, { timeout: 15_000 })
  await runRows(page).nth(1).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${forkRun}$`))
  const fork = session(page, 'cdfb3544')
  await expect(amounts(fork, 'Output')).toHaveText(['5', '228'])
  await appendFile(join(profile.claude, claudeProject, `${forkSession}.jsonl`), `${await unfinishedReply()}\n`)
  await expect(amounts(fork, 'Output')).toHaveText(['at least 12', '228'], { timeout: 15_000 })
  await expect(fork.getByRole('listitem').first()).toHaveText(continuedTotal)
  await expect(amounts(ledger(page, 'Solver'), 'Output').first()).toHaveText('at least 12')
  await expect(page.getByText(/^"At least"/)).toHaveText(
    '"At least" is a lower bound on output: some responses have no final record, and the model may have produced more.',
  )
})

test('a Codex run reports tokens only and a thread without usage records its thread total; an unknown run is not found, and a failed report request is retried', async ({
  page,
  player,
  profile,
}) => {
  await page.route(`**${endpoints.usage.path}*`, (route) => route.abort('connectionfailed'))
  await page.goto(`/?view=usage&run=${'0'.repeat(32)}`)
  await expect(page.getByRole('heading', { name: 'Run not found' })).toBeVisible()

  await page.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: 'Usage', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Could not load the usage report. aang keeps retrying.')
  await page.unrouteAll()
  await expect(page.getByText('No solver activity and no observer or chat calls in this period.')).toBeVisible(
    { timeout: 15_000 },
  )

  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
  const responses = await codexResponses()
  await expect
    .poll(async () => (await reportOf(page.request)).totals.solver.records, { timeout: 30_000 })
    .toBe(responses)
  const [usage] = (await reportOf(page.request, codexRun)).runs
  const output = new Intl.NumberFormat('en-US').format(usage?.solver.totals.tokens.output_tokens ?? -1)

  await expect(runRows(page)).toHaveCount(1, { timeout: 15_000 })
  await runRows(page).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${codexRun}$`))
  await expect(page.getByRole('article').locator('header').getByText('Codex', { exact: true })).toBeVisible()
  const codex = session(page, '01a0f752')
  await expect(codex.getByRole('columnheader')).toHaveText(['Counted by aang'])
  await expect(amounts(codex, 'Output')).toHaveText([output])
  await expect(codex.getByRole('listitem')).toHaveCount(0)
  await expect(page.getByText(/^Money is at list price/)).toHaveCount(0)

  const rollout = `sessions/2026/10/01/rollout-2026-10-01T12-00-00-${legacyThread}.jsonl`
  await profile.write('codex', rollout, await threadWithoutRecords())
  await page.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: 'Usage', exact: true }).click()
  await expect(runRows(page)).toHaveCount(2, { timeout: 15_000 })
  await runRows(page).filter({ hasNotText: 'response' }).getByRole('link').click()
  const legacy = session(page, legacyThread.slice(0, 8))
  await expect(legacy.getByRole('columnheader')).toHaveText(['Counted by aang', 'Thread total'])
  await expectSolverTokens(legacy, {
    'Uncached input': ['0', '4,366'],
    'Cache read': ['0', '38,656'],
    'Cache write': ['0', '0'],
    Output: ['0', '38'],
  })
  await expect(legacy.getByRole('listitem')).toHaveText([
    'Thread total is the cumulative Codex total for a thread without usage records; the solver journal does not include it.',
  ])
})

test('two Claude forks of an unseen session name each other only as a guessed source, and the original arriving later leaves the source open', async ({
  page,
  profile,
}) => {
  await profile.write('claude', transcriptOf(forkSession), await readFile(forkSample, 'utf8'))
  await expect
    .poll(async () => (await reportOf(page.request)).totals.solver.records, { timeout: 30_000 })
    .toBe(1)

  await page.goto(`/${usageLink(forkRun)}`)
  const origin = page.getByText(/^Common origin/)
  await expect(origin).toHaveText(
    'Common origin: aang does not see sessions with the same history yet. Inherited history is not counted here.',
  )

  await profile.write('claude', transcriptOf(secondForkSession), await secondFork())
  await expect(origin).toHaveText(guessedSource, { timeout: 15_000 })
  await expect(origin.getByRole('link')).toHaveAttribute('href', usageLink(secondForkRun))
  await expect(ledger(page, 'Solver').getByText('1 model response', { exact: true })).toBeVisible()
  const fork = session(page, 'cdfb3544')
  await expect(amounts(fork, 'Output')).toHaveText(['5', '228'])
  await expect(fork.getByRole('listitem')).toHaveText([finalTotal, inheritedTotal])

  await origin.getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${secondForkRun}$`))
  await expect(origin).toHaveText(guessedSource)
  await expect(origin.getByRole('link')).toHaveAttribute('href', usageLink(forkRun))
  const second = session(page, secondForkSession.slice(0, 8))
  await expect(amounts(second, 'Output')).toHaveText(['5', '228'])
  await expect(second.getByRole('listitem')).toHaveText([finalTotal, inheritedTotal])

  await profile.write('claude', transcriptOf(originalSession), await readFile(originalSample, 'utf8'))
  await expect(origin).toHaveText(unsettledSource, { timeout: 15_000 })
  await expect(origin.getByRole('link')).toHaveCount(2)
  for (const relative of [forkRun, originalRun]) {
    await expect(origin.locator(`a[href="${usageLink(relative)}"]`)).toHaveCount(1)
  }
  await expect(ledger(page, 'Solver').getByText('1 model response', { exact: true })).toBeVisible()
  await expect(amounts(second, 'Output')).toHaveText(['5', '228'])
})

test('a fork parent named by the user takes precedence over the guessed source', async ({
  page,
  player,
  profile,
  daemon,
}) => {
  await (await player(sampleScenarioManifest('claude-fork'), { timeScale: 0 })).play()
  await expect
    .poll(async () => (await reportOf(page.request)).totals.solver.records, { timeout: 30_000 })
    .toBe(7)

  await stopped(daemon)
  await bindSessions(profile.aangHome, [
    {
      kind: 'fork_parent',
      run: forkRun,
      parent: objectId({ kind: 'session', runtime: 'claude', session: originalSession }),
    },
  ])
  const restarted = await restart(daemon, profile)

  const runsRoute = `**${endpoints.runs.path}`
  await page.route(runsRoute, (route) => route.abort('connectionfailed'))
  await page.goto(`/${usageLink(forkRun)}`)
  const origin = page.getByText(/^Forked from/)
  await expect(origin).toHaveText('Forked from another run. Inherited history is not counted here.')
  await page.unroute(runsRoute)
  await expect(origin).toHaveText(/^Forked from run .+\. Inherited history is not counted here\.$/)
  await expect(origin.getByRole('link')).toHaveAttribute('href', usageLink(originalRun))
  await expect(page.getByText(/^Common origin/)).toHaveCount(0)
  await stopped(restarted)
})

test('session notes follow the runtime and surface of the session itself: Claude and Codex sessions attached across runtimes, a Claude Desktop session', async ({
  page,
  player,
  profile,
  daemon,
}) => {
  await (await player(sampleScenarioManifest('claude-fork'), { timeScale: 0 })).play()
  await (await player(sampleScenarioManifest('codex-resume-compaction'), { timeScale: 0 })).play()
  await (await player(await desktopStart(test.info().outputPath('desktop'), profile, forkSession))).play()
  await expect
    .poll(async () => surfacesOf(page.request, forkRun), { timeout: 30_000 })
    .toEqual([{ surface: 'claude_desktop', basis: 'observed' }])
  await expect
    .poll(
      async () => {
        const { runs } = await reportOf(page.request)
        return [originalRun, forkRun, codexRun].filter((run) =>
          runs.some((usage) => usage.run === run && usage.solver.totals.records > 0),
        )
      },
      { timeout: 30_000 },
    )
    .toEqual([originalRun, forkRun, codexRun])

  await stopped(daemon)
  await bindSessions(profile.aangHome, [
    { kind: 'attach', session: objectId({ kind: 'session', runtime: 'claude', session: originalSession }), run: codexRun },
    { kind: 'attach', session: objectId({ kind: 'session', runtime: 'codex', session: codexSession }), run: forkRun },
  ])
  const restarted = await restart(daemon, profile)

  await page.goto(`/${usageLink(codexRun)}`)
  await expect(page.getByRole('article').locator('header').getByText('Codex', { exact: true })).toBeVisible()
  const original = session(page, '86f93ed5')
  await expect(original.getByRole('columnheader')).toHaveText(['Counted by aang', 'Claude Code total'])
  await expectSolverTokens(original, {
    Output: ['223', '223'],
    'Model responses': ['6', '—'],
    Money: ['—', '$0.0954'],
  })
  await expect(original.getByRole('listitem')).toHaveText([finalTotal])
  await expect(session(page, codexSession.slice(0, 8))).toHaveCount(0)

  await page.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: 'Usage', exact: true }).click()
  await page.locator(`a[href="${usageLink(forkRun)}"]`).click()
  await expect(page).toHaveURL(new RegExp(`\\?view=usage&run=${forkRun}$`))
  const codex = session(page, codexSession.slice(0, 8))
  await expect(codex.getByRole('columnheader')).toHaveText(['Counted by aang'])
  await expect(codex.getByRole('listitem')).toHaveCount(0)
  const fork = session(page, 'cdfb3544')
  await expect(fork.getByRole('columnheader')).toHaveText(['Counted by aang', 'Claude Code total'])
  await expect(fork.getByRole('listitem')).toHaveText([continuedTotal, inheritedTotal, desktopSummaries])
  await stopped(restarted)
})

test('the solver journal of a run splits into the exact usage of its stages and the unassigned rest', async ({
  page,
  player,
  profile,
  daemon,
}) => {
  await (await player(sampleScenarioManifest('claude-fork'), { timeScale: 0 })).play()
  await expect
    .poll(async () => (await reportOf(page.request)).totals.solver.records, { timeout: 30_000 })
    .toBe(7)

  await stopped(daemon)
  assignStage(profile.aangHome, originalRun, 'Environment check', [
    objectId({ kind: 'action', runtime: 'claude', session: originalSession, call: 'toolu_017B7FeHZ4yDzFdvKQMwDJB8' }),
  ])
  const restarted = await restart(daemon, profile)

  await page.goto(`/${usageLink(originalRun)}`)
  await expect(ledger(page, 'Solver').getByText('6 model responses', { exact: true })).toBeVisible()
  const stages = page.getByRole('table', { name: 'Solver by stage' })
  await expect(stages.getByRole('columnheader')).toHaveText([
    'Stage',
    'Uncached input',
    'Cache read',
    'Cache write',
    'Output',
    'Model responses',
  ])
  await expect(stages.getByRole('rowheader')).toHaveText(['Environment check', 'Not assigned to stages'])
  await expect(amounts(stages, 'Environment check')).toHaveText(['2', '10,341', '7,337', '74', '1'])
  await expect(amounts(stages, 'Not assigned to stages')).toHaveText(['10', '71,943', '2,651', '149', '5'])
  await stopped(restarted)
})
