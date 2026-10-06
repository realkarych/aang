import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const [directory = '', command = '', ...args] = process.argv.slice(2)
const hold = join(directory, 'hold')
if (args.includes('--version') && existsSync(hold)) {
  writeFileSync(join(directory, 'holding'), '')
  while (existsSync(hold)) await setTimeout(10)
}
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
child.on('close', (code) => { process.exitCode = code ?? 1 })
