import { spawn } from 'node:child_process'

const [command = '', ...args] = process.argv.slice(2)
const index = args.indexOf('shell_snapshot')
if (index > 0 && args[index - 1] === '--disable') args.splice(index - 1, 2)
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
child.on('close', (code) => { process.exitCode = code ?? 1 })
