import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Store } from '@aang/store'
import {
  createPlayer,
  type LoadedManifest,
  loadManifest,
  type PlayedStep,
  type PlayOptions,
  type SampleScenario,
  sampleScenarioManifest,
} from '@aang/testkit'
import { expect, onTestFinished, vi } from 'vitest'
import { recordsOf, startEngine } from './harness.js'
import { createHome } from './home.js'
import { createLiveRoots, deliverHook, type Live, type LiveRoots, runLive, type SpoolDelivery } from './live.js'

export const settle = { timeout: 15_000, interval: 25 }

export interface Scenario {
  readonly store: Store
  readonly live: Live
  readonly roots: Readonly<Record<'home' | 'claude' | 'codex', string>>
  readonly watched: LiveRoots
  readonly manifest: LoadedManifest
}

export interface Replay {
  readonly play: (options?: PlayOptions) => Promise<void>
  readonly deliver: (file: string, hook: SpoolDelivery) => Promise<void>
}

export const startScenario = async (scenario: SampleScenario): Promise<Scenario> => {
  const store = (await createHome(onTestFinished)).open()
  const live = await createLiveRoots(onTestFinished)
  const roots = { home: join(dirname(live.spool), 'home'), claude: live.claude, codex: live.codex }
  await mkdir(roots.home, { recursive: true })
  return {
    store,
    live: runLive(onTestFinished, live, store, startEngine(store, { all: true })),
    roots,
    watched: live,
    manifest: await loadManifest(sampleScenarioManifest(scenario)),
  }
}

export const filesReplay = ({ store, roots, watched, manifest }: Scenario): Replay => {
  const player = createPlayer(manifest, { roots, timeScale: 0 })
  let written = 0
  const writesOf = (played: readonly PlayedStep[]): number =>
    played.reduce((sum, { index }) => {
      const step = manifest.steps[index]
      return sum + (step?.kind === 'append' ? (step.lines ?? 0) : step?.kind === 'write' ? 1 : 0)
    }, 0)
  const stored = (records: number): Promise<void> => {
    written += records
    return vi.waitFor(() => {
      expect(recordsOf(store)).toHaveLength(written)
    }, settle)
  }
  return {
    play: async (options) => {
      await stored(writesOf(await player.play(options)))
    },
    deliver: async (file, hook) => {
      await deliverHook(watched, file, hook)
      await stored(1)
    },
  }
}

export const playSample = async (scenario: SampleScenario): Promise<Scenario & Replay> => {
  const started = await startScenario(scenario)
  return { ...started, ...filesReplay(started) }
}
