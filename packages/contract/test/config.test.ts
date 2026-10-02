import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '@aang/contract'
import { ConfigError, configFileName, loadConfig, type ConfigEnvironment } from '@aang/contract/config-file'
import { describe, test, type TestContext } from 'vitest'

const temporaryHome = async (onTestFinished: TestContext['onTestFinished']): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'aang-config-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  return home
}

const writeConfig = async (aangHome: string, content: string): Promise<string> => {
  await mkdir(aangHome, { recursive: true })
  const path = join(aangHome, configFileName)
  await writeFile(path, content)
  return path
}

describe.concurrent('config.json is loaded from AANG_HOME', () => {
  test('without a config file the defaults apply under the home directory', async ({ expect, onTestFinished }) => {
    const home = await temporaryHome(onTestFinished)

    expect(await loadConfig({ env: {}, homedir: home })).toEqual({
      aangHome: join(home, '.aang'),
      path: join(home, '.aang', configFileName),
      exists: false,
      config: defaultConfig(),
      runtimeRoots: { claude: join(home, '.claude'), codex: join(home, '.codex') },
    })
  })

  test('the default config written to disk loads back unchanged', async ({ expect, onTestFinished }) => {
    const home = await temporaryHome(onTestFinished)
    const aangHome = join(home, 'custom aang')
    const path = await writeConfig(aangHome, JSON.stringify(defaultConfig(), null, 2))

    expect(await loadConfig({ env: { AANG_HOME: aangHome }, homedir: home })).toMatchObject({
      aangHome,
      path,
      exists: true,
      config: defaultConfig(),
    })
  })

  test('a partial config keeps the defaults of everything it omits', async ({ expect, onTestFinished }) => {
    const home = await temporaryHome(onTestFinished)
    const aangHome = join(home, '.aang')
    const project = join(home, 'projects', 'shop')
    await writeConfig(
      aangHome,
      JSON.stringify({
        watch: {
          roots: [
            {
              path: project,
              contracts: [{ name: 'tests', command: '^pnpm test', commitPattern: 'commit ([0-9a-f]{40})' }],
            },
          ],
        },
        collector: { fsWatch: false },
        observer: { crossVendor: true, models: { codex: 'gpt-6.1-sol-mini' } },
      }),
    )
    const defaults = defaultConfig()

    const { config } = await loadConfig({ env: {}, homedir: home })

    expect(config).toEqual({
      ...defaults,
      watch: {
        ...defaults.watch,
        roots: [
          {
            path: project,
            contracts: [
              {
                name: 'tests',
                command: '^pnpm test',
                successExitCodes: [0],
                inputMasks: ['.'],
                commitPattern: 'commit ([0-9a-f]{40})',
              },
            ],
          },
        ],
      },
      collector: { ...defaults.collector, fsWatch: false },
      observer: {
        ...defaults.observer,
        crossVendor: true,
        models: { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol-mini' },
      },
    })
  })

  test('an unreadable config is an error rather than silent defaults', async ({ expect, onTestFinished }) => {
    const home = await temporaryHome(onTestFinished)
    await mkdir(join(home, '.aang', configFileName), { recursive: true })

    await expect(loadConfig({ env: {}, homedir: home })).rejects.toMatchObject({ code: 'EISDIR' })
  })

  test('a byte order mark left by Windows editors is accepted', async ({ expect, onTestFinished }) => {
    const home = await temporaryHome(onTestFinished)
    await writeConfig(join(home, '.aang'), `\uFEFF${JSON.stringify({ api: { port: 0 } })}`)

    const { config } = await loadConfig({ env: {}, homedir: home })

    expect(config.api).toEqual({ host: '127.0.0.1', port: 0 })
  })

  test('runtime roots come from the environment when the config leaves them unset', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await temporaryHome(onTestFinished)
    const claudeDir = join(home, 'claude profile')
    const environment: ConfigEnvironment = { env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: '' }, homedir: home }

    expect((await loadConfig(environment)).runtimeRoots).toEqual({ claude: claudeDir, codex: join(home, '.codex') })
  })

  test('runtime roots set in the config win over the environment', async ({ expect, onTestFinished }) => {
    const home = await temporaryHome(onTestFinished)
    const codexHome = join(home, 'codex from config')
    await writeConfig(join(home, '.aang'), JSON.stringify({ runtimes: { codex: { home: codexHome } } }))
    const environment: ConfigEnvironment = { env: { CODEX_HOME: join(home, 'codex from env') }, homedir: home }

    expect((await loadConfig(environment)).runtimeRoots).toEqual({ claude: join(home, '.claude'), codex: codexHome })
  })
})

const rejected = [
  { name: 'malformed JSON', content: '{"api": ', reason: 'invalid JSON' },
  { name: 'an unknown key', content: JSON.stringify({ collector: { fswatch: false } }), reason: 'fswatch' },
  { name: 'a value of the wrong type', content: JSON.stringify({ api: { port: 'auto' } }), reason: 'api.port' },
  {
    name: 'a relative watched root',
    content: JSON.stringify({ watch: { roots: [{ path: 'projects/shop' }] } }),
    reason: 'watch.roots[0].path',
  },
  { name: 'a relative CLI path', content: JSON.stringify({ cli: { claude: 'bin/claude' } }), reason: 'cli.claude' },
  {
    name: 'a check contract with an invalid regular expression',
    content: JSON.stringify({ watch: { roots: [{ path: tmpdir(), contracts: [{ name: 'tests', command: '(' }] }] } }),
    reason: 'invalid regular expression',
  },
]

describe.concurrent('an invalid config.json is reported with its path and the offending field', () => {
  test.for(rejected)('$name', async ({ content, reason }, { expect, onTestFinished }) => {
    const home = await temporaryHome(onTestFinished)
    const path = await writeConfig(join(home, '.aang'), content)

    const loading = loadConfig({ env: {}, homedir: home })

    await expect(loading).rejects.toBeInstanceOf(ConfigError)
    await expect(loading).rejects.toMatchObject({ path, reason: expect.stringContaining(reason) as unknown })
  })
})
