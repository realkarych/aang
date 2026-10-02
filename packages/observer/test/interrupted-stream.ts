import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [stage = '', ready = '', command = '', ...args] = process.argv.slice(2)
const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true })
let text = ''
child.stdout.setEncoding('utf8').on('data', (chunk: string) => { text += chunk })
child.on('close', (code) => {
  if (!args.includes('-p')) {
    process.exitCode = code ?? 1
    process.stdout.write(text)
    return
  }
  const init = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).find((event) => event.subtype === 'init')
  const partial = '{"type":"system","subtype":"init"'
  process.stdout.write(stage === 'after-init' ? `${JSON.stringify(init)}\n${partial}` : partial, () => { writeFileSync(ready, '') })
  setInterval(() => undefined, 1000)
})
