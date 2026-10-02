import { lstat, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as hook from '@aang/hook'
import { describe, inject, test } from 'vitest'
import { fakeAppServer, hooksListing, sampleHook } from './app-server.js'
import { createInstallHome } from './install.js'
import { isAlive, waitUntil } from './launcher.js'

const binaries = inject('hookBinaries')

describe.skipIf(process.platform === 'win32')('Codex hook installation state over stdio', () => {
  test('a wrapper cannot leave its server running after the listing', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const cli = await fakeAppServer(home, { descendant: true })
    const descendantFile = join(home.root, 'app-server.json.descendant')
    onTestFinished(async () => {
      const pid = Number(await readFile(descendantFile, 'utf8').catch(() => '0'))
      if (pid > 0 && isAlive(pid)) {
        process.kill(pid, 'SIGKILL')
      }
    })

    await hook.codexHooksState({ codexHome: home.codexHome, codex: cli })
    const descendant = Number(await readFile(descendantFile, 'utf8'))

    await expect(waitUntil(() => !isAlive(descendant))).resolves.toBeUndefined()
  })
  test.for([
    { trustStatus: 'untrusted', expected: 'untrusted' },
    { trustStatus: 'modified', expected: 'untrusted' },
    { trustStatus: 'trusted', expected: 'active' },
  ])('$trustStatus hooks are reported as $expected', async ({ trustStatus, expected }, { expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const entry = await sampleHook({ command: 'aang hook', trustStatus })
    const cli = await fakeAppServer(home, { listings: [hooksListing([entry])] })

    expect(hook).toHaveProperty('codexHooksState')
    const state = await hook.codexHooksState({ codexHome: home.codexHome, codex: cli })

    expect(state.status).toBe(expected)
    expect(state.hooks).toMatchObject([{ command: 'aang hook', trustStatus }])
    const calls = await cli.calls()
    expect(calls.map((call) => call.request.method)).toEqual(['initialize', 'initialized', 'hooks/list'])
    expect(calls.every((call) => call.codexHome === home.codexHome && call.cwd === home.codexHome)).toBe(true)
    for (const pid of new Set(calls.map((call) => call.pid))) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
  })

  test('foreign hooks do not count as an aang installation', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const cli = await fakeAppServer(home, { listings: [hooksListing([await sampleHook()])] })

    expect(hook).toHaveProperty('codexHooksState')
    expect(await hook.codexHooksState({ codexHome: home.codexHome, codex: cli })).toMatchObject({ status: 'not_installed', hooks: [] })
  })

  test('a disabled or partly trusted installation is never active', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const cli = await fakeAppServer(home, { listings: [hooksListing([
      await sampleHook({ key: 'a', command: 'aang hook', trustStatus: 'trusted' }),
      await sampleHook({ key: 'b', command: 'aang-hook codex user /spool', trustStatus: 'trusted', enabled: false }),
    ])] })

    expect(hook).toHaveProperty('codexHooksState')
    expect((await hook.codexHooksState({ codexHome: home.codexHome, codex: cli })).status).toBe('inactive')
  })

  test('one untrusted hook keeps an otherwise trusted installation untrusted', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const cli = await fakeAppServer(home, { fragmented: true, listings: [hooksListing([
      await sampleHook({ key: 'a', command: 'aang hook', trustStatus: 'trusted' }),
      await sampleHook({ key: 'b', command: "'/Имя Фамилия/bin/aang-hook' codex user '/spool'" }),
    ])] })

    const state = await hook.codexHooksState({ codexHome: home.codexHome, codex: cli })

    expect(state.status).toBe('untrusted')
    expect(state.hooks[1]?.command).toBe("'/Имя Фамилия/bin/aang-hook' codex user '/spool'")
  })

  test('spawn and initialize failures are explicit', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const cli = await fakeAppServer(home, { failure: 'rpc_error', failMethod: 'initialize' })

    await expect(hook.codexHooksState({ codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'codex_app_server' })
    await expect(hook.codexHooksState({ codexHome: home.codexHome, codex: { command: join(home.root, 'missing') } })).rejects.toMatchObject({ reason: 'codex_app_server' })
  })

  test.for(['timeout', 'exit', 'invalid_json', 'rpc_error', 'oversized'] as const)(
    '%s produces an explicit failure and reaps the server',
    async (failure, { expect, onTestFinished }) => {
      const home = await createInstallHome(onTestFinished)
      const cli = await fakeAppServer(home, { failure })

      expect(hook).toHaveProperty('codexHooksState')
      const timeoutMs = failure === 'oversized' ? 20_000 : 5000
      const checking = hook.codexHooksState({ codexHome: home.codexHome, codex: cli, timeoutMs })
      await expect(checking).rejects.toMatchObject({ reason: 'codex_app_server' })
      if (failure === 'oversized') {
        await expect(checking).rejects.toThrow('size limit')
      }
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
    const home = await createInstallHome(onTestFinished)
    const cli = await fakeAppServer(home, { listings: [listing] })

    expect(hook).toHaveProperty('codexHooksState')
    await expect(hook.codexHooksState({ codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'codex_app_server' })
  })

  test('duplicate keys and command hooks without commands are rejected', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const entry = await sampleHook()
    const missing = { ...entry, command: undefined }
    for (const entries of [[entry, entry], [missing]]) {
      const cli = await fakeAppServer(home, { listings: [hooksListing(entries)] })
      await expect(hook.codexHooksState({ codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'codex_app_server' })
    }
  })
})

describe.skipIf(process.platform === 'win32')('Codex installation trust transaction', () => {
  test('changed foreign trust rejects installation and restores the original bytes and mode', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const original = '{ "hooks": { "Stop": [{"hooks":[{"type":"command","command":"notify-send done"}]}] } }\n'
    await writeFile(home.hooksFile, original, { mode: 0o640 })
    const foreign = await sampleHook({ trustStatus: 'trusted' })
    const cli = await fakeAppServer(home, { listings: [hooksListing([foreign]), hooksListing([{ ...foreign, trustStatus: 'modified' }])] })

    await expect(hook.installCodexHooks({ aangHome: home.aangHome, hookBinarySource: binaries.plain, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'foreign_hook_trust_changed' })

    expect(await readFile(home.hooksFile, 'utf8')).toBe(original)
    expect((await stat(home.hooksFile)).mode & 0o777).toBe(0o640)
  })

  test('failure to verify a newly created hooks file rolls it back to absence', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const cli = await fakeAppServer(home, { failure: 'rpc_error', failAt: 1 })

    await expect(hook.installCodexHooks({ aangHome: home.aangHome, hookBinarySource: binaries.plain, codexHome: home.codexHome, codex: cli })).rejects.toMatchObject({ reason: 'codex_app_server' })

    await expect(stat(home.hooksFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(home.codexHome, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a missing foreign entry also rolls back, preserving a hooks.json symlink', async ({ expect, onTestFinished }) => {
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
    expect(installation.command).toContain('codex user')
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
    expect(await readFile(home.hooksFile, 'utf8')).toContain('"command": "true"')
  })
})
