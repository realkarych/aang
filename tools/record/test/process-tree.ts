import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore', windowsHide: true })
writeFileSync(join(process.cwd(), 'pids.json'), JSON.stringify([process.pid, child.pid]))
setInterval(() => undefined, 1000)
