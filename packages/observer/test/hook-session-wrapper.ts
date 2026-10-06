import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [prelude = '', command = '', ...args] = process.argv.slice(2)
const hooks = join(process.env.CODEX_HOME ?? '', 'hooks.json')
if (process.env.CODEX_HOME !== undefined && existsSync(hooks)) {
  const config = JSON.parse(readFileSync(hooks, 'utf8')) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } }
  for (const group of config.hooks.SessionStart) {
    for (const hook of group.hooks) if (!hook.command.startsWith(prelude)) hook.command = `${prelude} && ${hook.command}`
  }
  writeFileSync(hooks, JSON.stringify(config))
}
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
child.on('close', (code) => { process.exitCode = code ?? 1 })
