import type { JsonValue } from '@aang/contract'

export const fieldOf = (input: JsonValue, name: string): JsonValue | undefined =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? input[name] : undefined

const isText = (value: JsonValue): value is string => typeof value === 'string'

const shellFlag = /^-[a-z]*c$/

const powerShells: ReadonlySet<string> = new Set(['pwsh', 'powershell'])

const powerShellFlag = /^-(c|command)$/i

const cmdFlag = /^\/c$/i

const programName = (path: string): string =>
  (path.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '')

const scriptAfter = (args: readonly string[], flag: RegExp): string[] => {
  const index = args.findIndex((arg) => flag.test(arg))
  const script = args.slice(index + 1).join(' ')
  return index < 0 || script === '' ? [] : [script]
}

const shellScript = (argv: readonly string[]): string[] => {
  const [program = '', ...args] = argv
  const name = programName(program)
  if (powerShells.has(name)) {
    return scriptAfter(args, powerShellFlag)
  }
  if (name === 'cmd') {
    return scriptAfter(args, cmdFlag)
  }
  const flag = argv.at(-2)
  const script = argv.at(-1)
  return argv.length >= 3 && flag !== undefined && shellFlag.test(flag) && script !== undefined ? [script] : []
}

const commandOf = (input: JsonValue): string | readonly string[] | null => {
  const command = fieldOf(input, 'command') ?? fieldOf(input, 'cmd')
  if (command === undefined) {
    return null
  }
  if (isText(command)) {
    return command
  }
  return Array.isArray(command) && command.length > 0 && command.every(isText) ? command : null
}

export const commandLines = (input: JsonValue): string[] => {
  const command = commandOf(input)
  if (command === null) {
    return []
  }
  return typeof command === 'string' ? [command] : [command.join(' '), ...shellScript(command)]
}

export const shellScripts = (input: JsonValue): string[] => {
  const command = commandOf(input)
  if (command === null) {
    return []
  }
  return typeof command === 'string' ? [command] : shellScript(command)
}
