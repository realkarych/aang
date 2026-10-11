import { type Agent, endpoints, type RunId, type RunSnapshot, type Runtime, type Surface } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import {
  agentStageTitle,
  type LoadedManifest,
  loadManifest,
  mainStageTitle,
  observerScenarios,
  type RunningDaemon,
} from '@aang/testkit'
import type { Locator, Page } from '@playwright/test'
import { expect, getWithoutKeepAlive, test } from './fixtures.js'
import { threadsOf, variantRecording } from './recordings.js'
import { fact, sessionOf } from './screens.js'
import { duringWorkScenario, duringWorkVariants, skippedHere, type SurfaceVariant } from './variants.js'

interface Delegate {
  readonly description: string
  readonly command: string
}

interface Variant extends SurfaceVariant {
  readonly origin: string
  readonly agentType: string
  readonly firstEvent: string
  readonly early: string
  readonly whole: string
  readonly delegates: readonly Delegate[]
  readonly inspected: Delegate
}

const claudeDelegates = [
  { description: 'Echo solo', command: 'echo solo' },
  { description: 'Echo left', command: 'echo left' },
  { description: 'Echo right', command: 'echo right' },
  { description: 'Echo back later', command: 'sleep 2 && echo back' },
] as const

const codexDelegates = [
  { description: '/root/scout', command: 'echo scout' },
  { description: '/root/builder', command: 'echo builder' },
] as const

const origins: Readonly<Record<Surface, string>> = {
  claude_cli: 'Claude Code CLI',
  claude_desktop: 'Claude Desktop',
  claude_sdk: 'Claude Agent SDK',
  codex_tui: 'Codex TUI',
  codex_exec: 'codex exec',
  codex_desktop: 'Codex Desktop (предположительно)',
  codex_sdk: 'Codex SDK',
}

const claudeVariant = (variant: SurfaceVariant): Variant => ({
  ...variant,
  origin: `${origins[variant.surface]} ${variant.version}`,
  agentType: 'general-purpose',
  firstEvent: 'solo-finished',
  early: '1 подэтап',
  whole: '4 подэтапа',
  delegates: claudeDelegates,
  inspected: claudeDelegates[1],
})

const codexVariant = (variant: SurfaceVariant): Variant => ({
  ...variant,
  origin: `${origins[variant.surface]} ${variant.version}`,
  agentType: 'default',
  firstEvent: 'child-finished',
  early: '2 подэтапа',
  whole: '2 подэтапа',
  delegates: codexDelegates,
  inspected: codexDelegates[1],
})

const variants: readonly Variant[] = duringWorkVariants.map((variant) =>
  variant.runtime === 'claude' ? claudeVariant(variant) : codexVariant(variant),
)

const runtimeName: Readonly<Record<Runtime, string>> = { claude: 'Claude Code', codex: 'Codex' }

const fileChannel: Readonly<Record<Runtime, string>> = { claude: 'транскрипт', codex: 'rollout' }

const observed = { timeout: 60_000 }

test.use({
  config: { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } },
  claudeScenario: observerScenarios['live-map'].live,
  codexScenario: observerScenarios['live-map'].live,
})

const map = (page: Page): Locator => page.getByRole('region', { name: 'Карта этапов' })

const stage = (page: Page, title: string): Locator =>
  map(page).getByRole('group', { name: `Этап «${title}»`, exact: true })

const inspector = (page: Page): Locator => page.getByRole('complementary')

const section = (page: Page, title: string): Locator =>
  inspector(page).getByRole('region', { name: new RegExp(`^${title}`) })

const box = async (locator: Locator): Promise<{ x: number; y: number; right: number; bottom: number }> => {
  const found = await locator.boundingBox()
  if (found === null) {
    throw new Error('the element has no box')
  }
  return { x: found.x, y: found.y, right: found.x + found.width, bottom: found.y + found.height }
}

const admission = async (daemon: RunningDaemon, runtime: Runtime) => {
  const { observer } = endpoints.status.response.parse(await (await daemon.request(endpoints.status.path)).json())
  return observer.backends.find(({ vendor }) => vendor === runtime)?.admission ?? null
}

