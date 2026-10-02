import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'

export interface HookBinaries {
  readonly plain: string
  readonly covered: string
  readonly coverageDirectory: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    hookBinaries: HookBinaries
  }
}

const execFileAsync = promisify(execFile)
const moduleDirectory = fileURLToPath(new URL('..', import.meta.url))
const coverageDirectory = fileURLToPath(new URL('../../../coverage/hook', import.meta.url))
const executableName = process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook'

const build = async (directory: string, flags: readonly string[]): Promise<string> => {
  await mkdir(directory, { recursive: true })
  const binary = join(directory, executableName)
  await execFileAsync('go', ['build', ...flags, '-o', binary, './cmd/aang-hook'], {
    cwd: moduleDirectory,
    env: { ...process.env, CGO_ENABLED: '0' },
  })
  return binary
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const output = await mkdtemp(join(tmpdir(), 'aang-hook-build-'))
  await rm(coverageDirectory, { recursive: true, force: true })
  await mkdir(coverageDirectory, { recursive: true })
  const [plain, covered] = await Promise.all([
    build(join(output, 'plain'), []),
    build(join(output, 'covered'), ['-cover']),
  ])
  project.provide('hookBinaries', { plain, covered, coverageDirectory })
  return () => rm(output, { recursive: true, force: true, maxRetries: 5 })
}
