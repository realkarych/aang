import { posix } from 'node:path'
import type { RegistrationTag, Runtime } from '@aang/contract'
import { hookInstallPaths } from './layout.js'
import { leadingWords, posixQuote, powerShellQuote } from './shell.js'

const hookBinaryNames: readonly string[] = ['aang-hook', 'aang-hook.exe']
const runtime: Runtime = 'codex'
const registration: RegistrationTag = 'user'
const powerShellCall = '&'

export const isAangCommand = (command: string): boolean => {
  const words = leadingWords(command, 3)
  const [program = '', subcommand] = words[0] === powerShellCall ? words.slice(1) : words
  const name = posix.basename(program.replaceAll('\\', '/'))
  return hookBinaryNames.includes(name) || (name === 'aang' && subcommand === 'hook')
}

export const codexHookCommand = (aangHome: string): string => {
  const { binary, spool } = hookInstallPaths(aangHome)
  return process.platform === 'win32'
    ? [powerShellCall, ...[binary, runtime, registration, spool].map(powerShellQuote)].join(' ')
    : [posixQuote(binary), runtime, registration, posixQuote(spool)].join(' ')
}
