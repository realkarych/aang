import { readdir, readFile, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type AppliedViewRule,
  type AttentionItem,
  endpoints,
  type RawRecord,
  type RunSnapshot,
  type ViewRuleSpec,
} from '@aang/contract'
import { aangHomePaths } from '@aang/contract/home'
import { loadManifest, type Profile, type RunningDaemon, sampleScenarioManifest } from '@aang/testkit'
import type { APIRequestContext } from '@playwright/test'
import { aangEntry, expect, getWithoutKeepAlive, type HookFields, type HookSamples, test } from './fixtures.js'
import { claudeFork, claudeOriginal, hookFields, runOf, sessionFile } from './samples.js'
import { change, fact, lamp, mark, markButton, runRowOf, since, sinceTab, stepsOf, zone, zoneItem } from './screens.js'

const run = runOf(claudeOriginal)

const scenario = sampleScenarioManifest('claude-fork')

const lookbackDays = 1

const day = 86_400_000

const subagent = 'aad616394e806288d'

const formatQuestion = 'Какой формат выбрать?'

const downtimeQuestion = 'Публиковать отчёт после перезапуска?'

const approvalText = 'Bash: touch probe-perm.txt'

const reconnected = { timeout: 20_000 }

const checks = [
  { id: 'toolu_h10_check_1', command: 'pnpm test --shard=1/3' },
  { id: 'toolu_h10_check_2', command: 'pnpm test --shard=2/3' },
  { id: 'toolu_h10_check_3', command: 'pnpm test --shard=3/3' },
] as const

const askUser = (question: string): Readonly<Record<string, unknown>> => ({
  questions: [{ question, header: 'Выбор', options: [{ label: 'Первый' }, { label: 'Второй' }], multiSelect: false }],
})

interface SentHooks {
  readonly send: (sample: string, fields: HookFields) => Promise<void>
  readonly sent: () => string[]
}

const hookIdentity = (event: unknown, toolUse: unknown): string =>
  `${String(event)} ${typeof toolUse === 'string' ? toolUse : '-'}`

const trackedHooks = (hook: HookSamples): SentHooks => {
  const sent: string[] = []
  return {
    send: async (sample, fields) => {
      await hook.claude(sample, fields)
      sent.push(hookIdentity(sample.split('.')[0], fields.tool_use_id))
    },
    sent: () => sent.toSorted(),
  }
}

const snapshotOf = async (request: APIRequestContext): Promise<RunSnapshot> => {
  const response = await getWithoutKeepAlive(request, endpoints.run.path.replace(':run', run))
  expect(response.status(), await response.text()).toBe(200)
  return endpoints.run.response.parse(await response.json())
}

const itemOf = (snapshot: RunSnapshot, text: string): AttentionItem => {
  const item = snapshot.attention.items.find((candidate) => candidate.text === text)
  if (item === undefined) {
    throw new Error(`the run has no attention item ${text}`)
  }
  return item
}

const write = async (
  daemon: RunningDaemon,
  path: string,
  method: 'POST' | 'DELETE',
  body?: unknown,
): Promise<unknown> => {
  const response = await daemon.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const answer: unknown = await response.json()
  expect(response.status, JSON.stringify(answer)).toBe(200)
  return answer
}

const attentionPath = (item: AttentionItem, action: 'attentionViewed' | 'attentionDismiss'): string =>
  endpoints[action].path.replace(':run', run).replace(':item', item.id)

const createRule = async (daemon: RunningDaemon, spec: ViewRuleSpec): Promise<AppliedViewRule> =>
  endpoints.createViewRule.response.parse(
    await write(daemon, endpoints.createViewRule.path.replace(':run', run), 'POST', spec),
  ).rule

const rawRecords = async (request: APIRequestContext): Promise<RawRecord[]> => {
  const records: RawRecord[] = []
  for (let seq = 1; ; seq += 1) {
    const response = await getWithoutKeepAlive(request, endpoints.raw.path.replace(':seq', String(seq)))
    if (response.status() === 404) {
      return records
    }
    records.push(endpoints.raw.response.parse(await response.json()).raw)
  }
}

