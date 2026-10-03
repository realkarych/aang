import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { readSteps } from './claude.js'
import type { CheckContext } from './context.js'
import { inheritedEnv, runtimeEnv } from './profile.js'
import { errorCode, excerpt, run } from './process.js'

type SdkMessage = Readonly<Record<string, unknown>>

interface SdkQuery {
  readonly prompt: string
  readonly options: Readonly<Record<string, unknown>>
}

export interface AgentSdk {
  readonly version: string
  readonly query: (input: SdkQuery) => AsyncIterable<SdkMessage>
}

const SdkModule = z.looseObject({ query: z.function() })

const SdkManifest = z.looseObject({ version: z.string() })

const packageName = '@anthropic-ai/claude-agent-sdk'

export const installAgentSdk = async (work: string, version: string): Promise<AgentSdk> => {
  const directory = join(work, 'agent-sdk')
  await mkdir(directory, { recursive: true })
  const installed = await run(
    'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', directory, `${packageName}@${version}`],
    { env: inheritedEnv(), cwd: directory, timeoutMs: 600_000 },
  )
  if (installed.status !== 0) {
    throw new Error(`npm install ${packageName}@${version} failed: ${excerpt(installed.stderr || String(installed.error))}`)
  }
  const root = join(directory, 'node_modules', ...packageName.split('/'))
  const manifest = SdkManifest.parse(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')))
  const loaded = SdkModule.parse(await import(pathToFileURL(join(root, 'sdk.mjs')).href))
  return { version: manifest.version, query: loaded.query as AgentSdk['query'] }
}

interface SdkSession {
  readonly durationMs: number
  readonly error: string | null
  readonly init: SdkMessage | null
  readonly result: SdkMessage | null
}

const sdkTimeoutMs = 180_000

export const runAgentSdk = async (
  context: CheckContext,
  sdk: AgentSdk,
  configDir: string,
  steps: number,
): Promise<SdkSession> => {
  context.anthropic.use({ steps: readSteps(context, steps), text: 'done' })
  const abortController = new AbortController()
  const timer = setTimeout(() => {
    abortController.abort()
  }, sdkTimeoutMs)
  const started = performance.now()
  let init: SdkMessage | null = null
  let result: SdkMessage | null = null
  let error: string | null = null
  try {
    for await (const message of sdk.query({
      prompt: 'Read note.txt and reply with done.',
      options: {
        cwd: context.profile.project,
        env: { ...runtimeEnv(context.profile, context.anthropic.url), CLAUDE_CONFIG_DIR: configDir },
        allowedTools: ['Read'],
        abortController,
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        init = message
      } else if (message.type === 'result') {
        result = message
      }
    }
  } catch (caught) {
    error = errorCode(caught)
  } finally {
    clearTimeout(timer)
  }
  return { durationMs: performance.now() - started, error, init, result }
}

export const sdkOutcome = ({ durationMs, error, init, result }: SdkSession): Record<string, unknown> => ({
  error,
  durationMs: Math.round(durationMs),
  engineVersion: init?.claude_code_version ?? null,
  plugins: Array.isArray(init?.plugins) ? init.plugins : null,
  result: result === null ? null : { subtype: result.subtype, is_error: result.is_error, num_turns: result.num_turns },
})
