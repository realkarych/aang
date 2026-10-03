import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  type ClaudeScenario,
  type CodexScenario,
  type ConfigInput,
  createPlayer,
  createProfile,
  type FakeCli,
  installFakeClaude,
  installFakeCodex,
  loadManifest,
  type Player,
  type PlayerOptions,
  type Profile,
  type RunningDaemon,
} from '@aang/testkit'
import { test as base, expect } from '@playwright/test'

export type PlayerSettings = Pick<PlayerOptions, 'timeScale'>

export interface AangOptions {
  readonly config: ConfigInput
  readonly claudeScenario: ClaudeScenario
  readonly codexScenario: CodexScenario
  readonly signedIn: boolean
}

export interface AangFixtures {
  readonly profile: Profile
  readonly fakeClaude: FakeCli<ClaudeScenario>
  readonly fakeCodex: FakeCli<CodexScenario>
  readonly daemon: RunningDaemon
  readonly signInLink: () => Promise<string>
  readonly player: (manifest: string, settings?: PlayerSettings) => Promise<Player>
}

const runFile = promisify(execFile)

const repository = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url))

const aangEntry = repository('packages/aang/dist/main.js')

const hookBinary = repository(`packages/hook/bin/aang-hook${process.platform === 'win32' ? '.exe' : ''}`)

const rootsScanIntervalMs = 250

const withScannedRoots = (config: ConfigInput): ConfigInput => ({
  ...config,
  collector: { rootsScanIntervalMs, ...config.collector },
})

const configuredPath = ({ command, args }: Pick<FakeCli<never>, 'command' | 'args'>): string | null =>
  args.length === 0 ? command : null

export const test = base.extend<AangOptions & AangFixtures>({
  config: [{}, { option: true }],
  claudeScenario: [{}, { option: true }],
  codexScenario: [{}, { option: true }],
  signedIn: [true, { option: true }],

  profile: async ({ config }, use) => {
    const profile = await createProfile({ config: withScannedRoots(config) })
    await use(profile)
    await profile.dispose()
  },

  fakeClaude: async ({ profile, claudeScenario }, use) => {
    await use(installFakeClaude(join(profile.root, 'fake-cli'), claudeScenario))
  },

  fakeCodex: async ({ profile, codexScenario }, use) => {
    await use(installFakeCodex(join(profile.root, 'fake-cli'), codexScenario))
  },

  daemon: async ({ profile, config, fakeClaude, fakeCodex }, use) => {
    await profile.configure({
      ...withScannedRoots(config),
      cli: { claude: configuredPath(fakeClaude), codex: configuredPath(fakeCodex), ...config.cli },
    })
    const daemon = await profile.startDaemon({ entry: aangEntry })
    await use(daemon)
    if (daemon.running()) {
      expect(await daemon.stop(), daemon.output()).toEqual({ code: 0, signal: null })
    }
  },

  baseURL: async ({ daemon }, use) => {
    await use(daemon.url)
  },

  signInLink: async ({ profile, daemon }, use) => {
    await use(async () => {
      const { stdout } = await runFile(process.execPath, [aangEntry, 'open'], {
        cwd: profile.home,
        env: profile.env,
        windowsHide: true,
      })
      const link = stdout.trim()
      expect(link.startsWith(`${daemon.url}/auth/`), link).toBe(true)
      return link
    })
  },

  context: async ({ context, signedIn, signInLink }, use) => {
    if (signedIn) {
      const response = await context.request.get(await signInLink(), { maxRedirects: 0 })
      expect(response.status(), await response.text()).toBe(200)
    }
    await use(context)
  },

  player: async ({ profile }, use) => {
    await use(async (manifest, settings = {}) =>
      createPlayer(await loadManifest(manifest), {
        ...settings,
        roots: { home: profile.home, claude: profile.claude, codex: profile.codex },
        hook: { binary: hookBinary, spool: profile.spool, env: profile.env },
      }),
    )
  },
})

export { expect }
