import { spawn } from 'node:child_process'

const [exitCode = '0', stage = '', command = '', ...args] = process.argv.slice(2)
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
  const partial = '{"type":"result"'
  process.exitCode = Number(exitCode)
  process.stdout.write(stage === 'after-init' ? `${JSON.stringify(init)}\n${partial}` : stage === 'before-init' ? `${partial}\n${text}` : `${text}\n${partial}`)
})
