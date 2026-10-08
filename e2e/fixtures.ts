import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { endpoints } from '@aang/contract'
import { hookInstallPaths } from '@aang/hook'
import {
  type ClaudeScenario,
  type CodexScenario,
  type ConfigInput,
  createPlayer,
  createProfile,
  type FakeCli,
  installFakeClaude,
  installFakeCodex,
  invokeHook,
  type LoadedManifest,
  loadManifest,
  type Player,
  type PlayerOptions,
  type Profile,
  type RunningDaemon,
} from '@aang/testkit'
import { test as base, expect } from '@playwright/test'

export type PlayerSettings = Pick<PlayerOptions, 'timeScale' | 'recordTime' | 'otlp'>

export type HookFields = Readonly<Record<string, unknown>>

export interface HookSamples {
  readonly claude: (sample: string, fields: HookFields) => Promise<void>
  readonly codex: (sample: string, fields: HookFields) => Promise<void>
}

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
  readonly aang: (...args: readonly string[]) => Promise<string>
  readonly signInLink: () => Promise<string>
  readonly player: (manifest: string | LoadedManifest, settings?: PlayerSettings) => Promise<Player>
  readonly otelEndpoint: () => Promise<string>
  readonly hook: HookSamples
}

const runFile = promisify(execFile)

const repository = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url))

export const aangEntry = repository('packages/aang/dist/main.js')

export const hookBinary = repository(`packages/hook/bin/aang-hook${process.platform === 'win32' ? '.exe' : ''}`)

const webAssets = repository('packages/web/dist/')

const hookSample = async (directory: string, sample: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(repository(`docs/research/samples/${directory}/${sample}`), 'utf8')) as Record<
    string,
    unknown
  >

const webAsset = (url: string, daemon: string): string | null => {
  const prefix = `${daemon}/`
  return url.startsWith(prefix) && url.endsWith('.js') ? join(webAssets, ...url.slice(prefix.length).split('/')) : null
}

const rootsScanIntervalMs = 250

const withScannedRoots = (config: ConfigInput): ConfigInput => ({
  ...config,
  collector: { rootsScanIntervalMs, ...config.collector },
})

const otelTokenSetting = 'otel_token'

const savedOtelToken = (database: string): string => {
  const store = new DatabaseSync(database, { readOnly: true })
  try {
    const row = store.prepare('SELECT value FROM settings WHERE key = ?').get(otelTokenSetting)
    const token: unknown = typeof row?.value === 'string' ? JSON.parse(row.value) : null
    if (typeof token !== 'string') {
      throw new Error(`the daemon has not saved its OTel token in ${database}`)
    }
    return token
  } finally {
    store.close()
  }
}

const admissionMs = 1000

const withLongAdmission = (scenario: ClaudeScenario): ClaudeScenario => ({ admissionMs, ...scenario })

const installLauncher = async (profile: Profile): Promise<void> => {
  const { binary } = hookInstallPaths(profile.aangHome)
  await mkdir(dirname(binary), { recursive: true })
  await copyFile(hookBinary, binary)
}

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
    const fake = installFakeClaude(join(profile.root, 'fake-cli'), withLongAdmission(claudeScenario))
    await use({
      ...fake,
      setScenario: (scenario) => {
        fake.setScenario(withLongAdmission(scenario))
      },
    })
  },

  fakeCodex: async ({ profile, codexScenario }, use) => {
    await use(installFakeCodex(join(profile.root, 'fake-cli'), codexScenario))
  },

  daemon: async ({ profile, config, fakeClaude, fakeCodex }, use) => {
    await installLauncher(profile)
    await profile.configure({
      ...withScannedRoots(config),
      cli: { claude: fakeClaude.path, codex: fakeCodex.path, ...config.cli },
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

  aang: async ({ profile }, use) => {
    await use(async (...args) => {
      const { stdout } = await runFile(process.execPath, [aangEntry, ...args], {
        cwd: profile.home,
        env: profile.env,
        windowsHide: true,
      })
      return stdout
    })
  },

  signInLink: async ({ aang, daemon }, use) => {
    await use(async () => {
      const link = (await aang('open')).trim()
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

  page: async ({ page, daemon }, use) => {
    const coverage = process.env.NODE_V8_COVERAGE
    if (coverage === undefined) {
      await use(page)
      return
    }
    await page.coverage.startJSCoverage({ resetOnNavigation: false })
    await use(page)
    const result = (await page.coverage.stopJSCoverage()).flatMap(({ scriptId, url, functions }) => {
      const file = webAsset(url, daemon.url)
      return file === null ? [] : [{ scriptId, url: pathToFileURL(file).href, functions }]
    })
    if (result.length > 0) {
      await mkdir(coverage, { recursive: true })
      await writeFile(join(coverage, `coverage-web-${randomUUID()}.json`), JSON.stringify({ result }))
    }
  },

  player: async ({ profile }, use) => {
    await use(async (manifest, settings = {}) =>
      createPlayer(typeof manifest === 'string' ? await loadManifest(manifest) : manifest, {
        ...settings,
        roots: { home: profile.home, claude: profile.claude, codex: profile.codex },
        hook: { binary: hookBinary, spool: profile.spool, env: profile.env },
      }),
    )
  },

  otelEndpoint: async ({ daemon }, use) => {
    await use(async () => {
      const response = await daemon.request(endpoints.status.path)
      expect(response.status).toBe(200)
      const { daemon: running, database } = endpoints.status.response.parse(await response.json())
      return `http://${running.otel.host}:${String(running.otel.port)}/otel/${savedOtelToken(database.path)}/v1/logs`
    })
  },

  hook: async ({ profile }, use) => {
    const target = { binary: hookBinary, spool: profile.spool, env: profile.env }
    await use({
      claude: async (sample, fields) => {
        const payload = { ...(await hookSample('claude-code-hooks', sample)), ...fields }
        await invokeHook(target, {
          runtime: 'claude',
          registration: 'plugin',
          env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
          payload: JSON.stringify(payload),
        })
      },
      codex: async (sample, fields) => {
        const { stdin } = await hookSample('codex-cli/hooks', sample)
        const payload = { ...(stdin as Record<string, unknown>), ...fields }
        await invokeHook(target, { runtime: 'codex', registration: 'user', payload: JSON.stringify(payload) })
      },
    })
  },
})

export { expect }
