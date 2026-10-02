import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'

const [mode = '', command = '', ...args] = process.argv.slice(2)
const modelCall = args.includes('-p') || args.includes('exec')
const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true })
let text = ''
child.stdout.setEncoding('utf8').on('data', (chunk: string) => { text += chunk })
child.on('close', (code) => {
  process.exitCode = code ?? 1
  if (!modelCall) { process.stdout.write(text); return }
  const events = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  const init = events.find((event) => event.subtype === 'init')
  const result = events.find((event) => event.type === 'result')
  if (init !== undefined) {
    if (mode === 'mcp') init.mcp_servers = [{ name: 'user-server' }]
    if (mode === 'skills') init.skills = ['user-skill']
    if (mode === 'plugin') init.plugins = [{ name: 'cc-plugin-agents-md', path: '/user/plugin', source: 'cc-plugin-agents-md@builtin' }]
  }
  if (result !== undefined && mode === 'error') result.is_error = true
  if (result !== undefined && mode === 'schema') result.structured_output = { base_version: 0 }
  if (mode === 'failed') events.push({ type: 'turn.failed', error: { message: 'failed' } })
  if (mode === 'missing-last' || mode === 'schema') {
    const path = args[args.indexOf('-o') + 1]
    if (args.includes('-o') && path !== undefined) {
      if (mode === 'missing-last') rmSync(path)
      else writeFileSync(path, '{}')
    }
  }
  if (mode === 'flood') { process.stdout.write('x'.repeat(17 * 1024 * 1024)); return }
  if (mode === 'malformed') process.stdout.write('{invalid\n')
  else process.stdout.write(events.filter((event) => mode !== 'missing-init' || event.subtype !== 'init').filter((event) => mode !== 'missing-completed' || event.type !== 'turn.completed').map((event) => JSON.stringify(event)).join('\r\n'))
})
