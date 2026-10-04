import { posix } from 'node:path'
import type { RegistrationTag, Runtime } from '@aang/contract'
import { hookInstallPaths } from './layout.js'
import { leadingWords, posixQuote } from './shell.js'

const hookBinaryNames: readonly string[] = ['aang-hook', 'aang-hook.exe']
const runtime: Runtime = 'codex'
const registration: RegistrationTag = 'user'

export const isAangCommand = (command: string): boolean => {
  const [program = '', subcommand] = leadingWords(command, 2)
  const name = posix.basename(program.replaceAll('\\', '/'))
  return hookBinaryNames.includes(name) || (name === 'aang' && subcommand === 'hook')
}

export const codexHookCommand = (aangHome: string): string => {
  const { binary, spool } = hookInstallPaths(aangHome)
  return [posixQuote(binary), runtime, registration, posixQuote(spool)].join(' ')
}
