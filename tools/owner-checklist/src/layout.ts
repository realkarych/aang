import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { catacombHomePaths } from '@catacomb/contract/home'
import { hookInstallPaths } from '@catacomb/hook'

export interface ChecklistLayout {
  readonly dir: string
  readonly catacombHome: string
  readonly hookBinary: string
  readonly pluginDir: string
  readonly spool: string
  readonly spoolReady: string
  readonly spoolTemporary: string
  readonly probes: string
  readonly envSettings: string
  readonly failureSettings: string
  readonly probeRepo: string
  readonly results: string
  readonly envProbeLog: string
  readonly state: string
}

export const defaultChecklistDir = (): string => join(tmpdir(), 'catacomb-d7')

export const outsideProbeDir = (): string => join(homedir(), 'catacomb-desktop-probe-outside')

export const checklistLayout = (dir: string): ChecklistLayout => {
  const catacombHome = join(dir, 'catacomb-home')
  const install = hookInstallPaths(catacombHome)
  const home = catacombHomePaths(catacombHome)
  const probes = join(dir, 'probes')
  const results = join(dir, 'results')
  return {
    dir,
    catacombHome,
    hookBinary: install.binary,
    pluginDir: install.claudePlugin,
    spool: home.spool,
    spoolReady: home.spoolReady,
    spoolTemporary: home.spoolTemporary,
    probes,
    envSettings: join(probes, 'env-settings.json'),
    failureSettings: join(probes, 'failure-settings.json'),
    probeRepo: join(dir, 'probe-repo'),
    results,
    envProbeLog: join(results, 'env-probe.jsonl'),
    state: join(dir, 'state.json'),
  }
}
