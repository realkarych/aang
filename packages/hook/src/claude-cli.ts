import { execFile } from 'node:child_process'
import { z } from 'zod'
import { HookInstallError } from './errors.js'

export interface ClaudeCli {
  readonly command: string
  readonly configDir: string | null
}

export interface ClaudeCompleted {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

const claudeTimeoutMs = 60_000

const PluginResult = z.looseObject({
  outcome: z.enum(['ok', 'failed']),
  message: z.string().default(''),
  failureCode: z.string().optional(),
})

const PluginListing = z.array(z.looseObject({ id: z.string(), enabled: z.boolean() }))
export type PluginListing = z.infer<typeof PluginListing>

const environment = ({ configDir }: ClaudeCli): NodeJS.ProcessEnv =>
  configDir === null ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: configDir }

const describe = (args: readonly string[]): string => ['claude', ...args].join(' ')

const run = (cli: ClaudeCli, args: readonly string[]): Promise<ClaudeCompleted> =>
  new Promise((resolve, reject) => {
    execFile(
      cli.command,
      args,
      { env: environment(cli), timeout: claudeTimeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null || typeof error.code === 'number') {
          resolve({ status: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })
          return
        }
        reject(new HookInstallError('claude_cli', `${describe(args)}: ${error.message}`, { cause: error }))
      },
    )
  })

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const lastLine = (text: string): string => text.trimEnd().split(/\r?\n/).at(-1) ?? ''

const failure = (args: readonly string[], { status, stderr }: ClaudeCompleted, message?: string): HookInstallError =>
  new HookInstallError(
    'claude_cli',
    `${describe(args)} failed: ${message ?? (stderr.trim() === '' ? `exit code ${String(status)}` : stderr.trim())}`,
  )

export const runPluginCommand = async (
  cli: ClaudeCli,
  command: readonly string[],
  tolerated: readonly string[] = [],
): Promise<void> => {
  const args = ['plugin', ...command, '--json']
  const completed = await run(cli, args)
  const result = PluginResult.safeParse(parseJson(lastLine(completed.stdout)))
  if (!result.success) {
    throw failure(args, completed)
  }
  const { outcome, failureCode, message } = result.data
  if (outcome === 'failed' && (failureCode === undefined || !tolerated.includes(failureCode))) {
    throw failure(args, completed, message)
  }
}

export const claudePluginListArgs: readonly string[] = ['plugin', 'list', '--json']

export const pluginListingOf = (completed: ClaudeCompleted): PluginListing => {
  const listing = PluginListing.safeParse(parseJson(completed.stdout))
  if (completed.status !== 0 || !listing.success) {
    throw failure(claudePluginListArgs, completed)
  }
  return listing.data
}

export const listPlugins = async (cli: ClaudeCli): Promise<PluginListing> => pluginListingOf(await run(cli, claudePluginListArgs))
