import { lstat, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as hook from '@aang/hook'
import { describe, inject, test, type TestContext } from 'vitest'
import { fakeAppServer, hooksListing, sampleHook } from './app-server.js'
import { createInstallHome, type InstallHome } from './install.js'
import { isAlive, waitUntil } from './launcher.js'

const binaries = inject('hookBinaries')
const posixOnly = test.skipIf(process.platform === 'win32')

const createInstalledHome = async (onTestFinished: TestContext['onTestFinished']): Promise<InstallHome> => {
  const home = await createInstallHome(onTestFinished)
  await hook.deployHookBinary({ aangHome: home.aangHome, hookBinarySource: binaries.plain })
  return home
}

describe('Codex hook installation state over stdio', () => {
  test('a wrapper cannot leave its server running after the listing', async ({ expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const cli = await fakeAppServer(home, { descendant: true })
    const descendantFile = join(home.root, 'app-server.json.descendant')
    onTestFinished(async () => {
      const pid = Number(await readFile(descendantFile, 'utf8').catch(() => '0'))
      if (pid > 0 && isAlive(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    })

    await hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli })
    const descendant = Number(await readFile(descendantFile, 'utf8'))

    await expect(waitUntil(() => !isAlive(descendant))).resolves.toBeUndefined()
  })
  test('a server that exits right after answering still yields its listing', async ({ expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const entry = await sampleHook({ command: hook.codexHookCommand(home.aangHome), trustStatus: 'trusted' })
    const cli = await fakeAppServer(home, { exitAfterListing: true, listings: [hooksListing([entry])] })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli })).toMatchObject({ status: 'active' })
    }
    for (const pid of new Set((await cli.calls()).map((call) => call.pid))) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
  })

  test.for([
    { trustStatus: 'untrusted', expected: 'untrusted' },
    { trustStatus: 'modified', expected: 'untrusted' },
    { trustStatus: 'trusted', expected: 'active' },
  ])('$trustStatus hooks are reported as $expected', async ({ trustStatus, expected }, { expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const command = hook.codexHookCommand(home.aangHome)
    const entry = await sampleHook({ command, trustStatus })
    const cli = await fakeAppServer(home, { listings: [hooksListing([entry])] })

    expect(hook).toHaveProperty('codexHooksState')
    const state = await hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli })

    expect(state.status).toBe(expected)
    expect(state.hooks).toMatchObject([{ command, trustStatus }])
    expect(state.stale).toEqual([])
    const calls = await cli.calls()
    expect(calls.map((call) => call.request.method)).toEqual(['initialize', 'initialized', 'hooks/list'])
    expect(calls.every((call) => call.codexHome === home.codexHome && call.cwd === home.codexHome)).toBe(true)
    for (const pid of new Set(calls.map((call) => call.pid))) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
  })

  test('foreign hooks do not count as an aang installation', async ({ expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const cli = await fakeAppServer(home, { listings: [hooksListing([await sampleHook()])] })

    expect(hook).toHaveProperty('codexHooksState')
    expect(await hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli })).toMatchObject({ status: 'not_installed', hooks: [], stale: [] })
  })

  test('a disabled or partly trusted installation is never active', async ({ expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const cli = await fakeAppServer(home, { listings: [hooksListing([
      await sampleHook({ key: 'a', command: hook.codexHookCommand(home.aangHome), trustStatus: 'trusted' }),
      await sampleHook({ key: 'b', command: hook.codexHookCommand(home.aangHome), trustStatus: 'trusted', enabled: false }),
    ])] })

    expect(hook).toHaveProperty('codexHooksState')
    expect((await hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli })).status).toBe('inactive')
  })

  test('one untrusted hook keeps an otherwise trusted installation untrusted', async ({ expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const cli = await fakeAppServer(home, { fragmented: true, listings: [hooksListing([
      await sampleHook({ key: 'a', command: hook.codexHookCommand(home.aangHome), trustStatus: 'trusted' }),
      await sampleHook({ key: 'b', command: hook.codexHookCommand(home.aangHome) }),
    ])] })

    const state = await hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli })

    expect(state.status).toBe('untrusted')
    expect(state.hooks[1]?.command).toBe(
      process.platform === 'win32'
        ? `& '${home.paths.binary.replaceAll("'", "''")}' 'codex' 'user' '${home.paths.spool.replaceAll("'", "''")}'`
        : `'${home.paths.binary.replaceAll("'", "'\\''")}' codex user '${home.paths.spool.replaceAll("'", "'\\''")}'`,
    )
  })

  test('stale aang entries of earlier installations never make the installation active', async ({ expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const elsewhere = hook.codexHookCommand(join(home.root, 'another aang home'))
    const stale = [
      await sampleHook({ key: 'old', command: '~/src/aang/bin/aang hook', trustStatus: 'trusted' }),
      await sampleHook({ key: 'moved', command: elsewhere, trustStatus: 'trusted' }),
    ]
    const current = await sampleHook({ key: 'current', command: hook.codexHookCommand(home.aangHome) })
    const options = { aangHome: home.aangHome, codexHome: home.codexHome }

    const onlyStale = await hook.codexHooksState({ ...options, codex: await fakeAppServer(home, { listings: [hooksListing(stale)] }) })
    expect(onlyStale).toMatchObject({ status: 'not_installed', hooks: [] })
    expect(onlyStale.stale.map((entry) => entry.command)).toEqual(['~/src/aang/bin/aang hook', elsewhere])

    const untrusted = await hook.codexHooksState({ ...options, codex: await fakeAppServer(home, { listings: [hooksListing([...stale, current])] }) })
    expect(untrusted.status).toBe('untrusted')
    expect(untrusted.hooks.map((entry) => entry.key)).toEqual(['current'])
    expect(untrusted.stale.map((entry) => entry.key)).toEqual(['old', 'moved'])
  })

  test('spawn and initialize failures are explicit', async ({ expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const cli = await fakeAppServer(home, { failure: 'rpc_error', failMethod: 'initialize' })

    await expect(hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'codex_app_server' })
    await expect(hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: { command: join(home.root, 'missing') } })).rejects.toMatchObject({ reason: 'codex_app_server' })
  })

  test.for([
    { failure: 'timeout', message: 'timed out after 5000 ms', timeoutMs: 5000 },
    { failure: 'exit', message: 'exited before hooks/list completed (7)' },
    { failure: 'invalid_json', message: 'invalid JSON-RPC response' },
    { failure: 'rpc_error', message: 'request 2 failed' },
    { failure: 'oversized', message: 'stdout exceeded the size limit' },
  ] as const)(
    '$failure produces an explicit failure and reaps the server',
    async ({ failure, message, ...options }, { expect, onTestFinished }) => {
      const home = await createInstalledHome(onTestFinished)
      const cli = await fakeAppServer(home, { failure })

      expect(hook).toHaveProperty('codexHooksState')
      const checking = hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli, ...options })
      await expect(checking).rejects.toMatchObject({ reason: 'codex_app_server' })
      await expect(checking).rejects.toThrow(message)
      for (const pid of new Set((await cli.calls()).map((call) => call.pid))) {
        expect(() => process.kill(pid, 0)).toThrow()
      }
    },
  )

  test.for([
    {},
    { data: [] },
    hooksListing([], [{ path: '/hooks.json', message: 'invalid file' }]),
    hooksListing([{ command: 'aang hook' }]),
  ])('invalid or incomplete hook listings fail instead of reporting no installation', async (listing, { expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const cli = await fakeAppServer(home, { listings: [listing] })

    expect(hook).toHaveProperty('codexHooksState')
    await expect(hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'codex_app_server' })
  })

  test('duplicate keys and command hooks without commands are rejected', async ({ expect, onTestFinished }) => {
    const home = await createInstalledHome(onTestFinished)
    const entry = await sampleHook()
    const missing = { ...entry, command: undefined }
    for (const entries of [[entry, entry], [missing]]) {
      const cli = await fakeAppServer(home, { listings: [hooksListing(entries)] })
      await expect(hook.codexHooksState({ aangHome: home.aangHome, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'codex_app_server' })
    }
  })
})

