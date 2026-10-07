import { spawn } from 'node:child_process'
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { buffer } from 'node:stream/consumers'
import { setTimeout } from 'node:timers/promises'

const [mode, directory = '', ...rest] = process.argv.slice(2)

const publish = (name: string, content: string): void => {
  const target = join(directory, name)
  writeFileSync(`${target}.tmp`, content)
  renameSync(`${target}.tmp`, target)
}

const published = async (name: string): Promise<void> => {
  while (!existsSync(join(directory, name))) {
    await setTimeout(10)
  }
}

const stayAlive = (): void => {
  setInterval(() => undefined, 60_000)
}

const startDescendant = async (): Promise<void> => {
  spawn(process.execPath, [import.meta.filename, 'descendant', directory], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref()
  await published('descendant.pid')
}

switch (mode) {
  case 'echo': {
    const [exitCode = '0', ...args] = rest
    const input = await buffer(process.stdin)
    publish('report.json', JSON.stringify({ args, cwd: process.cwd(), probe: process.env.AANG_LAUNCH_PROBE ?? null }))
    process.stderr.write('cli stderr')
    process.stdout.write(input)
    process.exitCode = Number(exitCode)
    break
  }
  case 'orphan':
    await startDescendant()
    break
  case 'reply':
    publish('root.pid', String(process.pid))
    for await (const line of createInterface({ input: process.stdin })) {
      process.stdout.write(`reply ${line}\n`)
    }
    stayAlive()
    break
  case 'hold':
    await startDescendant()
    publish('root.pid', String(process.pid))
    stayAlive()
    break
  case 'descendant':
    publish('descendant.pid', String(process.pid))
    stayAlive()
    break
  case 'parent': {
    const [binary = '', ...launchArgs] = rest
    const launcher = spawn(binary, ['launch', ...launchArgs], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    publish('launcher.pid', String(launcher.pid))
    stayAlive()
    break
  }
  default:
    throw new Error(`unknown process tree mode ${String(mode)}`)
}
