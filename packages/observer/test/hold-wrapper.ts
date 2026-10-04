import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const [directory = '', command = '', ...args] = process.argv.slice(2)

const appeared = async (name: string): Promise<void> => {
  while (!existsSync(join(directory, name))) await setTimeout(10)
}

const claimed = (): boolean => {
  try {
    closeSync(openSync(join(directory, 'held'), 'wx'))
    return true
  } catch {
    return false
  }
}

const pass = (): void => {
  const child = spawn(command, args, { stdio: 'inherit' })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
}

if (!args.includes('-p')) {
  pass()
} else if (claimed()) {
  const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const [code] = (await once(child, 'close')) as [number | null]
  writeFileSync(join(directory, 'answered'), '')
  await appeared('release')
  process.stderr.write(Buffer.concat(stderr))
  process.stdout.write(Buffer.concat(stdout), () => { process.exitCode = code ?? 1 })
} else {
  await appeared('answered')
  pass()
}
