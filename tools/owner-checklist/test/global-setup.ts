import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    checklistHookBinary: string
  }
}

const execFileAsync = promisify(execFile)
const hookModule = fileURLToPath(new URL('../../../packages/hook', import.meta.url))
const executableName = process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook'

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const output = await mkdtemp(join(tmpdir(), 'aang-d7-hook-'))
  const binary = join(output, executableName)
  await execFileAsync('go', ['build', '-o', binary, './cmd/aang-hook'], {
    cwd: hookModule,
    env: { ...process.env, CGO_ENABLED: '0' },
  })
  project.provide('checklistHookBinary', binary)
  return async () => {
    await rm(output, { recursive: true, force: true, maxRetries: 5 })
  }
}