const admitted = async (daemon: RunningDaemon, runtime: Runtime): Promise<void> => {
  await expect.poll(async () => (await admission(daemon, runtime))?.outcome ?? 'pending', observed).not.toBe('pending')
  expect(await admission(daemon, runtime)).toMatchObject({ outcome: 'admitted', failure: null })
}

const claudeTranscript = /^projects\/[^/]+\/([0-9a-f-]{36})\.jsonl$/

const rootSession = (runtime: Runtime, manifest: LoadedManifest): string => {
  const [root] =
    runtime === 'codex'
      ? threadsOf(manifest)
      : manifest.steps.flatMap((step) => {
          const session = 'target' in step ? claudeTranscript.exec(step.target.path)?.[1] : undefined
          return session === undefined ? [] : [session]
        })
  if (root === undefined) {
    throw new Error(`${manifest.file} writes no root session`)
  }
  return root
}

const snapshotOf = async (page: Page, run: RunId): Promise<RunSnapshot> => {
  const response = await getWithoutKeepAlive(page.request, endpoints.run.path.replace(':run', run))
  expect(response.status()).toBe(200)
  return endpoints.run.response.parse(await response.json())
}

const interpreted = async (page: Page, run: RunId, delegates: readonly Delegate[]): Promise<Map<string, Agent>> => {
  const staged = new Map<string, Agent>()
  await expect
    .poll(async () => {
      const snapshot = await snapshotOf(page, run)
      staged.clear()
      for (const { description } of delegates) {
        const agent = snapshot.objects.agents.find((candidate) => candidate.description === description)
        if (agent !== undefined && snapshot.model.stages.some(({ title }) => title === agentStageTitle(agent))) {
          staged.set(description, agent)
        }
      }
      return snapshot.summary.observer.pending_facts === 0 && staged.size === delegates.length
    }, observed)
    .toBe(true)
  return staged
}

const titleOnMap = (agent: Agent): string => agentStageTitle(agent).replace(agent.id, agent.id.slice(0, 8))

const agentOf = (staged: ReadonlyMap<string, Agent>, { description }: Delegate): Agent => {
  const agent = staged.get(description)
  if (agent === undefined) {
    throw new Error(`no stage of the delegated agent ${description}`)
  }
  return agent
}

const ownFile = ({ key }: Agent): string => {
  switch (key.agent.kind) {
    case 'subagent':
      return `agent-${key.agent.agent_id}.jsonl`
    case 'thread':
      return `${key.agent.thread_id}.jsonl`
    default:
      throw new Error(`a delegated agent has no file of its own: ${key.agent.kind}`)
  }
}

const participantName = ({ runtime, agentType }: Variant, agent: Agent): string => {
  if (runtime === 'claude') {
    return agentType
  }
  if (agent.name === null) {
    throw new Error(`the delegated Codex agent ${agent.id} has no nickname`)
  }
  return agent.name
}

const mapVersion = async (page: Page): Promise<number> => Number(await fact(page, 'Версия карты').textContent())

