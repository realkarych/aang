import { spawn } from 'node:child_process'

const [runtime = '', command = '', ...args] = process.argv.slice(2)
if (runtime === 'claude' && args[args.indexOf('--setting-sources') + 1] === '') args.splice(args.indexOf('--setting-sources'), 2)
if (runtime === 'codex' && args.includes('--disable') && args.includes('hooks')) args.splice(args.indexOf('hooks') - 1, 2)
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
child.on('close', (code) => { process.exitCode = code ?? 1 })
