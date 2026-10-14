import { posix } from 'node:path'
import type { RegistrationTag, Runtime } from '@catacomb/contract'
import { hookInstallPaths } from './layout.js'
import { leadingWords, posixQuote, powerShellQuote } from './shell.js'

const hookBinaryNames: readonly string[] = ['catacomb-hook', 'catacomb-hook.exe']
const runtime: Runtime = 'codex'
const registration: RegistrationTag = 'user'
const powerShellCall = '&'

export const isCatacombCommand = (command: string): boolean => {
  const words = leadingWords(command, 3)
  const [program = '', subcommand] = words[0] === powerShellCall ? words.slice(1) : words
  const name = posix.basename(program.replaceAll('\\', '/'))
  return hookBinaryNames.includes(name) || (name === 'catacomb' && subcommand === 'hook')
}

export const codexHookCommand = (catacombHome: string): string => {
  const { binary, spool } = hookInstallPaths(catacombHome)
  return process.platform === 'win32'
    ? [powerShellCall, ...[binary, runtime, registration, spool].map(powerShellQuote)].join(' ')
    : [posixQuote(binary), runtime, registration, posixQuote(spool)].join(' ')
}
