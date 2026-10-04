import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [payload = ''] = process.argv.slice(2)
const plugin = process.argv[process.argv.indexOf('--plugin-dir') + 1] ?? ''
const event = (JSON.parse(payload) as { hook_event_name: string }).hook_event_name
const configuration = JSON.parse(await readFile(join(plugin, 'hooks', 'hooks.json'), 'utf8')) as {
  hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>
}
const hook = configuration.hooks[event]?.[0]?.hooks[0]
if (!hook) {
  throw new Error(`No recording hook for ${event}`)
}
execFileSync(hook.command, hook.args, { input: payload, env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: process.cwd() } })