interface ReadLine {
  readonly line: number
  readonly offset: number
  readonly payload: string
}

const fileLines = async (path: string): Promise<ReadLine[]> => {
  const content = await readFile(path)
  const lines: ReadLine[] = []
  let offset = 0
  while (offset < content.length) {
    const found = content.indexOf(0x0a, offset)
    const end = found < 0 ? content.length : found
    lines.push({ line: lines.length + 1, offset, payload: content.subarray(offset, end).toString('utf8') })
    offset = end + 1
  }
  return lines
}

const slashed = (path: string): string => path.replaceAll('\\', '/')

const readLines = (records: readonly RawRecord[], path: string): ReadLine[] =>
  records
    .flatMap(({ position, payload }) =>
      position.kind === 'line' && slashed(position.path) === slashed(path)
        ? [{ line: position.line, offset: position.offset, payload }]
        : [],
    )
    .toSorted((left, right) => left.line - right.line || left.offset - right.offset)

const linesObservedBefore = (records: readonly RawRecord[], path: string, instant: number): number[] =>
  records
    .flatMap(({ position, observed_at }) =>
      position.kind === 'line' && slashed(position.path) === slashed(path) && observed_at < BigInt(instant) * 1_000_000n
        ? [position.line]
        : [],
    )
    .toSorted((left, right) => left - right)

const hookRecords = (records: readonly RawRecord[]): string[] =>
  records
    .filter(({ position }) => position.kind === 'spool')
    .map(({ payload }) => {
      const event = JSON.parse(payload) as Readonly<Record<string, unknown>>
      return hookIdentity(event.hook_event_name, event.tool_use_id)
    })
    .toSorted()

const queued = async (profile: Profile): Promise<string[]> =>
  readdir(aangHomePaths(profile.aangHome).spoolReady).catch(() => [])

interface Transcripts {
  readonly main: string
  readonly subagent: string
  readonly fork: string
}

const transcriptsOf = (profile: Profile): Transcripts => {
  const main = sessionFile(profile, claudeOriginal)
  return {
    main,
    subagent: join(dirname(main), claudeOriginal.session, 'subagents', `agent-${subagent}.jsonl`),
    fork: sessionFile(profile, claudeFork),
  }
}

test.use({
  config: { watch: { all: true, lookbackDays }, collector: { spoolScanIntervalMs: 250 } },
  claudeScenario: { loggedIn: false },
})

