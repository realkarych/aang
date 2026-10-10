import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { goTarget, hookBinaryName, type HookPlatform, hookPackageName } from './platforms.js'
import { repository } from './repository.js'

const execFileAsync = promisify(execFile)

const hookManifest = (platform: HookPlatform, version: string): Readonly<Record<string, unknown>> => ({
  name: hookPackageName(platform),
  version,
  description: `The aang-hook binary of aang for ${platform.os} ${platform.cpu}`,
  os: [platform.os],
  cpu: [platform.cpu],
  exports: `./${hookBinaryName(platform)}`,
  files: [hookBinaryName(platform)],
  preferUnplugged: true,
})

export const stageHookPackage = async (packageDirectory: string, platform: HookPlatform, version: string): Promise<void> => {
  await mkdir(packageDirectory, { recursive: true })
  await execFileAsync(
    'go',
    ['build', '-trimpath', '-ldflags=-s -w', '-o', join(packageDirectory, hookBinaryName(platform)), './cmd/aang-hook'],
    { cwd: repository.hook, env: { ...process.env, CGO_ENABLED: '0', ...goTarget(platform) }, windowsHide: true },
  )
  await writeFile(join(packageDirectory, 'package.json'), `${JSON.stringify(hookManifest(platform, version), null, 2)}\n`)
}
