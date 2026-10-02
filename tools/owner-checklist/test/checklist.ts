import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spoolEnvKeys } from '@aang/contract'
import { inject, type TestContext } from 'vitest'

export interface Sandbox {
  readonly root: string
  readonly home: string
  readonly claudeConfigDir: string
  readonly codexHome: string
  readonly desktopDir: string
  readonly dir: string
  readonly env: Readonly<Record<string, string>>
}

export interface Completed {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface Handler {
  readonly type: string
  readonly command: string
  readonly args: readonly string[]
  readonly timeout: number
  readonly statusMessage?: string
}

interface HooksDocument {
  readonly hooks: Readonly<Record<string, readonly { readonly hooks: readonly Handler[] }[]>>
}

export interface Step {
  readonly at: number
  readonly payload: Readonly<Record<string, unknown>>
}

export type Invoke = (payload: Readonly<Record<string, unknown>>) => Promise<Completed>

const mainScript = fileURLToPath(new URL('../dist/main.js', import.meta.url))

export const hookBinary = inject('checklistHookBinary')

export const baseTime = Date.UTC(2026, 9, 3, 10, 0, 0)

export const createSandbox = async (onTestFinished: TestContext['onTestFinished']): Promise<Sandbox> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aang-d7-test-')))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const home = join(root, 'Имя Фамилия')
  const claudeConfigDir = join(home, '.claude')
  const codexHome = join(home, '.codex')
  const desktopDir = join(root, 'desktop sessions')
  await mkdir(claudeConfigDir, { recursive: true })
  await mkdir(codexHome, { recursive: true })
  await mkdir(desktopDir, { recursive: true })
  return {
    root,
    home,
    claudeConfigDir,
    codexHome,
    desktopDir,
    dir: join(root, 'чек-лист d7'),
    env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeConfigDir, CODEX_HOME: codexHome },
  }
}

const strippedEnvironment = (overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        ![...spoolEnvKeys, 'AANG_OBSERVER', 'CLAUDE_CODE_SESSION_ATTENDED'].includes(name.toUpperCase()) &&
        !name.toUpperCase().startsWith('GIT_'),
    ),
  ),
  ...overrides,
})

export const runProcess = async (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  stdin = '',
): Promise<Completed> => {
  const child = spawn(command, [...args], { env: strippedEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  child.stdin.end(stdin)
  const [status] = (await once(child, 'close')) as [number | null]
  return { status, stdout, stderr }
}

export const runChecklist = (sandbox: Sandbox, args: readonly string[]): Promise<Completed> =>
  runProcess(process.execPath, [mainScript, ...args], sandbox.env)

export const prepare = (sandbox: Sandbox, args: readonly string[] = []): Promise<Completed> =>
  runChecklist(sandbox, ['prepare', '--dir', sandbox.dir, '--hook', hookBinary, ...args])

export const collect = (sandbox: Sandbox): Promise<Completed> =>
  runChecklist(sandbox, [
    'collect',
    '--dir',
    sandbox.dir,
    '--claude-config-dir',
    sandbox.claudeConfigDir,
    '--codex-home',
    sandbox.codexHome,
    '--claude-desktop-dir',
    sandbox.desktopDir,
  ])

export const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

export const handlerFor = async (hooksFile: string, event: string): Promise<Handler> => {
  const document = await readJson<HooksDocument>(hooksFile)
  const handler = document.hooks[event]?.[0]?.hooks[0]
  if (handler === undefined) {
    throw new Error(`${hooksFile} has no handler for ${event}`)
  }
  return handler
}

export const handlerInvoker =
  (handler: Handler, env: Readonly<Record<string, string>>): Invoke =>
  (payload) =>
    runProcess(handler.command, handler.args, env, JSON.stringify(payload))

export const spoolNames = async (spoolReady: string): Promise<string[]> => (await readdir(spoolReady)).sort()

export const record = async (spoolReady: string, invoke: Invoke, steps: readonly Step[]): Promise<void> => {
  for (const step of steps) {
    const before = new Set(await spoolNames(spoolReady))
    const result = await invoke(step.payload)
    if (result.status !== 0 || result.stdout !== '' || result.stderr !== '') {
      throw new Error(`aang-hook failed: ${JSON.stringify(result)}`)
    }
    const added = (await spoolNames(spoolReady)).filter((name) => !before.has(name))
    if (added.length !== 1 || added[0] === undefined) {
      throw new Error(`expected one spool file per event, got ${JSON.stringify(added)}`)
    }
    const received = new Date(baseTime + step.at * 1000)
    await utimes(join(spoolReady, added[0]), received, received)
  }
}

export const sample = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(new URL(`../../../docs/research/samples/claude-code-hooks/${name}`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>

export const writeJsonLines = async (path: string, records: readonly unknown[]): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, records.map((item) => `${JSON.stringify(item)}\n`).join(''))
}

export const encodeProjectPath = (path: string): string => path.replace(/[^A-Za-z0-9]/g, '-')

export const sectionOf = (markdown: string, heading: string): string => {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line === heading)
  if (start < 0) {
    throw new Error(`no section ${heading}`)
  }
  const level = /^#+/.exec(heading)?.[0].length ?? 1
  const end = lines.findIndex(
    (line, index) => index > start && /^#+ /.test(line) && (/^#+/.exec(line)?.[0].length ?? 0) <= level,
  )
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

export const lineWith = (text: string, needle: string): string => {
  const line = text.split('\n').find((item) => item.includes(needle))
  if (line === undefined) {
    throw new Error(`no line with ${needle} in:\n${text}`)
  }
  return line
}

export const resultFiles = async (dir: string): Promise<Record<string, string>> => {
  const results = join(dir, 'results')
  const names = await readdir(results)
  return Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await readFile(join(results, name), 'utf8')] as const)),
  )
}
