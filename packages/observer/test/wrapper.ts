import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { buffer } from 'node:stream/consumers'

const [mode, wrapperPid = '', childPid = '', command = '', ...args] = process.argv.slice(2)
const exec = args.includes('exec')
const input = await buffer(process.stdin)
const child = spawn(command, args, { stdio: ['pipe', exec && mode === 'exit' ? 'ignore' : 'inherit', exec && mode === 'exit' ? 'ignore' : 'inherit'], windowsHide: true })
child.stdin.end(input)
child.stdin.on('error', () => undefined)
if (exec) {
  writeFileSync(`${wrapperPid}.parent`, String(process.ppid))
  writeFileSync(wrapperPid, String(process.pid))
  writeFileSync(childPid, String(child.pid))
}
if (exec && mode === 'exit') child.unref()
else child.on('exit', (code) => { process.exitCode = code ?? 1 })
