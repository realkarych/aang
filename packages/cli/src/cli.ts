import { parseArgs } from 'node:util'
import { type EpochNs, type PruneRequest, RunId, UsageQuery } from '@aang/contract'
import { openLink, rotateToken } from './access.js'
import { epochOfDate, otelConfig, prune, reparse, unwatch, watch } from './admin.js'
import { type HookBinaryLocator, install, uninstall } from './install.js'
import { describeError, type Output, processOutput } from './output.js'
import { daemonCommand, type DaemonProgram, runDaemonProcess, startInBackground, startInForeground } from './start.js'
import { status } from './status.js'
import { stop } from './stop.js'
import { reportUsage } from './usage.js'

const usage = `usage: aang <command>

  start [--foreground] [--bind <address>]   start the daemon
  stop                                      stop the daemon and stop collecting hook events
  status                                    show the daemon and the spool
  open                                      print a one-time sign-in link to the UI
  token rotate                              replace the UI token
  reparse                                   parse stored records again with the current normalizers
  watch <directory> [--lookback <days>]     watch a project and reread its sessions within the lookback
  watch --all [--lookback <days>]           watch every session
  unwatch <directory> | --all               stop taking new records of a watched root
  prune --run <id> | --before <date>        delete runs with all their records
  usage [--run <id>] [--from <date>] [--to <date>]
                                            show the solver, observer and chat usage
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

const lookbackDays = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null
  }
  const days = /^([1-9][0-9]*)d?$/.exec(value)?.[1]
  if (days === undefined || !Number.isSafeInteger(Number(days))) {
    throw new UsageError(`--lookback takes a positive number of days, got '${value}'`)
  }
  return Number(days)
}

const watchTarget = (
  command: string,
  all: boolean,
  positionals: readonly string[],
): { readonly path: string } | { readonly all: true } => {
  const [path, ...rest] = positionals
  if (all ? path !== undefined : path === undefined || rest.length > 0) {
    throw new UsageError(`aang ${command} takes one directory or --all`)
  }
  return path === undefined ? { all: true } : { path }
}

const runIdOf = (value: string): RunId => {
  const parsed = RunId.safeParse(value)
  if (!parsed.success) {
    throw new UsageError(`'${value}' is not a run id`)
  }
  return parsed.data
}

const pruneRequest = (run: string | undefined, before: string | undefined): PruneRequest => {
  if ((run === undefined) === (before === undefined)) {
    throw new UsageError('aang prune takes --run <id> or --before <date>')
  }
  if (run !== undefined) {
    return { scope: 'run', run: runIdOf(run) }
  }
  const at = epochOfDate(before ?? '')
  if (at === null) {
    throw new UsageError(`'${before ?? ''}' is not a date`)
  }
  return { scope: 'before', before: at }
}

const noPositionals = (command: string, positionals: readonly string[]): void => {
  if (positionals.length > 0) {
    throw new UsageError(`aang ${command} takes no positional arguments`)
  }
}

const dateOption = (option: string, value: string | undefined): EpochNs | undefined => {
  if (value === undefined) {
    return undefined
  }
  const at = epochOfDate(value)
  if (at === null) {
    throw new UsageError(`--${option} takes a date, got '${value}'`)
  }
  return at
}

const usageQuery = (run: string | undefined, from: string | undefined, to: string | undefined): UsageQuery => {
  const query = UsageQuery.safeParse({
    ...(run === undefined ? {} : { run: runIdOf(run) }),
    from: dateOption('from', from),
    to: dateOption('to', to),
  })
  if (!query.success) {
    throw new UsageError('--from must precede --to')
  }
  return query.data
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
    case 'reparse':
      noArguments(command, args)
      return reparse(output)
    case 'watch': {
      const { values, positionals } = parseArgs({
        args,
        options: { all: { type: 'boolean', default: false }, lookback: { type: 'string' } },
        allowPositionals: true,
        strict: true,
      })
      return watch(output, watchTarget(command, values.all, positionals), lookbackDays(values.lookback))
    }
    case 'unwatch': {
      const { values, positionals } = parseArgs({
        args,
        options: { all: { type: 'boolean', default: false } },
        allowPositionals: true,
        strict: true,
      })
      return unwatch(output, watchTarget(command, values.all, positionals))
    }
    case 'prune': {
      const { values, positionals } = parseArgs({
        args,
        options: { run: { type: 'string' }, before: { type: 'string' } },
        allowPositionals: true,
        strict: true,
      })
      if (positionals.length > 0) {
        throw new UsageError('aang prune takes no positional arguments')
      }
      return prune(output, pruneRequest(values.run, values.before))
    }
    case 'usage': {
      const { values, positionals } = parseArgs({
        args,
        options: { run: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
        allowPositionals: true,
        strict: true,
      })
      if (positionals.length > 0) {
        throw new UsageError('aang usage takes no positional arguments')
      }
      return reportUsage(output, usageQuery(values.run, values.from, values.to))
    }
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
