import { chmod, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HookInstallError, hookBinaryName, installCodexHooks, uninstallCodexHooks } from '@aang/hook'
import { describe, inject, test } from 'vitest'
import { cleanExit, readSpoolEvents, runProcess, typicalPayload, withoutNames } from './hook.js'
import { createInstallHome, type InstallHome, readJson, sampleText } from './install.js'

interface Handler {
  readonly type: string
  readonly command: string
  readonly timeout?: number
}

interface Group {
  readonly matcher?: string
  readonly hooks: readonly Handler[]
}

interface HooksDocument {
  readonly hooks: Readonly<Record<string, readonly Group[]>>
  readonly [key: string]: unknown
}

const binaries = inject('hookBinaries')
const installWaitMs = 200
const largeFileEntries = 40_000

const loggerConfig = await sampleText('codex-cli/hooks/hooks.json.logger-config.json')

const codexEvents = Object.keys((JSON.parse(loggerConfig) as HooksDocument).hooks)

const staleFile: HooksDocument = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'herdr-agent-state.sh', timeout: 5 }] },
      {
        hooks: [
          { type: 'command', command: '/Users/USER/src/aang/bin/aang hook', timeout: 5 },
          { type: 'command', command: 'echo aang-hook', timeout: 1 },
        ],
      },
      { matcher: 'startup', hooks: [{ type: 'command', command: 'cc-status' }] },
    ],
    Stop: [
      {
        hooks: [
          { type: 'command', command: "'/old home/.aang/bin/aang-hook' codex user '/old home/.aang/spool'", timeout: 2 },
        ],
      },
      { hooks: [{ type: 'command', command: 'notify-send "aang hook"' }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"/Users/USER/src/aang/bin/aang" hook' }] }],
    LegacyEvent: [{ hooks: [{ type: 'command', command: 'aang hook' }] }],
  },
  extra: { kept: true },
}

const neutralizedStaleFile: HooksDocument = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'herdr-agent-state.sh', timeout: 5 }] },
      {
        hooks: [
          { type: 'command', command: 'true', timeout: 5 },
          { type: 'command', command: 'echo aang-hook', timeout: 1 },
        ],
      },
      { matcher: 'startup', hooks: [{ type: 'command', command: 'cc-status' }] },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: 'true', timeout: 2 }] },
      { hooks: [{ type: 'command', command: 'notify-send "aang hook"' }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'true' }] }],
    LegacyEvent: [{ hooks: [{ type: 'command', command: 'true' }] }],
  },
  extra: { kept: true },
}

const aangGroup = (command: string): Group => ({ hooks: [{ type: 'command', command, timeout: 2 }] })

const install = (home: InstallHome, hookBinarySource = binaries.plain) =>
  installCodexHooks({ aangHome: home.aangHome, hookBinarySource, codexHome: home.codexHome })

const uninstall = (home: InstallHome) => uninstallCodexHooks({ codexHome: home.codexHome })

const withAangAppended = (document: HooksDocument, command: string): HooksDocument => ({
  ...document,
  hooks: {
    ...document.hooks,
    ...Object.fromEntries(codexEvents.map((event) => [event, [...(document.hooks[event] ?? []), aangGroup(command)]])),
  },
})

const foreignStop = (document: HooksDocument): HooksDocument => ({
  ...document,
  hooks: {
    ...document.hooks,
    Stop: [...(document.hooks.Stop ?? []), { hooks: [{ type: 'command', command: 'notify-send stop' }] }],
  },
})

const holdDeployLock = async (home: InstallHome): Promise<() => Promise<void>> => {
  const lock = join(dirname(home.paths.binary), `.${hookBinaryName}.lock`)
  await mkdir(dirname(lock), { recursive: true })
  await writeFile(lock, String(process.pid))
  return () => rm(lock)
}

const fileKind = (name: string): string => {
  if (name.endsWith('.tmp')) {
    return 'staged'
  }
  return name.includes('.aang-backup-') ? 'backup' : name
}

const backups = async (home: InstallHome): Promise<string[]> =>
  (await readdir(home.codexHome)).filter((name) => name.includes('.aang-backup-')).map((name) => join(home.codexHome, name))

