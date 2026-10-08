import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Hook { readonly command: string; readonly args?: readonly string[] }

const [prelude = '', command = '', ...args] = process.argv.slice(2)
const inSession = (hook: Hook): Hook => {
  if ([hook.command, ...(hook.args ?? [])].some((part) => part.startsWith(prelude))) return hook
  return hook.args === undefined
    ? { ...hook, command: `${prelude} && ${hook.command}` }
    : { ...hook, command: '/bin/sh', args: ['-c', `${prelude} && exec "$0" "$@"`, hook.command, ...hook.args] }
}
const hooks = process.env.CODEX_HOME === undefined ? join(process.cwd(), '.claude', 'settings.json') : join(process.env.CODEX_HOME, 'hooks.json')
if (existsSync(hooks)) {
  const config = JSON.parse(readFileSync(hooks, 'utf8')) as { hooks: { SessionStart: { hooks: Hook[] }[] } }
  for (const group of config.hooks.SessionStart) group.hooks = group.hooks.map(inSession)
  writeFileSync(hooks, JSON.stringify(config))
}
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
child.on('close', (code) => { process.exitCode = code ?? 1 })
