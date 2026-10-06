import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InstallHome } from './install.js'
import { sampleText } from './install.js'

export interface AppServerScenario {
  readonly listings?: readonly unknown[]
  readonly failure?: 'timeout' | 'exit' | 'invalid_json' | 'rpc_error' | 'oversized'
  readonly failAt?: number
  readonly failMethod?: 'initialize' | 'hooks/list'
  readonly replaceHooks?: string
  readonly fragmented?: boolean
  readonly descendant?: boolean
  readonly exitAfterListing?: boolean
}

export interface AppServerCall {
  readonly pid: number
  readonly ppid: number
  readonly argv: readonly string[]
  readonly cwd: string
  readonly codexHome: string
  readonly request: { readonly method?: string; readonly id?: number; readonly params?: unknown }
}

export const fakeAppServer = async (home: Pick<InstallHome, 'root'>, scenario: AppServerScenario = {}) => {
  const state = join(home.root, 'app-server.json')
  const log = `${state}.jsonl`
  const fixture = JSON.parse(await sampleText('desktop/exp-codex-desktop-appserver-hooks-list.json')) as {
    response_first_hook: Record<string, unknown>
  }
  await writeFile(state, JSON.stringify({ ...scenario, template: fixture.response_first_hook }))
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./fake-app-server.ts', import.meta.url)), state],
    calls: async (): Promise<AppServerCall[]> =>
      (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as AppServerCall),
  }
}

export const hooksListing = (hooks: readonly unknown[], errors: readonly unknown[] = []) => ({
  data: [{ cwd: '/temporary', hooks, errors, warnings: [] }],
})

export const sampleHook = async (overrides: Record<string, unknown> = {}) => {
  const fixture = JSON.parse(await sampleText('desktop/exp-codex-desktop-appserver-hooks-list.json')) as {
    response_first_hook: Record<string, unknown>
  }
  return { ...fixture.response_first_hook, ...overrides }
}
