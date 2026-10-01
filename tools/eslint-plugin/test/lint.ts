import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

export interface Finding {
  readonly ruleId: string | null
  readonly line: number
  readonly message: string
}

export interface LintedWorkspace {
  readonly findings: ReadonlyMap<string, readonly Finding[]>
  readonly remove: () => Promise<void>
}

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

const toPosix = (path: string): string => path.replaceAll('\\', '/')

const repositoryLayout = (sources: Readonly<Record<string, string>>): Record<string, string> => {
  const packageDirectories = new Set(
    Object.keys(sources).flatMap((path) => {
      const [group, directory] = path.split('/')
      return group === 'packages' && directory !== undefined ? [directory] : []
    }),
  )
  return {
    'package.json': JSON.stringify({ private: true, type: 'module' }),
    'tsconfig.json': JSON.stringify({
      extends: join(repositoryRoot, 'tsconfig.base.json'),
      compilerOptions: { composite: false, declaration: false, declarationMap: false, noEmit: true, types: [] },
      include: ['**/*.ts'],
    }),
    ...Object.fromEntries(
      [...packageDirectories].map((directory) => [
        `packages/${directory}/package.json`,
        JSON.stringify({ name: `@aang/${directory}`, private: true, type: 'module' }),
      ]),
    ),
    ...sources,
  }
}

export const lintWorkspace = async (sources: Readonly<Record<string, string>>): Promise<LintedWorkspace> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'eslint-plugin-')))
  const remove = (): Promise<void> => rm(root, { recursive: true, force: true, maxRetries: 3 })
  try {
    for (const [path, text] of Object.entries(repositoryLayout(sources))) {
      const target = join(root, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text)
    }
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: join(repositoryRoot, 'eslint.config.ts'),
      flags: ['unstable_native_nodejs_ts_config'],
    })
    const results = await eslint.lintFiles(['.'])
    const findings = new Map(
      results.map((result) => [
        toPosix(relative(root, result.filePath)),
        result.messages.map(({ ruleId, line, message }) => ({ ruleId, line, message })),
      ]),
    )
    return { findings, remove }
  } catch (error) {
    await remove()
    throw error
  }
}
