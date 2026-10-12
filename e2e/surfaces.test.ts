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
import { versionOf } from './screens.js'
import { duringWorkScenario, duringWorkVariants, skippedHere, type SurfaceVariant } from './variants.js'

interface Delegate {
  readonly description: string
}

interface Variant extends SurfaceVariant {
  readonly origin: string
  readonly agentType: string
  readonly firstEvent: string
  readonly early: string
  readonly whole: string
  readonly delegates: readonly Delegate[]
  readonly selected: Delegate
}

const claudeDelegates = [
  { description: 'Echo solo' },
  { description: 'Echo left' },
  { description: 'Echo right' },
  { description: 'Echo back later' },
] as const

const codexDelegates = [
  { description: '/root/scout' },
  { description: '/root/builder' },
] as const

const origins: Readonly<Record<Surface, string>> = {
  claude_cli: 'Claude Code CLI',
  claude_desktop: 'Claude Desktop',
  claude_sdk: 'Claude Agent SDK',
  codex_tui: 'Codex TUI',
  codex_exec: 'codex exec',
  codex_desktop: 'Codex Desktop (assumed)',
  codex_sdk: 'Codex SDK',
}

const claudeVariant = (variant: SurfaceVariant): Variant => ({
  ...variant,
  origin: `${origins[variant.surface]} ${variant.version}`,
  agentType: 'general-purpose',
  firstEvent: 'solo-finished',
  early: '1 substage',
  whole: '4 substages',
  delegates: claudeDelegates,
  selected: claudeDelegates[1],
})

const codexVariant = (variant: SurfaceVariant): Variant => ({
  ...variant,
  origin: `${origins[variant.surface]} ${variant.version}`,
  agentType: 'default',
  firstEvent: 'child-finished',
  early: '2 substages',
  whole: '2 substages',
  delegates: codexDelegates,
  selected: codexDelegates[1],
})

const variants: readonly Variant[] = duringWorkVariants.map((variant) =>
  variant.runtime === 'claude' ? claudeVariant(variant) : codexVariant(variant),
)

const observed = { timeout: 60_000 }

test.use({
  config: { watch: { all: true }, collector: { spoolScanIntervalMs: 250 } },
  claudeScenario: observerScenarios['live-map'].live,
  codexScenario: observerScenarios['live-map'].live,
})

const map = (page: Page): Locator => page.getByRole('region', { name: 'Stage map' })

const stage = (page: Page, title: string): Locator =>
  map(page).getByRole('group', { name: `Stage "${title}"`, exact: true })

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

const sessionOrigin = async (page: Page, run: RunId, session: string): Promise<{ surface: Surface; version: string } | null> => {
  const found = (await snapshotOf(page, run)).objects.sessions.find(({ key }) => key.session === session)
  return found?.surface === null || found?.surface === undefined || found.version === null
    ? null
    : { surface: found.surface.surface, version: found.version }
}

for (const variant of variants) {
  const { surface, runtime, selected: chosen } = variant

  test.describe(() => {
    const reason = skippedHere(variant)
    test.skip(reason !== undefined, reason)

    test(`live observation of a subagent and parallel agents on ${variant.origin}: the map nests a stage per delegated agent and selecting one focuses the chat on it (E2E 1, ${surface})`, async ({
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
      expect(await sessionOrigin(page, run, session)).toEqual({ surface, version: variant.version })
      const early = await versionOf(daemon, run)

      await played.play()
      await expect(main).toContainText(variant.whole, observed)
      const staged = await interpreted(page, run, variant.delegates)
      await expect.poll(async () => versionOf(daemon, run)).toBeGreaterThan(early)
      expect(await sessionOrigin(page, run, session)).toEqual({ surface, version: variant.version })

      const outer = await box(main)
      for (const delegate of variant.delegates) {
        const delegated = agentOf(staged, delegate)
        const card = stage(page, titleOnMap(delegated))
        await expect(card.getByRole('heading', { level: 3 })).toHaveText(titleOnMap(delegated))
        await expect(card.getByRole('heading', { level: 3 })).toHaveAttribute('title', agentStageTitle(delegated))
        await expect(card).toContainText(`agent: ${variant.agentType}`)
        await expect(card).toContainText('1 action')
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
      const heading = page
        .getByRole('complementary', { name: 'Chat panel' })
        .getByRole('region', { name: 'Selected stage' })
        .getByRole('heading')
      await expect(heading).toHaveText(shown)
      await expect(heading).toHaveAttribute('title', title)
    })
  })
}
