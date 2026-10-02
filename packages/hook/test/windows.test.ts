import { readFile, stat, writeFile } from 'node:fs/promises'
import { installClaudePlugin, installCodexHooks, uninstallClaudePlugin, uninstallCodexHooks } from '@aang/hook'
import { inject, test } from 'vitest'
import { createInstallHome, sampleText } from './install.js'

test.runIf(process.platform === 'win32')(
  'on Windows hooks are not installed or removed for either runtime and nothing is written',
  async ({ expect, onTestFinished }) => {
    const home = await createInstallHome(onTestFinished)
    const hookBinarySource = inject('hookBinaries').plain
    const claude = { command: 'claude', configDir: null }
    const hooksJson = await sampleText('codex-cli/hooks/hooks.json.logger-config.json')
    await writeFile(home.hooksFile, hooksJson)
    const refused = { reason: 'unsupported_platform' }

    await expect(installClaudePlugin({ aangHome: home.aangHome, hookBinarySource, claude })).rejects.toMatchObject(
      refused,
    )
    await expect(uninstallClaudePlugin({ aangHome: home.aangHome, claude })).rejects.toMatchObject(refused)
    await expect(
      installCodexHooks({ aangHome: home.aangHome, hookBinarySource, codexHome: home.codexHome }),
    ).rejects.toMatchObject(refused)
    await expect(uninstallCodexHooks({ codexHome: home.codexHome })).rejects.toMatchObject(refused)

    expect(await readFile(home.hooksFile, 'utf8')).toBe(hooksJson)
    await expect(stat(home.paths.binary)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(home.paths.claudePlugin)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)
