import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'

export interface HookBinaries {
  readonly plain: string
  readonly stripped: string
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

const mergeWorkerCoverage = async (): Promise<void> => {
  const workers = (await readdir(coverageDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(coverageDirectory, entry.name))
  if (workers.length > 0) {
    await execFileAsync('go', ['tool', 'covdata', 'merge', `-i=${workers.join(',')}`, `-o=${coverageDirectory}`], {
      cwd: moduleDirectory,
    })
    await Promise.all(workers.map((worker) => rm(worker, { recursive: true, force: true })))
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const output = await mkdtemp(join(tmpdir(), 'aang-hook-build-'))
  await rm(coverageDirectory, { recursive: true, force: true })
  await mkdir(coverageDirectory, { recursive: true })
  const [plain, stripped, covered] = await Promise.all([
    build(join(output, 'plain'), []),
    build(join(output, 'stripped'), ['-ldflags=-s -w']),
    build(join(output, 'covered'), ['-cover']),
  ])
  project.provide('hookBinaries', { plain, stripped, covered, coverageDirectory })
  return async () => {
    await mergeWorkerCoverage()
    await rm(output, { recursive: true, force: true, maxRetries: 5 })
  }
}