for (const variant of variants) {
  const { surface, runtime, inspected: chosen } = variant

  test.describe(() => {
    const reason = skippedHere(variant)
    test.skip(reason !== undefined, reason)

    test(`live observation of a subagent and parallel agents on ${variant.origin}: the map nests a stage per delegated agent, the inspector shows its work and its grounds lead to the original event in the hook and in the file of the agent (E2E 1, ${surface})`, async ({
      page,
      player,
      daemon,
      otelEndpoint,
    }) => {
      test.setTimeout(180_000)
      await admitted(daemon, runtime)
      const manifest = await loadManifest(variantRecording(variant, duringWorkScenario))
      const session = rootSession(runtime, manifest)
      const run = runId({ kind: 'session', runtime, session })
      const played = await player(manifest, { timeScale: 0, recordTime: 'playback', otlp: await otelEndpoint() })

      await page.goto(`/?run=${run}`)
      await played.play({ until: variant.firstEvent })
      const main = stage(page, mainStageTitle)
      await expect(main).toContainText(variant.early, observed)
      await expect(sessionOf(page, session)).toContainText(variant.origin)
      const early = await mapVersion(page)

      await played.play()
      await expect(main).toContainText(variant.whole, observed)
      const staged = await interpreted(page, run, variant.delegates)
      await expect.poll(async () => mapVersion(page)).toBeGreaterThan(early)
      await expect(sessionOf(page, session)).toContainText(variant.origin)

      const outer = await box(main)
      for (const delegate of variant.delegates) {
        const delegated = agentOf(staged, delegate)
        const card = stage(page, titleOnMap(delegated))
        await expect(card.getByRole('heading', { level: 3 })).toHaveText(titleOnMap(delegated))
        await expect(card.getByRole('heading', { level: 3 })).toHaveAttribute('title', agentStageTitle(delegated))
        await expect(card).toContainText(`агент: ${variant.agentType}`)
        await expect(card).toContainText('1 действие')
        const heading = await box(card.getByRole('heading', { level: 3 }))
        expect(heading.bottom - heading.y).toBeGreaterThanOrEqual(14)
        const inner = await box(card)
        expect(inner.x).toBeGreaterThan(outer.x)
        expect(inner.y).toBeGreaterThan(outer.y)
        expect(inner.right).toBeLessThan(outer.right)
        expect(inner.bottom).toBeLessThanOrEqual(outer.bottom)
      }

      const agent = agentOf(staged, chosen)
      const title = agentStageTitle(agent)
      const shown = titleOnMap(agent)
      await stage(page, shown).getByRole('button', { name: shown, exact: true }).click()
      const heading = inspector(page).getByRole('heading', { level: 2 })
      await expect(heading).toHaveText(shown)
      await expect(heading).toHaveAttribute('title', title)
      await expect(
        inspector(page)
          .locator('dl > div')
          .filter({ has: page.getByRole('term').getByText('Ожидаемый результат', { exact: true }) })
          .getByRole('definition'),
      ).toHaveText(chosen.description)
      const work = section(page, 'Участники и действия')
      await expect(work.getByRole('list', { name: 'Агенты этапа' })).toContainText(participantName(variant, agent))
      await expect(work.getByRole('list', { name: 'Действия этапа' })).toContainText(chosen.command)

      await section(page, 'Связи').getByRole('link', { name: mainStageTitle, exact: true }).click()
      await expect(heading).toHaveText(mainStageTitle)
      const substages = section(page, 'Связи').getByRole('link', { name: new RegExp(`^${variant.agentType} \\(`) })
      await expect(substages).toHaveCount(variant.delegates.length)
      const substage = section(page, 'Связи').getByRole('link', { name: shown, exact: true })
      await expect(substage).toHaveAttribute('title', title)
      await substage.click()
      await expect(heading).toHaveText(shown)

      const history = section(page, 'История')
      const assignments = history.getByRole('button', { name: /^Версия \d+, привязка действий: \d+ факт/ })
      await expect(assignments.first()).toBeVisible()
      for (const grounds of await assignments.all()) {
        await grounds.click()
      }
      await expect(history.getByText(/^Загрузка/)).toHaveCount(0)
      const starts = history.getByRole('listitem').filter({ hasText: /^Начало действия/ }).filter({ hasText: chosen.command })
      await expect(starts).not.toHaveCount(0)
      for (const start of await starts.all()) {
        await start.getByRole('button', { name: 'Сырая запись' }).click()
      }
      const raws = history.getByRole('region', { name: /^Сырая запись: Начало действия/ })
      await expect(history.getByText(/^Загрузка/)).toHaveCount(0)
      const fromFile = raws.filter({ hasText: `${ownFile(agent)}, строка` }).first()
      await expect(fromFile).toContainText(`${fileChannel[runtime]}, ${runtimeName[runtime]}`)
      await expect(fromFile.locator('pre')).toContainText(chosen.command)
      const fromHook = raws.filter({ hasText: 'файл spool' }).first()
      await expect(fromHook).toContainText(`hook, ${runtimeName[runtime]}`)
      await expect(fromHook.locator('pre')).toContainText('"hook_event_name": "PreToolUse"')
      await expect(fromHook.locator('pre')).toContainText(chosen.command)
    })
  })
}
