import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createPlayer, loadManifest, type SampleScenario, sampleScenarioManifest } from '@aang/testkit'

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}`)
  }
  return value
}

const optionValue = (args: readonly string[], name: string): string | null => {
  const index = args.indexOf(name)
  return index < 0 ? null : (args[index + 1] ?? null)
}

const [sample, ...actions] = process.argv.slice(2)
const plugin = optionValue(actions, '--plugin-dir')
const otlp = optionValue(actions, '--otlp')
const optionStart = actions.findIndex((action) => action.startsWith('--'))
const steps = optionStart < 0 ? actions : actions.slice(0, optionStart)
const roots = { home: required('HOME'), claude: required('CLAUDE_CONFIG_DIR'), codex: required('CODEX_HOME') }
const samples = resolve(import.meta.dirname, '../../../docs/research/samples')
const session = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const bashCall = 'toolu_017B7FeHZ4yDzFdvKQMwDJB8'
const cwd = '/tmp/aang-spike/cc-transcripts/run'
const transcript = join(roots.claude, 'projects', '-tmp-aang-spike-cc-transcripts-run', `${session}.jsonl`)
const movedTranscript = join(roots.claude, 'projects', '-tmp-aang-spike-cc-transcripts-run-moved', `${session}.jsonl`)
const registry = join(roots.claude, 'sessions', '60263.json')
const capturePauseMs = 250
const toolResult = join(roots.claude, 'projects', '-tmp-aang-spike-cc-transcripts-run', session, 'tool-results', 'output.jsonl')

const sessionVariables: readonly string[] = [
  'AI_AGENT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
]

const hookSamples: Readonly<Record<string, string>> = {
  SessionStart: 'SessionStart.startup.json',
  PermissionRequest: 'PermissionRequest.Bash.json',
  PreToolUse: 'PreToolUse.Bash.json',
  PostToolUse: 'PostToolUse.Bash.json',
  Stop: 'Stop.json',
}

const fireHook = async (event: string): Promise<void> => {
  const file = hookSamples[event]
  if (plugin === null || file === undefined) {
    throw new Error(`Cannot fire ${event} without the recording plugin`)
  }
  const configuration = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>
  }
  const hook = configuration.hooks[event]?.[0]?.hooks[0]
  if (hook === undefined) {
    throw new Error(`The recording plugin has no ${event} hook`)
  }
  const payload = JSON.parse(await readFile(join(samples, 'claude-code-hooks', file), 'utf8')) as Record<string, unknown>
  const input = JSON.stringify({
    ...payload,
    session_id: session,
    transcript_path: transcript,
    cwd,
    ...('tool_use_id' in payload ? { tool_use_id: bashCall } : {}),
  })
  execFileSync(hook.command, hook.args, {
    input,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !sessionVariables.includes(key))),
      AI_AGENT: 'claude-code_2-1-286_harness',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-cli',
      CLAUDE_CODE_SESSION_ID: session,
      CLAUDE_PID: String(process.pid),
      CLAUDE_PLUGIN_ROOT: plugin,
      CLAUDE_PROJECT_DIR: process.cwd(),
    },
  })
}

const register = async (status: string): Promise<void> => {
  const entry = JSON.parse(await readFile(join(samples, 'claude-code-transcripts', 'sessions-registry-pid-at-start.json'), 'utf8')) as Record<string, unknown>
  await mkdir(dirname(registry), { recursive: true })
  await writeFile(registry, JSON.stringify({ ...entry, status: status === 'null' ? null : status, statusUpdatedAt: 1790856640000 }))
}

const writeToolResult = async (): Promise<void> => {
  await mkdir(dirname(toolResult), { recursive: true })
  await writeFile(toolResult, `${JSON.stringify({ type: 'tool_result', content: 'probe' })}\n`)
}

const relocate = async (): Promise<void> => {
  await mkdir(dirname(movedTranscript), { recursive: true })
  await rename(transcript, movedTranscript)
}

const player = createPlayer(await loadManifest(sampleScenarioManifest(sample as SampleScenario)), {
  roots,
  timeScale: 0,
  ...(otlp === null ? {} : { otlp }),
})

for (const step of steps) {
  if (step === 'play') {
    await player.play()
  } else if (step.startsWith('until:')) {
    await player.play({ until: step.slice('until:'.length) })
  } else if (step.startsWith('registry:')) {
    await register(step.slice('registry:'.length))
  } else if (step === 'unregister') {
    await rm(registry)
  } else if (step === 'relocate') {
    await relocate()
  } else if (step === 'tool-result') {
    await writeToolResult()
  } else if (step === 'pause') {
    await sleep(capturePauseMs)
  } else if (step === 'delete') {
    await rm(movedTranscript)
  } else {
    await fireHook(step)
  }
}