describe('Codex installation trust transaction', () => {
  test('changed foreign trust rejects installation and restores the original bytes and mode', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const original = '{ "hooks": { "Stop": [{"hooks":[{"type":"command","command":"notify-send done"}]}] } }\n'
    await writeFile(home.hooksFile, original, { mode: 0o640 })
    const foreign = await sampleHook({ trustStatus: 'trusted' })
    const cli = await fakeAppServer(home, { listings: [hooksListing([foreign]), hooksListing([{ ...foreign, trustStatus: 'modified' }])] })

    await expect(hook.installCodexHooks({ aangHome: home.aangHome, hookBinarySource: binaries.plain, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'foreign_hook_trust_changed' })

    expect(await readFile(home.hooksFile, 'utf8')).toBe(original)
    if (process.platform !== 'win32') {
      expect((await stat(home.hooksFile)).mode & 0o777).toBe(0o640)
    }
  })

  test('failure to verify a newly created hooks file rolls it back to absence', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const cli = await fakeAppServer(home, { failure: 'rpc_error', failAt: 1 })

    await expect(hook.installCodexHooks({ aangHome: home.aangHome, hookBinarySource: binaries.plain, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'codex_app_server' })

    await expect(stat(home.hooksFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(home.codexHome, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  posixOnly('a missing foreign entry also rolls back, preserving a hooks.json symlink', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const original = '{"hooks":{}}\n'
    const target = join(home.root, 'shared-hooks.json')
    await writeFile(target, original)
    await symlink(target, home.hooksFile)
    const cli = await fakeAppServer(home, { listings: [hooksListing([await sampleHook()]), hooksListing([])] })

    await expect(hook.installCodexHooks({ aangHome: home.aangHome, hookBinarySource: binaries.plain, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'foreign_hook_trust_changed' })

    expect((await lstat(home.hooksFile)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe(original)
    const backup = (await readdir(home.root)).find((name) => name.startsWith('shared-hooks.json.aang-backup'))
    expect(await readFile(join(home.root, backup ?? ''), 'utf8')).toBe(original)
  })

  test('a concurrent edit after saving survives a failed trust verification with a recoverable backup', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const original = '{"hooks":{}}\n'
    const replacement = '{"hooks":{},"otherProgram":true}\n'
    await writeFile(home.hooksFile, original)
    const cli = await fakeAppServer(home, { replaceHooks: replacement, listings: [hooksListing([await sampleHook()]), hooksListing([])] })

    await expect(hook.installCodexHooks({ aangHome: home.aangHome, hookBinarySource: binaries.plain, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'hooks_file_changed' })

    expect(await readFile(home.hooksFile, 'utf8')).toBe(replacement)
    const backup = (await readdir(home.codexHome)).find((name) => name.includes('.aang-backup-'))
    expect(await readFile(join(home.codexHome, backup ?? ''), 'utf8')).toBe(original)
  })

  test('a failed preflight leaves the configuration and hook binary untouched', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const original = '{"hooks":{}}\n'
    await writeFile(home.hooksFile, original)
    const cli = await fakeAppServer(home, { failure: 'rpc_error' })

    await expect(hook.installCodexHooks({ aangHome: home.aangHome, hookBinarySource: binaries.plain, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'codex_app_server' })

    expect(await readFile(home.hooksFile, 'utf8')).toBe(original)
    expect(await readdir(home.codexHome)).toEqual(['hooks.json'])
    await expect(stat(home.paths.binary)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('an installation can be untrusted, checked again on upgrade, and removed without changing config.toml', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const config = join(home.codexHome, 'config.toml')
    const original = '[hooks.state."foreign-key"]\ntrusted_hash = "sha256:foreign"\n'
    await writeFile(config, original)
    const options = { aangHome: home.aangHome, hookBinarySource: binaries.plain, codexHome: home.codexHome, codex: home.codex }

    const installation = await hook.installCodexHooks(options)
    const state = await hook.codexHooksState(options)
    const content = await readFile(home.hooksFile, 'utf8')
    await hook.installCodexHooks(options)

    expect(state.status).toBe('untrusted')
    expect(state.hooks).toHaveLength(12)
    expect(await readFile(home.hooksFile, 'utf8')).toBe(content)
    expect((await home.codex.calls()).filter((call) => call.request.method === 'hooks/list')).toHaveLength(5)
    expect(installation.command).toBe(hook.codexHookCommand(home.aangHome))
    await hook.uninstallCodexHooks({ codexHome: home.codexHome })
    expect((await hook.codexHooksState(options)).status).toBe('not_installed')
    expect(await readFile(config, 'utf8')).toBe(original)
  })

  test('foreign non-command hooks retain trust while stale aang trust may change', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    await writeFile(home.hooksFile, '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"aang hook"}]}]}}')
    const own = await sampleHook({ key: 'own', command: 'aang hook', trustStatus: 'trusted' })
    const foreign = await sampleHook({ key: 'foreign', handlerType: 'mcpTool', command: undefined, server: 'test', tool: 'notify', trustStatus: 'managed' })
    const cli = await fakeAppServer(home, { listings: [hooksListing([own, foreign]), hooksListing([foreign, { ...own, command: 'true', trustStatus: 'modified' }])] })

    const installed = await hook.installCodexHooks({ aangHome: home.aangHome, hookBinarySource: binaries.plain, codexHome: home.codexHome, codex: cli })

    expect(installed.backup).not.toBeNull()
    expect(await readFile(home.hooksFile, 'utf8')).toContain(`"command": "${process.platform === 'win32' ? 'exit 0' : 'true'}"`)
  })
})
