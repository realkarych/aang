import { cp, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleCommands, commandFiles } from './bundle.js'
import { thirdPartyLicensesFile, writeThirdPartyLicenses } from './licenses.js'
import { hookPackageName, hookPlatforms } from './platforms.js'
import { repository } from './repository.js'

const description = 'Observability of an agentic task for a human: a live map of Claude Code and Codex runs'

const webDirectory = 'dist/web'
const schemaDirectory = 'schema'
const supportDirectory = 'support'

const aangManifest = (version: string, webEntry: string): Readonly<Record<string, unknown>> => ({
  name: 'aang',
  version,
  description,
  type: 'module',
  bin: commandFiles,
  imports: {
    '#web': `./${webDirectory}/${webEntry}`,
    '#aang-hook-*': 'aang-hook-*',
  },
  files: ['dist', schemaDirectory, supportDirectory, thirdPartyLicensesFile],
  engines: { node: '>=26' },
  optionalDependencies: Object.fromEntries(hookPlatforms.map((platform) => [hookPackageName(platform), version])),
})

export const stageAang = async (packageDirectory: string, version: string): Promise<void> => {
  const webEntry = fileURLToPath(import.meta.resolve('@aang/web'))
  await mkdir(packageDirectory, { recursive: true })
  const bundled = await bundleCommands(packageDirectory)
  await cp(dirname(webEntry), join(packageDirectory, webDirectory), { recursive: true })
  await cp(repository.storeSchema, join(packageDirectory, schemaDirectory), { recursive: true })
  await cp(repository.supportMatrix, join(packageDirectory, supportDirectory, basename(repository.supportMatrix)))
  await writeThirdPartyLicenses(packageDirectory, bundled)
  await writeFile(
    join(packageDirectory, 'package.json'),
    `${JSON.stringify(aangManifest(version, basename(webEntry)), null, 2)}\n`,
  )
}
