import { resolveExpect } from '../expect.js'
import type { Scenario, SurfaceDriver } from '../scenario.js'
import { desktopScenarios } from './desktop.js'
import { resolveCodex, resolveCodexDesktop, resolveCodexSdk } from './engine.js'
import { execScenarios } from './exec.js'
import { sdkScenarios } from './sdk.js'
import { tuiScenarios } from './tui.js'

export const codexDrivers: readonly SurfaceDriver[] = [
  { surface: 'codex_exec', runtime: 'codex', resolve: (selection) => resolveCodex(selection.codex) },
  {
    surface: 'codex_tui',
    runtime: 'codex',
    os: ['macos', 'linux'],
    resolve: async (selection) => {
      await resolveExpect()
      return resolveCodex(selection.codex)
    },
  },
  { surface: 'codex_sdk', runtime: 'codex', resolve: (selection) => resolveCodexSdk(selection.codexSdk) },
  { surface: 'codex_desktop', runtime: 'codex', os: ['macos'], resolve: (selection) => resolveCodexDesktop(selection.codexDesktop) },
]

export const codexScenarios: readonly Scenario[] = [...execScenarios, ...tuiScenarios, ...sdkScenarios, ...desktopScenarios]