describe.skipIf(process.platform === 'win32')('Codex hooks.json installation', () => {
  test('install appends one aang entry to the end of every event array and keeps foreign entries in place', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    await writeFile(home.hooksFile, loggerConfig)

    const installation = await install(home)

    expect(codexEvents).toHaveLength(12)
    expect(installation).toEqual({
      binary: home.paths.binary,
      command: expect.any(String) as unknown,
      hooksFile: home.hooksFile,
      backup: expect.stringMatching(/hooks\.json\.aang-backup-/) as unknown,
    })
    expect(await readJson(home.hooksFile)).toEqual(
      withAangAppended(JSON.parse(loggerConfig) as HooksDocument, installation.command),
    )
    expect(await readFile(installation.backup ?? '', 'utf8')).toBe(loggerConfig)
    expect(await readFile(installation.binary)).toEqual(await readFile(binaries.plain))
  })

  test('stale aang entries are neutralized in place without moving foreign entries', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const original = `${JSON.stringify(staleFile, null, 4)}\n`
    await writeFile(home.hooksFile, original)

    const installation = await install(home)

    expect(await readJson(home.hooksFile)).toEqual(withAangAppended(neutralizedStaleFile, installation.command))
    expect(await readFile(installation.backup ?? '', 'utf8')).toBe(original)
  })

  test('repeated install with an updated binary keeps the aang command line and leaves hooks.json untouched', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    await writeFile(home.hooksFile, loggerConfig)
    const first = await install(home)
    const installed = await readFile(home.hooksFile)
    const modified = (await stat(home.hooksFile)).mtimeMs

    const second = await install(home, binaries.stripped)

    expect(second).toEqual({ ...first, backup: null })
    expect(await readFile(home.hooksFile)).toEqual(installed)
    expect((await stat(home.hooksFile)).mtimeMs).toBe(modified)
    expect(await readFile(home.paths.binary)).toEqual(await readFile(binaries.stripped))
  })

  test('a duplicate of the current aang entry is neutralized and the first one stays', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const { command } = await install(home)
    const installed = (await readJson(home.hooksFile)) as HooksDocument
    const duplicated: HooksDocument = {
      ...installed,
      hooks: { ...installed.hooks, Stop: [...(installed.hooks.Stop ?? []), aangGroup(command)] },
    }
    await writeFile(home.hooksFile, JSON.stringify(duplicated))

    await install(home)

    expect(await readJson(home.hooksFile)).toEqual({
      ...installed,
      hooks: { ...installed.hooks, Stop: [aangGroup(command), aangGroup('true')] },
    })
  })

  test('without hooks.json install creates it with the aang entries and the command line runs the installed hook through the shell', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)

    const installation = await install(home)

    expect(installation.backup).toBeNull()
    expect(await readJson(home.hooksFile)).toEqual(withAangAppended({ hooks: {} }, installation.command))
    expect(((await stat(home.hooksFile)).mode & 0o777).toString(8)).toBe('600')
    const result = await runProcess('/bin/sh', ['-c', installation.command], { env: {} })
    expect(result).toEqual(cleanExit)
    expect(withoutNames(await readSpoolEvents(home.paths.spool))).toEqual([
      { header: { runtime: 'codex', registration: 'user', env: {} }, payload: typicalPayload },
    ])
  })

  test('uninstall neutralizes the aang entries in place, keeps foreign entries and can be repeated', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    await writeFile(home.hooksFile, loggerConfig)
    await install(home)
    const installed = await readFile(home.hooksFile, 'utf8')

    const first = await uninstall(home)
    const second = await uninstall(home)

    expect(await readJson(home.hooksFile)).toEqual(withAangAppended(JSON.parse(loggerConfig) as HooksDocument, 'true'))
    expect(first).toEqual({ hooksFile: home.hooksFile, backup: expect.any(String) as unknown })
    expect(await readFile(first.backup ?? '', 'utf8')).toBe(installed)
    expect(second).toEqual({ hooksFile: home.hooksFile, backup: null })
  })

  test('uninstall without hooks.json changes nothing', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)

    expect(await uninstall(home)).toEqual({ hooksFile: home.hooksFile, backup: null })
    await expect(stat(home.hooksFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a hooks.json managed through a symlink stays a symlink and its target receives the change and the backup', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const dotfiles = join(home.root, 'dotfiles')
    await mkdir(dotfiles)
    await writeFile(join(dotfiles, 'hooks.json'), loggerConfig)
    await symlink(join(dotfiles, 'hooks.json'), home.hooksFile)

    const installation = await install(home)

    expect((await lstat(home.hooksFile)).isSymbolicLink()).toBe(true)
    expect(await readlink(home.hooksFile)).toBe(join(dotfiles, 'hooks.json'))
    expect(await readJson(join(dotfiles, 'hooks.json'))).toEqual(
      withAangAppended(JSON.parse(loggerConfig) as HooksDocument, installation.command),
    )
    expect(installation.backup?.startsWith(join(dotfiles, 'hooks.json.aang-backup-'))).toBe(true)
  })

  test('a hooks.json symlink to a missing file is refused and left a symlink', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const missing = join(home.root, 'dotfiles', 'hooks.json')
    await symlink(missing, home.hooksFile)

    await expect(install(home)).rejects.toMatchObject({ reason: 'invalid_hooks_file' })
    await expect(uninstall(home)).rejects.toMatchObject({ reason: 'invalid_hooks_file' })

    expect(await readlink(home.hooksFile)).toBe(missing)
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('an entry another program adds to hooks.json while install is in progress is kept and the backup is the version the change was made on', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    await writeFile(home.hooksFile, loggerConfig)
    const release = await holdDeployLock(home)
    const installing = install(home)
    await delay(installWaitMs)
    const edited = foreignStop(JSON.parse(loggerConfig) as HooksDocument)
    const editedText = JSON.stringify(edited, null, 2)
    await writeFile(home.hooksFile, editedText)

    await release()
    const installation = await installing

    expect(await readJson(home.hooksFile)).toEqual(withAangAppended(edited, installation.command))
    expect(await backups(home)).toEqual([installation.backup])
    expect(await readFile(installation.backup ?? '', 'utf8')).toBe(editedText)
  })

  test('a hooks.json another program creates while install is in progress is kept', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const release = await holdDeployLock(home)
    const installing = install(home)
    await delay(installWaitMs)
    const created = foreignStop({ hooks: {} })
    const createdText = JSON.stringify(created)
    await writeFile(home.hooksFile, createdText)

    await release()
    const installation = await installing

    expect(await readJson(home.hooksFile)).toEqual(withAangAppended(created, installation.command))
    expect(await readFile(installation.backup ?? '', 'utf8')).toBe(createdText)
  })

  test('copies of a private hooks.json are never more permissive than the original, even while being written', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    const large: HooksDocument = {
      hooks: {
        Stop: Array.from({ length: largeFileEntries }, (_, index) => ({
          hooks: [{ type: 'command', command: `notify-send ${String(index)} ${'x'.repeat(400)}` }],
        })),
      },
    }
    await writeFile(home.hooksFile, JSON.stringify(large), { mode: 0o600 })
    const observed = new Set<string>()
    let installed = false
    const observe = async (): Promise<void> => {
      while (!installed) {
        for (const name of await readdir(home.codexHome)) {
          const stats = await stat(join(home.codexHome, name)).catch(() => undefined)
          if (stats !== undefined) {
            observed.add(`${fileKind(name)} ${(stats.mode & 0o777).toString(8)}`)
          }
        }
      }
    }
    const observing = observe()

    await install(home)
    installed = true
    await observing

    expect(observed).toEqual(new Set(['hooks.json 600', 'staged 600', 'backup 600']))
  })

  test('an unreadable hooks.json is refused and left unchanged', async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    await writeFile(home.hooksFile, loggerConfig)
    await chmod(home.hooksFile, 0o200)
    onTestFinished(() => chmod(home.hooksFile, 0o600))

    await expect(install(home)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(uninstall(home)).rejects.toMatchObject({ code: 'EACCES' })

    await chmod(home.hooksFile, 0o600)
    expect(await readFile(home.hooksFile, 'utf8')).toBe(loggerConfig)
  })

  test('a Codex home without write permission fails the install and leaves no files behind', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createInstallHome(onTestFinished)
    await chmod(home.codexHome, 0o500)
    onTestFinished(() => chmod(home.codexHome, 0o700))

    await expect(install(home)).rejects.toMatchObject({ code: 'EACCES' })

    expect(await readdir(home.codexHome)).toEqual([])
  })

  test.for([
    { name: 'invalid JSON', content: '{"hooks": {' },
    { name: 'a top level that is not an object', content: '[]' },
    { name: 'hooks that are not an object', content: '{"hooks": []}' },
    { name: 'an event that is not an array', content: '{"hooks": {"Stop": {"hooks": []}}}' },
  ])('hooks.json with $name is refused and left unchanged', async ({ content }, { expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    await writeFile(home.hooksFile, content)

    await expect(install(home)).rejects.toBeInstanceOf(HookInstallError)
    await expect(install(home)).rejects.toMatchObject({ reason: 'invalid_hooks_file' })
    await expect(uninstall(home)).rejects.toMatchObject({ reason: 'invalid_hooks_file' })
    expect(await readFile(home.hooksFile, 'utf8')).toBe(content)
    await expect(stat(home.paths.binary)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
