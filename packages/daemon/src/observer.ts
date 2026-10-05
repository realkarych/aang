import { join } from 'node:path'
import {
  type Admission,
  type AdmissionOutcome,
  type ChatMessage,
  type ChatQuestionRequest,
  type Config,
  EpochNs,
  type ObserverBackendStatus,
  type ObserverState,
  type Run,
  type RunId,
  type Runtime,
  runtimes,
} from '@aang/contract'
import { defaultChatLimits, type ObserverRunStatus } from '@aang/engine'
import { hookInstallPaths } from '@aang/hook'
import {
  type AdmissionStatus,
  type ChatSlot,
  createChat,
  createClaudeBackend,
  createCodexBackend,
  createObserverScheduler,
  type ObserverScheduler,
} from '@aang/observer'
import type { Store } from '@aang/store'

export interface ObserverOptions {
  readonly store: Store
  readonly config: Config
  readonly aangHome: string
  readonly claudeConfigDir: string
  readonly environment: Readonly<Partial<Record<string, string>>>
}

export interface Observer {
  readonly wake: () => void
  readonly backends: () => ObserverBackendStatus[]
  readonly run: (run: Run) => ObserverRunStatus
  readonly ask: (run: RunId, request: ChatQuestionRequest) => ChatMessage | null
  readonly subscribe: (listener: () => void) => void
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

const outcomeOf = ({ admitted, reason }: AdmissionStatus): AdmissionOutcome =>
  admitted ? 'admitted' : reason === 'admission_pending' ? 'pending' : 'failed'

const admissionOf = (status: AdmissionStatus): Admission | null => {
  if (status.version === null || status.checkedAt === null) {
    return null
  }
  const outcome = outcomeOf(status)
  return {
    vendor: status.runtime,
    cli_version: status.version,
    outcome,
    failure: outcome === 'failed' ? status.reason : null,
    cross_session_inbound_verified: status.admitted && status.warning === null,
    checked_at: EpochNs.parse(BigInt(Date.parse(status.checkedAt)) * 1_000_000n),
  }
}

export const startObserver = (options: ObserverOptions): Observer => {
  const { store, config, claudeConfigDir } = options
  const backends: Readonly<Record<Runtime, Backend>> = {
    claude: createClaudeBackend(backendOptions(options, 'claude')),
    codex: createCodexBackend(backendOptions(options, 'codex')),
  }
  const controller = new AbortController()
  const failure = Promise.withResolvers<unknown>()
  const checkedVersions = new Map<Backend, string | null>()
  const checks = new Map<Backend, Promise<void>>()
  const timers: NodeJS.Timeout[] = []
  const listeners = new Set<() => void>()
  const running: { scheduler: ObserverScheduler | null; closed: boolean } = { scheduler: null, closed: false }

  const changed = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }

  const unsubscribes = Object.values(backends).map((backend) => backend.subscribe(changed))

  const stateOf = (runtime: Runtime): ObserverState =>
    running.scheduler?.backendState(runtime) ?? backends[runtime].status().state

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
        claudeConfigDir,
        budgetTokensPerHour: config.observer.budgetTokensPerHour,
        limits: { inputTokens: config.observer.inputLimitTokens },
      })
      running.scheduler = scheduler
      unsubscribes.push(scheduler.subscribe(changed))
      void scheduler.failure.then(failure.resolve)
      timers.push(
        setInterval(() => {
          Object.values(backends).forEach(check)
        }, versionCheckMs).unref(),
      )
      scheduler.wake()
      changed()
    })
    .catch(failure.resolve)

  const slot: ChatSlot = async (work) => {
    await starting
    if (running.scheduler === null || running.closed) {
      throw new Error('the observer is stopping')
    }
    return running.scheduler.chat(work)
  }

  const chat = createChat({
    store,
    backends,
    backend: config.observer.backend,
    crossVendor: config.observer.crossVendor,
    slot,
    limits: { ...defaultChatLimits, inputTokens: config.observer.inputLimitTokens },
  })
  void chat.failure.then(failure.resolve)

  return {
    wake: () => {
      running.scheduler?.wake()
    },
    backends: () =>
      runtimes.map((runtime) => {
        const admission = backends[runtime].admission()
        return {
          vendor: runtime,
          state: stateOf(runtime),
          cli_path: config.cli[runtime],
          cli_version: admission.version,
          model: config.observer.models[runtime],
          effort: config.observer.effort[runtime],
          admission: admissionOf(admission),
        }
      }),
    run: ({ id, runtime }) => {
      const backend = config.observer.backend ?? runtime
      const { admitted, warning } = backends[backend].admission()
      return {
        state: running.scheduler?.state(id) ?? stateOf(backend),
        isolation_unverified: admitted && warning !== null,
      }
    },
    ask: chat.ask,
    subscribe: (listener) => {
      listeners.add(listener)
    },
    failure: failure.promise,
    close: async () => {
      running.closed = true
      timers.forEach(clearInterval)
      controller.abort()
      await starting
      await Promise.all(checks.values())
      await running.scheduler?.close()
      await chat.close()
      unsubscribes.forEach((unsubscribe) => {
        unsubscribe()
      })
      listeners.clear()
    },
  }
}