test('a daemon killed in the middle of playback restarts without duplicates, from its cursors, with the view mark and the rules, and takes the hook events from the spool (E2E 6)', async ({
  page,
  context,
  player,
  profile,
  hook,
  daemon,
  config,
}) => {
  const continued = (await loadManifest(scenario)).steps.findIndex(({ label }) => label === 'continue')
  const replay = await player(scenario, { timeScale: 0.02 })
  await replay.play({ until: 'resume' })
  await page.goto(`/?run=${run}`)
  await expect(fact(page, 'Агенты')).toHaveText('2')

  const fields = hookFields(profile, claudeOriginal)
  const hooks = trackedHooks(hook)
  const ask = (question: string, id: string): Promise<void> =>
    hooks.send('PreToolUse.Bash.json', {
      ...fields,
      tool_name: 'AskUserQuestion',
      tool_use_id: id,
      tool_input: askUser(question),
    })
  await hooks.send('UserPromptSubmit.json', fields)
  await hooks.send('PermissionRequest.Bash.json', fields)
  await ask(formatQuestion, 'toolu_h10_format')
  await expect(zoneItem(page, approvalText)).toContainText('ждёт ответа')
  await expect(zoneItem(page, formatQuestion)).toContainText('ждёт ответа')

  const before = await snapshotOf(page.request)
  await write(daemon, attentionPath(itemOf(before, approvalText), 'attentionDismiss'), 'POST', {})
  await write(daemon, attentionPath(itemOf(before, formatQuestion), 'attentionViewed'), 'POST', {})
  const collapsed = await createRule(daemon, {
    action: 'collapse',
    selector: { kind: 'agent_type', agent_type: 'pinger' },
    params: null,
  })
  const grouped = await createRule(daemon, {
    action: 'group',
    selector: { kind: 'action_tool', tool: 'Bash' },
    params: { name: 'Проверки' },
  })
  const revoked = await createRule(daemon, {
    action: 'hide',
    selector: { kind: 'action_tool', tool: 'Agent' },
    params: null,
  })
  await write(daemon, endpoints.revokeViewRule.path.replace(':run', run).replace(':id', revoked.rule.id), 'DELETE')
  await markButton(page).click()
  await expect(mark(page)).toContainText('Просмотрен только что')
  const kept = await snapshotOf(page.request)
  expect(kept.view.mark).not.toBeNull()
  expect(kept.view.rules.map(({ rule }) => rule.id).toSorted()).toEqual([collapsed.rule.id, grouped.rule.id].toSorted())

  const transcripts = transcriptsOf(profile)
  const playing = replay.play()
  await expect.poll(() => replay.position(), { intervals: [5] }).toBe(continued)
  await Promise.all(
    checks.map(({ id, command }) =>
      hooks.send('PreToolUse.Bash.json', {
        ...fields,
        tool_use_id: id,
        tool_input: { command, description: 'Run the check' },
      }),
    ),
  )
  await daemon.kill()
  const queuedAtKill = await queued(profile)
  const writtenAtKill = (await fileLines(transcripts.main)).length
  expect(replay.position()).toBe(continued)
  await expect(lamp(page, 'Связь')).toHaveText('Связь нет связи с демоном')

  const [first] = checks
  await hooks.send('PostToolUse.Bash.json', {
    ...fields,
    tool_use_id: first.id,
    tool_input: { command: first.command, description: 'Run the check' },
  })
  await ask(downtimeQuestion, 'toolu_h10_downtime')
  await playing
  expect(replay.finished()).toBe(true)
  expect((await fileLines(transcripts.main)).length).toBeGreaterThan(writtenAtKill)
  const queuedAtRestart = await queued(profile)
  expect(queuedAtRestart).toEqual(expect.arrayContaining(queuedAtKill))
  expect(queuedAtRestart).toHaveLength(queuedAtKill.length + 2)
  const outsideLookback = new Date(Date.now() - 2 * lookbackDays * day)
  await utimes(transcripts.main, outsideLookback, outsideLookback)

  await profile.configure({
    ...config,
    collector: { rootsScanIntervalMs: 250, spoolScanIntervalMs: 250 },
    api: { port: daemon.api.port },
  })
  const restarted = await profile.startDaemon({ entry: aangEntry })
  await expect(lamp(page, 'Связь')).toHaveText('Связь поток подключён', reconnected)
  await expect.poll(() => queued(profile), reconnected).toEqual([])

  await expect(zoneItem(page, downtimeQuestion)).toContainText('ждёт ответа')
  await expect(zoneItem(page, downtimeQuestion)).toHaveCount(1)
  await expect(zoneItem(page, formatQuestion)).toHaveCount(1)
  await expect(fact(page, 'Агенты')).toHaveText('2')
  await expect(
    stepsOf(page, 'Основной агент')
      .getByRole('list', { name: 'Шаги группы «Проверки»', exact: true })
      .getByRole('listitem')
      .filter({ hasText: first.command }),
  ).toContainText('успешно')
  await expect(mark(page)).toContainText(`версия карты ${String(kept.view.mark?.version)}`)

  const files = [transcripts.main, transcripts.subagent, transcripts.fork]
  const written = await Promise.all(files.map(fileLines))
  expect(written.map((lines) => lines.length)).not.toContain(0)
  await expect
    .poll(async () => {
      const records = await rawRecords(page.request)
      return { lines: files.map((path) => readLines(records, path)), hooks: hookRecords(records) }
    }, reconnected)
    .toEqual({ lines: written, hooks: hooks.sent() })
  const [mainLines = []] = written
  const takenAfterRestart = linesObservedBefore(
    await rawRecords(page.request),
    transcripts.main,
    Date.now() - lookbackDays * day,
  )
  const takenBeforeKill = mainLines.length - takenAfterRestart.length
  expect(takenAfterRestart).toEqual(mainLines.slice(takenBeforeKill).map(({ line }) => line))
  expect(takenBeforeKill).toBeGreaterThan(0)
  expect(takenBeforeKill).toBeLessThanOrEqual(writtenAtKill)
  expect({ hookEvents: queuedAtKill.length, transcriptLines: writtenAtKill - takenBeforeKill }).not.toEqual({
    hookEvents: 0,
    transcriptLines: 0,
  })

  const after = await snapshotOf(page.request)
  expect(after.view.mark).toEqual(kept.view.mark)
  const rules = new Map(after.view.rules.map((applied) => [applied.rule.id, applied]))
  expect([...rules.keys()].toSorted()).toEqual([collapsed.rule.id, grouped.rule.id].toSorted())
  expect(rules.get(collapsed.rule.id)?.rule).toEqual(collapsed.rule)
  expect(rules.get(collapsed.rule.id)?.affected).toEqual(collapsed.affected)
  const bash = after.objects.actions.filter(({ tool }) => tool === 'Bash').map(({ id }) => ({ kind: 'action', id }))
  expect(rules.get(grouped.rule.id)?.affected.toSorted((left, right) => left.id.localeCompare(right.id))).toEqual(
    bash.toSorted((left, right) => left.id.localeCompare(right.id)),
  )
  expect(bash.length).toBeGreaterThan(grouped.affected.length)
  const collapsedAgent = after.view.placements.find(
    ({ element }) => element.kind === 'agent' && element.id === collapsed.affected[0]?.id,
  )
  expect(collapsedAgent?.visibility).toMatchObject({ state: 'collapsed', rule: collapsed.rule.id })
  expect(after.view.placements.filter(({ visibility }) => visibility?.state === 'hidden')).toEqual([])

  const dismissed = itemOf(after, approvalText)
  expect(after.attention.views.find(({ item }) => item === dismissed.id)?.dismissed_at).not.toBeNull()
  expect(after.view.zone.map(({ item }) => item)).not.toContain(dismissed.id)
  const viewed = itemOf(after, formatQuestion)
  expect(after.view.zone.find(({ item }) => item === viewed.id)?.viewed).toBe(true)
  expect(after.view.zone.find(({ item }) => item === itemOf(after, downtimeQuestion).id)?.viewed).toBe(false)

  const returned = await context.newPage()
  await returned.goto(`/?run=${run}&mode=changes`)
  await expect(mark(returned)).toContainText(`версия карты ${String(kept.view.mark?.version)}`)
  await expect(sinceTab(returned)).toHaveAccessibleName(/^С последнего просмотра, \d+ изменени/)
  const asked = change(returned, 'Вопросы и запросы', downtimeQuestion)
  await expect(asked).toContainText('открыт')
  await expect(asked).toHaveCount(1)
  await expect(since(returned)).not.toContainText(formatQuestion)
  await expect(zone(returned).getByRole('listitem').filter({ hasText: downtimeQuestion })).toHaveCount(1)
  await returned.goto('/')
  await expect(runRowOf(returned, run)).toHaveCount(1)
  await expect(runRowOf(returned, runOf(claudeFork))).toHaveCount(1)
  await returned.close()
  expect(await restarted.stop(), restarted.output()).toEqual({ code: 0, signal: null })
})
