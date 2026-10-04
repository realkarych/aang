import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createPlayer, loadManifest, type SampleScenario, sampleScenarioManifest } from '@aang/testkit'

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}`)
  }
  return value
}

const [sample, ...actions] = process.argv.slice(2)
const pluginIndex = actions.indexOf('--plugin-dir')
const plugin = pluginIndex < 0 ? null : (actions[pluginIndex + 1] ?? null)
const steps = pluginIndex < 0 ? actions : actions.slice(0, pluginIndex)
const roots = { home: required('HOME'), claude: required('CLAUDE_CONFIG_DIR'), codex: required('CODEX_HOME') }
const samples = resolve(import.meta.dirname, '../../../docs/research/samples/claude-code-hooks')
const session = '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef'
const bashCall = 'toolu_017B7FeHZ4yDzFdvKQMwDJB8'
const cwd = '/tmp/aang-spike/cc-transcripts/run'
const transcript = join(roots.claude, 'projects', '-tmp-aang-spike-cc-transcripts-run', `${session}.jsonl`)

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
  const payload = JSON.parse(await readFile(join(samples, file), 'utf8')) as Record<string, unknown>
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

const player = createPlayer(await loadManifest(sampleScenarioManifest(sample as SampleScenario)), { roots, timeScale: 0 })

for (const step of steps) {
  if (step === 'play') {
    await player.play()
  } else if (step.startsWith('until:')) {
    await player.play({ until: step.slice('until:'.length) })
  } else {
    await fireHook(step)
  }
}
