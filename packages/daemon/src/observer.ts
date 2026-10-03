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

const readmissionRetryMs = 1_000

const retriedAdmissions: ReadonlySet<string> = new Set(['admission_busy', 'process_stuck'])

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
  const admissions = new Set<Promise<unknown>>()
  const watches: (() => void)[] = []
  const running: { scheduler: ObserverScheduler | null; closed: boolean } = { scheduler: null, closed: false }

  const admit = (backend: Backend): void => {
    const admission = backend
      .admit(controller.signal)
      .then(({ reason }) => {
        if (reason !== null && retriedAdmissions.has(reason)) {
          retry(backend)
        }
      })
      .catch(failure.resolve)
    admissions.add(admission)
    void admission.finally(() => admissions.delete(admission))
  }

  const retry = (backend: Backend): void => {
    setTimeout(() => {
      if (!running.closed) {
        admit(backend)
      }
    }, readmissionRetryMs).unref()
  }

  const readmitOnNewVersion = (backend: Backend): (() => void) => {
    let admitted = backend.admission().admitted
    return backend.subscribe(({ state }) => {
      const { admitted: current, reason } = backend.admission()
      if (current) {
        admitted = true
      } else if (
        admitted &&
        reason !== 'admission_pending' &&
        state.state === 'disabled' &&
        state.reason === 'version_not_admitted'
      ) {
        admitted = false
        retry(backend)
      }
    })
  }

  const starting = Promise.all(Object.values(backends).map((backend) => backend.admit(controller.signal)))
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
      watches.push(...Object.values(backends).map(readmitOnNewVersion))
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
      controller.abort()
      for (const unwatch of watches) {
        unwatch()
      }
      await starting
      await Promise.all(admissions)
      await running.scheduler?.close()
    },
  }
}
