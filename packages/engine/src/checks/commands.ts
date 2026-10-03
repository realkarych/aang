import type { JsonValue } from '@aang/contract'

export const fieldOf = (input: JsonValue, name: string): JsonValue | undefined =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? input[name] : undefined

export type ShellDialect = 'posix' | 'powershell' | 'cmd'

export interface ShellScript {
  readonly script: string
  readonly dialect: ShellDialect
}

const isText = (value: JsonValue): value is string => typeof value === 'string'

const shellFlag = /^-[a-z]*c$/

const powerShells: ReadonlySet<string> = new Set(['pwsh', 'powershell'])

const powerShellFlag = /^-(c|command)$/i

const cmdFlag = /^\/c$/i

const programName = (path: string): string =>
  (path.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '')

const dialectOf = (program: string): ShellDialect => {
  const name = programName(program)
  return powerShells.has(name) ? 'powershell' : name === 'cmd' ? 'cmd' : 'posix'
}

const scriptAfter = (args: readonly string[], flag: RegExp, dialect: ShellDialect): ShellScript[] => {
  const index = args.findIndex((arg) => flag.test(arg))
  const script = args.slice(index + 1).join(' ')
  return index < 0 || script === '' ? [] : [{ script, dialect }]
}

const shellScript = (argv: readonly string[]): ShellScript[] => {
  const [program = '', ...args] = argv
  const dialect = dialectOf(program)
  if (dialect === 'powershell') {
    return scriptAfter(args, powerShellFlag, dialect)
  }
  if (dialect === 'cmd') {
    return scriptAfter(args, cmdFlag, dialect)
  }
  const flag = argv.at(-2)
  const script = argv.at(-1)
  return argv.length >= 3 && flag !== undefined && shellFlag.test(flag) && script !== undefined ? [{ script, dialect }] : []
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
  return typeof command === 'string' ? [command] : [command.join(' '), ...shellScript(command).map(({ script }) => script)]
}

export const shellScripts = (input: JsonValue, dialect: ShellDialect): ShellScript[] => {
  const command = commandOf(input)
  if (command === null) {
    return []
  }
  if (typeof command !== 'string') {
    return shellScript(command)
  }
  const shell = fieldOf(input, 'shell')
  return [{ script: command, dialect: typeof shell === 'string' && shell !== '' ? dialectOf(shell) : dialect }]
}
