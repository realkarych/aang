import { parseArgs } from 'node:util'
import { openLink, rotateToken } from './access.js'
import { otelConfig } from './admin.js'
import { type HookBinaryLocator, install, uninstall } from './install.js'
import { describeError, type Output, processOutput } from './output.js'
import { daemonCommand, type DaemonProgram, runDaemonProcess, startInBackground, startInForeground } from './start.js'
import { status } from './status.js'
import { stop } from './stop.js'

const usage = `usage: aang <command>

  start [--foreground] [--bind <address>]   start the daemon
  stop                                      stop the daemon and stop collecting hook events
  status                                    show the daemon and the spool
  open                                      print a one-time sign-in link to the UI
  token rotate                              replace the UI token
  install [--claude] [--codex]              connect Claude Code and Codex hooks to aang
  uninstall                                 remove the Claude plugin and neutralize the Codex hooks of aang
  otel-config [--rotate]                    print the [otel] section of the Codex config for aang
`

export interface AangProgram {
  readonly daemon: DaemonProgram
  readonly locateHookBinary: HookBinaryLocator
}

class UsageError extends Error {}

const noArguments = (command: string, args: string[]): void => {
  if (parseArgs({ args, allowPositionals: true, strict: true }).positionals.length > 0) {
    throw new UsageError(`aang ${command} takes no arguments`)
  }
}

const bindOption = { bind: { type: 'string' } } as const

const noPositionals = (command: string, positionals: readonly string[]): void => {
  if (positionals.length > 0) {
    throw new UsageError(`aang ${command} takes no positional arguments`)
  }
}

const dispatch = async (argv: string[], program: AangProgram, output: Output): Promise<number> => {
  const [command, ...args] = argv
  switch (command) {
    case 'start': {
      const { values, positionals } = parseArgs({
        args,
        options: { ...bindOption, foreground: { type: 'boolean', default: false } },
        allowPositionals: true,
        strict: true,
      })
      noPositionals(command, positionals)
      const bind = values.bind ?? null
      return values.foreground
        ? startInForeground(program.daemon, bind, output)
        : startInBackground(program.daemon, bind, output)
    }
    case daemonCommand: {
      const { values } = parseArgs({ args, options: bindOption, strict: true })
      return runDaemonProcess(program.daemon, values.bind ?? null, output)
    }
    case 'stop':
      noArguments(command, args)
      return stop(output)
    case 'status':
      noArguments(command, args)
      return status(output)
    case 'open':
      noArguments(command, args)
      return openLink(output)
    case 'token':
      if (args.length !== 1 || args[0] !== 'rotate') {
        throw new UsageError('usage: aang token rotate')
      }
      return rotateToken(output)
    case 'install': {
      const { values, positionals } = parseArgs({
        args,
        options: { claude: { type: 'boolean', default: false }, codex: { type: 'boolean', default: false } },
        allowPositionals: true,
        strict: true,
      })
      noPositionals(command, positionals)
      return install(output, program.locateHookBinary, values)
    }
    case 'uninstall':
      noArguments(command, args)
      return uninstall(output)
    case 'otel-config': {
      const { values, positionals } = parseArgs({
        args,
        options: { rotate: { type: 'boolean', default: false } },
        allowPositionals: true,
        strict: true,
      })
      noPositionals(command, positionals)
      return otelConfig(output, values.rotate)
    }
    case undefined:
      throw new UsageError('a command is required')
    case 'help':
    case '--help':
    case '-h':
      output.out(usage)
      return 0
    default:
      throw new UsageError(`unknown command '${command}'`)
  }
}

const isUsageError = (error: unknown): boolean =>
  error instanceof UsageError ||
  (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_'))

export const runCli = async (argv: string[], program: AangProgram, output: Output = processOutput): Promise<number> => {
  try {
    return await dispatch(argv, program, output)
  } catch (error) {
    if (isUsageError(error)) {
      output.error(`aang: ${describeError(error)}`)
      output.error(usage)
      return 2
    }
    output.error(`aang ${argv[0] ?? ''}: ${describeError(error)}`)
    return 1
  }
}
