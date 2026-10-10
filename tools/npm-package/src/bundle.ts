import { join } from 'node:path'
import { build, formatMessages, type Message } from 'esbuild'
import { repository } from './repository.js'

export const commandFiles = { aang: 'dist/aang.js', 'aang-hook': 'dist/aang-hook.js' } as const

const entryPoints = [
  { in: join(repository.aang, 'dist', 'main.js'), out: 'aang' },
  { in: join(repository.aang, 'dist', 'hook.js'), out: 'aang-hook' },
]

const thirdPartyPackage = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//

const nodeRequire = "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);"

const describeWarnings = async (warnings: Message[]): Promise<string> =>
  (await formatMessages(warnings, { kind: 'warning', color: false })).join('')

export const bundleCommands = async (packageDirectory: string): Promise<string[]> => {
  const result = await build({
    entryPoints,
    outdir: join(packageDirectory, 'dist'),
    absWorkingDir: repository.root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node26',
    banner: { js: nodeRequire },
    metafile: true,
    legalComments: 'none',
    logLevel: 'silent',
  })
  if (result.warnings.length > 0) {
    throw new Error(`esbuild reported warnings:\n${await describeWarnings(result.warnings)}`)
  }
  const packages = Object.keys(result.metafile.inputs).flatMap((input) => {
    const match = thirdPartyPackage.exec(input.replaceAll('\\', '/'))
    return match?.[1] === undefined ? [] : [join(repository.root, match[1])]
  })
  return [...new Set(packages)].sort()
}
