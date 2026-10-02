import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const [helper = '', directory = '', command = '', ...args] = process.argv.slice(2)
if (args.includes('-p')) {
  const zombie = join(directory, 'zombie.pid')
  const reaper = spawn(helper, [zombie, join(directory, 'reaper.pid'), join(directory, 'release')], { stdio: 'ignore' })
  reaper.unref()
  while (!existsSync(join(directory, 'reaper.pid')) || !existsSync(zombie)) await setTimeout(10)
}
const child = spawn(command, args, { stdio: 'inherit' })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
