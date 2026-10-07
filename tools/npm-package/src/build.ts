import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stageAang } from './aang-package.js'
import { stageHookPackage } from './hook-package.js'
import { hookPackageName, hookPlatforms } from './platforms.js'
import { npm } from './process.js'
import { aangVersion } from './repository.js'

export interface PackedPackage {
  readonly name: string
  readonly version: string
  readonly manifest: Readonly<Record<string, unknown>>
  readonly directory: string
  readonly tarball: string
  readonly integrity: string
  readonly shasum: string
}

interface PackResult {
  readonly name: string
  readonly version: string
  readonly filename: string
  readonly integrity: string
  readonly shasum: string
}

const pack = async (directory: string, destination: string): Promise<PackedPackage> => {
  const [result] = JSON.parse(await npm(['pack', '--json', '--pack-destination', destination], { cwd: directory })) as [
    PackResult,
  ]
  return {
    name: result.name,
    version: result.version,
    manifest: JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>,
    directory,
    tarball: join(destination, result.filename),
    integrity: result.integrity,
    shasum: result.shasum,
  }
}

export const buildNpmPackages = async (out: string): Promise<PackedPackage[]> => {
  const destination = resolve(out)
  const stage = join(destination, 'stage')
  await rm(stage, { recursive: true, force: true })
  const version = await aangVersion()
  const aang = join(stage, 'aang')
  const hooks = hookPlatforms.map((platform) => ({ platform, directory: join(stage, hookPackageName(platform)) }))
  await Promise.all([
    stageAang(aang, version),
    ...hooks.map(({ platform, directory }) => stageHookPackage(directory, platform, version)),
  ])
  const packed: PackedPackage[] = []
  for (const directory of [aang, ...hooks.map(({ directory }) => directory)]) {
    packed.push(await pack(directory, destination))
  }
  return packed
}
