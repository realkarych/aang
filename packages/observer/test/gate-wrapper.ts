import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

const [gate = '', command = '', ...args] = process.argv.slice(2)
while (!existsSync(gate)) await setTimeout(10)
const child = spawn(command, args, { stdio: 'inherit' })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
