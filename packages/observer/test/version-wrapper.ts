import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const [counter = '', command = '', ...args] = process.argv.slice(2)
if (args.includes('--version')) {
  const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1
  writeFileSync(counter, String(count))
  if (count >= 4) {
    process.stdout.write('codex-cli 99.0.0\n')
  } else {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
    child.on('close', (code) => { process.exitCode = code ?? 1 })
  }
} else {
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
  child.on('close', (code) => { process.exitCode = code ?? 1 })
}
