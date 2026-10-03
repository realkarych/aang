import { join } from 'node:path'
import type { Config, Runtime } from '@aang/contract'
import { hookInstallPaths } from '@aang/hook'
import { createClaudeBackend, createCodexBackend, createObserverScheduler, type ObserverScheduler } from '@aang/observer'
import type { Store } from '@aang/store'

export interface ObserverOptions {
  readonly store: Store
  readonly config: Config
  readonly aangHome: string
  readonly environment: Readonly<Partial<Record<string, string>>>
}

export interface Observer {
  readonly wake: () => void
  readonly failure: Promise<unknown>
  readonly close: () => Promise<void>
}

type Backend = ReturnType<typeof createClaudeBackend>

const versionCheckMs = 10_000

const deferredAdmissions: ReadonlySet<string | null> = new Set(['admission_busy', 'process_stuck'])

const admissionStatusPath = (aangHome: string, runtime: Runtime): string =>
  join(aangHome, 'support', `${runtime}-observer.json`)

const backendOptions = ({ config, aangHome, environment }: ObserverOptions, runtime: Runtime) => {
  const effort = config.observer.effort[runtime]
  return {
    cli: config.cli[runtime] ?? runtime,
    model: config.observer.models[runtime],
    ...(effort === null ? {} : { effort }),
    timeoutMs: config.observer.timeoutMs[runtime],
    environment,
    windowsLauncher: hookInstallPaths(aangHome).binary,
    admissionStatusPath: admissionStatusPath(aangHome, runtime),
  }
}

export const startObserver = (options: ObserverOptions): Observer => {
  const { store, config } = options
  const backends: Readonly<Record<Runtime, Backend>> = {
    claude: createClaudeBackend(backendOptions(options, 'claude')),
    codex: createCodexBackend(backendOptions(options, 'codex')),
  }
  const controller = new AbortController()
  const failure = Promise.withResolvers<unknown>()
  const checkedVersions = new Map<Backend, string | null>()
  const checks = new Map<Backend, Promise<void>>()
  const timers: NodeJS.Timeout[] = []
  const running: { scheduler: ObserverScheduler | null; closed: boolean } = { scheduler: null, closed: false }

  const admit = async (backend: Backend): Promise<void> => {
    const { version, reason } = await backend.admit(controller.signal)
    if (!deferredAdmissions.has(reason)) {
      checkedVersions.set(backend, version)
    }
  }

  const admitNewVersion = async (backend: Backend): Promise<void> => {
    if (backend.status().state.state !== 'disabled') {
      return
    }
    const version = await backend.cliVersion(controller.signal)
    if (version !== null && version !== checkedVersions.get(backend) && !running.closed) {
      await admit(backend)
    }
  }

  const check = (backend: Backend): void => {
    if (!checks.has(backend)) {
      checks.set(
        backend,
        admitNewVersion(backend)
          .catch(failure.resolve)
          .finally(() => checks.delete(backend)),
      )
    }
  }

  const starting = Promise.all(Object.values(backends).map(admit))
    .then(() => {
      if (running.closed) {
        return
      }
      const scheduler = createObserverScheduler({
        store,
        backends,
        backend: config.observer.backend,
        crossVendor: config.observer.crossVendor,
        budgetTokensPerHour: config.observer.budgetTokensPerHour,
      })
      running.scheduler = scheduler
      void scheduler.failure.then(failure.resolve)
      timers.push(
        setInterval(() => {
          Object.values(backends).forEach(check)
        }, versionCheckMs).unref(),
      )
      scheduler.wake()
    })
    .catch(failure.resolve)

  return {
    wake: () => {
      running.scheduler?.wake()
    },
    failure: failure.promise,
    close: async () => {
      running.closed = true
      timers.forEach(clearInterval)
      controller.abort()
      await starting
      await Promise.all(checks.values())
      await running.scheduler?.close()
    },
  }
}
