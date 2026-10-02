import { type ChildProcess, spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { resolve as absolutePath } from 'node:path'
import { Listener } from '@aang/contract'
import { type ConfigEnvironment, loadConfig, processEnvironment } from '@aang/contract/config-file'
import { type AangHomePaths, aangHomePaths } from '@aang/contract/home'
import { z } from 'zod'
import { daemonUrl } from './daemon-process.js'
import { ensureUiToken, preparePrivateHome } from './home.js'
import { type Output, describeError } from './output.js'

export const daemonCommand = '__daemon'

export interface DaemonReady {
  readonly pid: number
  readonly api: Listener
}

export interface DaemonRunOptions {
  readonly environment: ConfigEnvironment
  readonly bind: string | null
  readonly signal: AbortSignal
  readonly onReady: (ready: DaemonReady) => void
}

export interface DaemonProgram {
  readonly command: string
  readonly args: readonly string[]
  readonly run: (options: DaemonRunOptions) => Promise<string>
}

const DaemonReport = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), pid: z.int().positive(), api: Listener }),
  z.strictObject({ type: z.literal('failed'), message: z.string() }),
])
type DaemonReport = z.infer<typeof DaemonReport>

type Outcome =
  | DaemonReport
  | { readonly type: 'exited'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: 'timeout' }

const readyTimeoutMs = 60_000

const bindArguments = (bind: string | null): string[] => (bind === null ? [] : ['--bind', bind])

const pathVariables = ['AANG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const

const daemonEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  ...Object.fromEntries(
    pathVariables.flatMap((name) => {
      const value = env[name]
      return value === undefined || value === '' ? [] : [[name, absolutePath(value)]]
    }),
  ),
})

const prepareHome = async (environment: ConfigEnvironment): Promise<AangHomePaths> => {
  const { aangHome } = await loadConfig(environment)
  const paths = aangHomePaths(aangHome)
  await preparePrivateHome(paths)
  await ensureUiToken(paths)
  return paths
}

const awaitOutcome = (child: ChildProcess): Promise<Outcome> =>
  new Promise((resolve) => {
    const onMessage = (message: unknown): void => {
      const report = DaemonReport.safeParse(message)
      settle(report.success ? report.data : { type: 'failed', message: 'the daemon sent an unexpected message' })
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle({ type: 'exited', code, signal })
    }
    const onError = (error: Error): void => {
      settle({ type: 'failed', message: error.message })
    }
    const timer = setTimeout(() => {
      settle({ type: 'timeout' })
    }, readyTimeoutMs)
    const settle = (outcome: Outcome): void => {
      clearTimeout(timer)
      child.off('message', onMessage).off('exit', onExit).off('error', onError)
      resolve(outcome)
    }
    child.on('message', onMessage).on('exit', onExit).on('error', onError)
  })

const detach = (child: ChildProcess): void => {
  if (child.connected) {
    child.disconnect()
  }
  child.unref()
}

const announce = (output: Output, ready: DaemonReady, mode: string): void => {
  output.out(`aang ${mode}: pid ${String(ready.pid)}, ${daemonUrl(ready.api)}`)
  output.out('Run `aang open` to sign in to the UI.')
}

export const startInBackground = async (program: DaemonProgram, bind: string | null, output: Output): Promise<number> => {
  const paths = await prepareHome(processEnvironment())
  const log = await open(paths.daemonLog, 'a', 0o600)
  let child: ChildProcess
  try {
    child = spawn(program.command, [...program.args, daemonCommand, ...bindArguments(bind)], {
      cwd: paths.home,
      env: daemonEnvironment(process.env),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
    })
  } finally {
    await log.close()
  }
  const outcome = await awaitOutcome(child)
  detach(child)
  switch (outcome.type) {
    case 'ready':
      announce(output, outcome, 'started')
      return 0
    case 'failed':
      output.error(`aang start: ${outcome.message}`)
      return 1
    case 'exited':
      output.error(
        `aang start: the daemon exited (${String(outcome.code ?? outcome.signal)}) before it was ready; see ${paths.daemonLog}`,
      )
      return 1
    case 'timeout':
      output.error(
        `aang start: the daemon did not report readiness within ${String(readyTimeoutMs / 1000)} s; see ${paths.daemonLog} and \`aang status\``,
      )
      return 1
  }
}

const abortOnSignals = (controller: AbortController): (() => void) => {
  const abort = (): void => {
    controller.abort()
  }
  process.on('SIGINT', abort)
  process.on('SIGTERM', abort)
  return () => {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}

const stoppedBeforeReady = (reason: string): string =>
  reason === 'stop_marker'
    ? '`aang stop` was requested while the daemon was starting'
    : `the daemon stopped (${reason}) before it was ready`

export const startInForeground = async (program: DaemonProgram, bind: string | null, output: Output): Promise<number> => {
  const environment = processEnvironment()
  await prepareHome(environment)
  const controller = new AbortController()
  const release = abortOnSignals(controller)
  try {
    const reason = await program.run({
      environment,
      bind,
      signal: controller.signal,
      onReady: (ready) => {
        announce(output, ready, 'running in the foreground')
      },
    })
    output.out(`aang stopped: ${reason}`)
    return 0
  } finally {
    release()
  }
}

const sendToParent = (report: DaemonReport): Promise<void> =>
  new Promise((resolve) => {
    if (process.send === undefined || !process.connected) {
      resolve()
      return
    }
    process.send(report, undefined, {}, () => {
      if (process.connected) {
        process.disconnect?.()
      }
      resolve()
    })
  })

export const runDaemonProcess = async (program: DaemonProgram, bind: string | null, output: Output): Promise<number> => {
  const controller = new AbortController()
  const release = abortOnSignals(controller)
  const readiness = { reported: false }
  try {
    const reason = await program.run({
      environment: processEnvironment(),
      bind,
      signal: controller.signal,
      onReady: (info) => {
        readiness.reported = true
        output.out(`aang daemon ${String(info.pid)} listening on ${daemonUrl(info.api)}`)
        void sendToParent({ type: 'ready', pid: info.pid, api: info.api })
      },
    })
    if (!readiness.reported) {
      await sendToParent({ type: 'failed', message: stoppedBeforeReady(reason) })
      return 1
    }
    output.out(`aang daemon ${String(process.pid)} stopped: ${reason}`)
    return 0
  } catch (error) {
    output.error(`aang daemon: ${describeError(error)}`)
    await sendToParent({ type: 'failed', message: describeError(error) })
    return 1
  } finally {
    release()
  }
}
