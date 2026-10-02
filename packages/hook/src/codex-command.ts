import { posix } from 'node:path'
import { leadingWords } from './shell.js'

const hookBinaryNames: readonly string[] = ['aang-hook', 'aang-hook.exe']

export const isAangCommand = (command: string): boolean => {
  const [program = '', subcommand] = leadingWords(command, 2)
  const name = posix.basename(program.replaceAll('\\', '/'))
  return hookBinaryNames.includes(name) || (name === 'aang' && subcommand === 'hook')
}
