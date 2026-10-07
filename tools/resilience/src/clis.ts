import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { windows } from './processes.js'

export type CliName = 'claude' | 'codex'

export interface Cli {
  readonly name: CliName
  readonly command: string
  readonly version: string
}

export type Clis = Readonly<Record<CliName, Cli>>

const onPath = (name: string): string | null => {
  try {
    const output = execFileSync(windows ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true })
    return (
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== '' && (!windows || line.toLowerCase().endsWith('.exe'))) ?? null
    )
  } catch {
    return null
  }
}

const versionOf = (command: string, env: NodeJS.ProcessEnv): string =>
  execFileSync(command, ['--version'], { encoding: 'utf8', env, windowsHide: true, timeout: 60_000 }).trim()

export const locateCli = (name: CliName, override: string | null, env: NodeJS.ProcessEnv): Cli => {
  const found = override ?? onPath(name)
  if (found === null) {
    throw new Error(`${name} is not on PATH; pass --${name} <executable>`)
  }
  const command = realpathSync(found)
  return { name, command, version: versionOf(command, env) }
}
