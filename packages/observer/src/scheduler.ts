import { randomUUID } from 'node:crypto'
import { EpochNs, ObserverCallId, type ObserverInput, type ObserverState, type RunId, type Runtime, runtimes } from '@aang/contract'
import {
  applyObserverResponse,
  beginObserverFollowUp,
  boundObserverQueue,
  exhaustObserverCall,
  failObserverCall,
  type ObserverResponseResult,
  startObserverBatch,
} from '@aang/engine'
import type { PendingFact, Store, Transaction } from '@aang/store'
import type { AuthResult, LaunchFailure, ObserverRequest, ObserverResult } from './backend.js'
import type { LaunchStatus } from './process.js'
import {
  afterAuthCheck,
  afterFailure,
  type Health,
  healthState,
  healthy,
  probeInput,
  type RecoveryLimits,
  recoverySetting,
  storedError,
  storedHealth,
  waiting,
} from './recovery.js'

export interface ObserverExecutor {
  readonly execute: (request: ObserverRequest) => Promise<ObserverResult>
  readonly authStatus: (signal?: AbortSignal) => Promise<AuthResult>
  readonly status: () => LaunchStatus
  readonly subscribe: (listener: (status: LaunchStatus) => void) => () => void
}

export interface SchedulerClock {
  readonly now: () => number
  readonly schedule: (delayMs: number, task: () => void) => () => void
}

export interface SchedulerLimits extends RecoveryLimits {
  readonly batchFacts: number
  readonly batchBytes: number
  readonly textLength: number
  readonly delayMs: number
  readonly budgetDelayMs: number
  readonly intervalMs: number
  readonly concurrency: number
  readonly queueFacts: number
  readonly queueAgeMs: number
  readonly catchUpMs: number
  readonly attempts: number
}

export interface SchedulerOptions {
  readonly store: Store
  readonly backends: Partial<Record<Runtime, ObserverExecutor>>
  readonly backend?: Runtime | null
  readonly crossVendor?: boolean
  readonly budgetTokensPerHour?: number | null
  readonly clock?: SchedulerClock
  readonly limits?: Partial<SchedulerLimits>
}

export interface ObserverScheduler {
  readonly wake: () => void
  readonly chat: <T extends Pick<ObserverResult, 'stopped'>>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>
  readonly state: (run: RunId) => ObserverState
  readonly backendState: (backend: Runtime) => ObserverState
  readonly subscribe: (listener: () => void) => () => void
  readonly idle: () => Promise<void>
  readonly close: () => Promise<void>
  readonly failure: Promise<unknown>
}

interface Recovery {
  health: Health
  generation: number
  inflight: number
  disabled: boolean
}

interface Backend {
  readonly runtime: Runtime
  readonly executor: ObserverExecutor
  readonly recovery: Recovery
}

interface Queue {
  readonly run: RunId
  readonly queued: readonly PendingFact[]
  readonly backlog: boolean
}

interface Candidate extends Backend {
  readonly run: RunId
  readonly due: number
  readonly order: number
}

interface Budget {
  readonly over: boolean
  readonly freesAt: number | null
}

interface Stopping {
  readonly stopped: Promise<void>
}

const defaultLimits: SchedulerLimits = {
  batchFacts: 30,
  batchBytes: 96_000,
  textLength: 4_000,
  delayMs: 5_000,
  budgetDelayMs: 60_000,
  intervalMs: 10_000,
  concurrency: 2,
  queueFacts: 2_000,
  queueAgeMs: 24 * 60 * 60 * 1_000,
  catchUpMs: 5 * 60 * 1_000,
  attempts: 3,
  backoffMs: 10_000,
  backoffMaxMs: 5 * 60 * 1_000,
  backoffAttempts: 6,
  authCheckMs: 10 * 60 * 1_000,
  probeMs: 30 * 60 * 1_000,
  probeMaxMs: 4 * 60 * 60 * 1_000,
}

const hourMs = 60 * 60 * 1_000

const longestTimerMs = 2_147_483_647

export const systemClock: SchedulerClock = {
  now: () => Date.now(),
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, Math.min(delayMs, longestTimerMs)).unref()
    return () => {
      clearTimeout(timer)
    }
  },
}

const epoch = (milliseconds: number): EpochNs => EpochNs.parse(BigInt(Math.trunc(milliseconds)) * 1_000_000n)

const millisecondsOf = (value: EpochNs): number => Number(value / 1_000_000n)

const available = (executor: ObserverExecutor): boolean => {
  const { state } = executor.status().state
  return state !== 'disabled' && state !== 'unavailable'
}

const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0

export const createObserverScheduler = (options: SchedulerOptions): ObserverScheduler => {
  const { store, backends, backend: override = null, crossVendor = false, budgetTokensPerHour: budget = null } = options
  const clock = options.clock ?? systemClock
  const limits: SchedulerLimits = { ...defaultLimits, ...options.limits }
  if (!Object.values(limits).every(positive) || (budget !== null && !positive(budget))) {
    throw new RangeError('scheduler limits must be positive integers')
  }
  store.transaction((transaction) => {
    for (const call of transaction.observerCalls.unfinished()) {
      failObserverCall(transaction, { call, outcome: 'failed', at: epoch(clock.now()) })
    }
  })
  const configured = runtimes.flatMap((runtime): Backend[] => {
    const executor = backends[runtime]
    return executor === undefined
      ? []
      : [
          {
            runtime,
            executor,
            recovery: {
              health: storedHealth(store.settings.get(recoverySetting(runtime))),
              generation: 0,
              inflight: 0,
              disabled: executor.status().state.state === 'disabled',
            },
          },
        ]
  })
  const backendOf = (runtime: Runtime): Backend | undefined => configured.find((entry) => entry.runtime === runtime)
  const running = new Map<RunId, Promise<undefined>>()
  const checks = new Map<Runtime, Promise<undefined>>()
  const settling = new Set<Promise<unknown>>()
  const listeners = new Set<() => void>()
  const controller = new AbortController()
  const closing = Promise.withResolvers<undefined>()
  const failure = Promise.withResolvers<unknown>()
  let chatTail: Promise<unknown> = Promise.resolve()
  let chatWork: Promise<unknown> = Promise.resolve()
  let cancelTimer: (() => void) | null = null
  let planRequested = false
  let published = ''
  let closed = false

  const after = (health: Health, failed: LaunchFailure | null, now: number): Health =>
    failed === null ? healthy : afterFailure(health, failed, now, limits)

  const transit = (transaction: Transaction, { runtime, recovery }: Backend, started: number, next: Health, now: number): Health | null => {
    if (next === recovery.health || started !== recovery.generation) {
      return null
    }
    if (next.kind === 'ok') {
      transaction.settings.remove(recoverySetting(runtime))
    } else {
      transaction.settings.save(recoverySetting(runtime), next, epoch(now))
    }
    return next
  }

  const adopt = (recovery: Recovery, next: Health | null): void => {
    if (next !== null) {
      recovery.health = next
      recovery.generation += 1
    }
  }

  const runtimeOf = (run: RunId): Runtime | null => {
    const entity = store.model.entity(run, { kind: 'run', id: run })
    return entity?.kind === 'run' ? entity.value.runtime : null
  }

  const budgetOf = (now: number): Budget => {
    if (budget === null) {
      return { over: false, freesAt: null }
    }
    const { tokens, earliest } = store.observerCalls.spending(epoch(now - hourMs))
    return tokens > budget && earliest !== null
      ? { over: true, freesAt: millisecondsOf(earliest) + hourMs + 1 }
      : { over: false, freesAt: null }
  }

  const lagFrom = (queued: readonly PendingFact[]): number =>
    Math.min(...queued.map(({ observed_at: observed }) => millisecondsOf(observed))) + limits.catchUpMs + 1

  const behind = (queued: readonly PendingFact[], now: number): boolean => queued.length > 0 && lagFrom(queued) <= now

  const backendStateOf = (runtime: Runtime, over: boolean): ObserverState => {
    const entry = backendOf(runtime)
    if (entry === undefined) {
      return { state: 'disabled', reason: 'cli_missing' }
    }
    const own = entry.executor.status().state
    if (own.state === 'disabled' || own.state === 'unavailable') {
      return own
    }
    return healthState(entry.recovery.health) ?? (over ? { state: 'lagging', reason: 'budget' } : own)
  }

  const runStateOf = ({ run, queued, backlog }: Queue, now: number, over: boolean): ObserverState => {
    const runtime = override ?? runtimeOf(run)
    if (runtime === null) {
      return { state: 'ok' }
    }
    const current = backendStateOf(runtime, over)
    return (current.state === 'ok' || current.state === 'lagging') && (backlog || behind(queued, now))
      ? { state: 'lagging', reason: 'backlog' }
      : current
  }

  const publish = (over: boolean, lagging: readonly RunId[]): void => {
    const signature = JSON.stringify(
      {
        backends: configured.map(({ runtime, executor, recovery }) => [runtime, executor.status().state, recovery.health]),
        over,
        lagging,
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    )
    if (signature !== published) {
      published = signature
      for (const listener of listeners) {
        listener()
      }
    }
  }

  const queueOf = (run: RunId, now: number): PendingFact[] =>
    store.transaction((transaction) =>
      boundObserverQueue(transaction, { run, at: epoch(now), bounds: { facts: limits.queueFacts, ageMs: limits.queueAgeMs } }),
    )

  const expiryOf = (queued: readonly PendingFact[]): number =>
    Math.min(...queued.map(({ at }) => millisecondsOf(at))) + limits.queueAgeMs + 1

  const candidateOf = ({ run, queued }: Queue, now: number, over: boolean): Candidate | null => {
    const runtime = override ?? runtimeOf(run)
    const entry = runtime === null ? undefined : backendOf(runtime)
    if (entry === undefined || !available(entry.executor)) {
      return null
    }
    const { health } = entry.recovery
    if (waiting(health)) {
      return null
    }
    const bytes = queued.reduce((total, pending) => total + pending.bytes, 0)
    const full = queued.length >= limits.batchFacts || bytes >= limits.batchBytes
    const oldest = Math.min(...queued.map(({ observed_at: observed }) => millisecondsOf(observed)))
    const ready =
      queued.length === 0 || full || queued.some(({ urgent }) => urgent) ? now : oldest + (over ? limits.budgetDelayMs : limits.delayMs)
    const latest = store.observerCalls.latest(run)
    const due = Math.max(
      ready,
      latest === null ? -Infinity : millisecondsOf(latest.started_at) + limits.intervalMs,
      health.kind === 'backoff' ? health.until : -Infinity,
    )
    return { ...entry, run, due, order: Math.min(...queued.map(({ seq }) => seq), Number.MAX_SAFE_INTEGER) }
  }

  const record = (transaction: Transaction, call: ObserverCallId, result: ObserverResult, at: EpochNs): ObserverResponseResult | null => {
    if (!result.ok) {
      const error = storedError(result.error)
      if (result.error.class === 'invalid_output') {
        failObserverCall(transaction, { call, outcome: 'rejected', message: result.error.message, error, at, usage: result.usage })
        exhaustObserverCall(transaction, { call, attempts: limits.attempts, at })
      } else {
        failObserverCall(transaction, { call, outcome: 'failed', error, at, usage: result.usage })
      }
      return null
    }
    const response = applyObserverResponse(transaction, { call, output: result.output, at, usage: result.usage })
    if (response.status === 'rejected') {
      exhaustObserverCall(transaction, { call, attempts: limits.attempts, at })
    }
    return response
  }

  const invoke = async (
    candidate: Candidate,
    call: ObserverCallId,
    input: ObserverInput,
    stopped: Promise<void>[],
  ): Promise<ObserverResponseResult | null> => {
    const { executor, recovery } = candidate
    const started = recovery.generation
    const result = await executor.execute({ input, signal: controller.signal })
    stopped.push(result.stopped)
    const { response, next } = store.transaction((transaction) => {
      const now = clock.now()
      return {
        response: record(transaction, call, result, epoch(now)),
        next: transit(transaction, candidate, started, after(recovery.health, result.ok ? null : result.error, now), now),
      }
    })
    adopt(recovery, next)
    return response
  }

  const perform = async (candidate: Candidate, call: ObserverCallId, input: ObserverInput, stopped: Promise<void>[]): Promise<void> => {
    const { recovery } = candidate
    recovery.inflight += 1
    try {
      const first = await invoke(candidate, call, input, stopped)
      if (first?.status !== 'needs_requested') {
        return
      }
      const followUp = ObserverCallId.parse(randomUUID())
      const materials = store.transaction((transaction) =>
        beginObserverFollowUp(transaction, { previous: call, id: followUp, at: epoch(clock.now()), crossVendor }),
      )
      await invoke(candidate, followUp, materials, stopped)
    } finally {
      recovery.inflight -= 1
    }
  }

  const occupied = (): number => running.size + checks.size

  const launch = (candidate: Candidate): void => {
    const { run, runtime } = candidate
    const call = ObserverCallId.parse(randomUUID())
    const input = store.transaction((transaction) =>
      startObserverBatch(transaction, {
        run,
        backend: runtime,
        crossVendor,
        id: call,
        at: epoch(clock.now()),
        limits: { facts: limits.batchFacts, bytes: limits.batchBytes, textLength: limits.textLength },
        catchUpMs: limits.catchUpMs,
      }),
    )
    if (input === null) {
      return
    }
    const finished = Promise.withResolvers<undefined>()
    const stopped: Promise<void>[] = []
    running.set(run, finished.promise)
    const results = perform(candidate, call, input, stopped).catch(failure.resolve)
    settling.add(results)
    void results
      .then(() => {
        settling.delete(results)
        return Promise.all(stopped)
      })
      .finally(() => {
        running.delete(run)
        finished.resolve(undefined)
        plan()
      })
  }

  const check = async (backend: Backend): Promise<Stopping> => {
    const { runtime, executor, recovery } = backend
    const started = recovery.generation
    const startedAt = epoch(clock.now())
    const id = ObserverCallId.parse(randomUUID())
    if (recovery.health.kind === 'auth') {
      const result = await executor.authStatus(controller.signal)
      const failed = result.ok ? null : result.error
      const next = store.transaction((transaction) => {
        const now = clock.now()
        transaction.observerCalls.check({
          id,
          kind: 'auth_status',
          backend: runtime,
          input: null,
          output: null,
          verdict: failed === null ? 'accepted' : 'failed',
          error: failed === null ? null : storedError(failed),
          usage: null,
          started_at: startedAt,
          finished_at: epoch(now),
        })
        return failed?.class === 'cancelled' ? null : transit(transaction, backend, started, afterAuthCheck(failed, now, limits), now)
      })
      adopt(recovery, next)
      return { stopped: result.stopped }
    }
    const input = probeInput(runtime)
    const result = await executor.execute({ input, signal: controller.signal })
    const next = store.transaction((transaction) => {
      const now = clock.now()
      transaction.observerCalls.check({
        id,
        kind: 'probe',
        backend: runtime,
        input,
        output: result.ok ? result.output : null,
        verdict: result.ok ? 'accepted' : 'failed',
        error: result.ok ? null : storedError(result.error),
        usage: result.usage,
        started_at: startedAt,
        finished_at: epoch(now),
      })
      return transit(transaction, backend, started, after(recovery.health, result.ok ? null : result.error, now), now)
    })
    adopt(recovery, next)
    return { stopped: result.stopped }
  }

  const launchCheck = (backend: Backend): void => {
    const { runtime } = backend
    const finished = Promise.withResolvers<undefined>()
    checks.set(runtime, finished.promise)
    const results = check(backend).catch((error: unknown): Stopping => {
      failure.resolve(error)
      return { stopped: Promise.resolve() }
    })
    settling.add(results)
    void results
      .then(({ stopped }) => {
        settling.delete(results)
        return stopped
      })
      .finally(() => {
        checks.delete(runtime)
        finished.resolve(undefined)
        plan()
      })
  }

  const plan = (): void => {
    if (closed) {
      return
    }
    cancelTimer?.()
    cancelTimer = null
    try {
      const now = clock.now()
      const { over, freesAt } = budgetOf(now)
      const pending = store.interpretations.pendingRuns().map((run) => ({ run, queued: queueOf(run, now) }))
      const backlogged = new Set(store.interpretations.backlogRuns())
      const queues: Queue[] = [
        ...pending.map((queue) => ({ ...queue, backlog: backlogged.has(queue.run) })),
        ...[...backlogged].filter((run) => !pending.some((queue) => queue.run === run)).map((run) => ({ run, queued: [], backlog: true })),
      ].filter(({ queued, backlog }) => queued.length > 0 || backlog)
      const wakeups = [
        ...queues.flatMap(({ queued }) =>
          queued.length === 0 ? [] : [expiryOf(queued), ...(behind(queued, now) ? [] : [lagFrom(queued)])],
        ),
        ...(freesAt === null ? [] : [freesAt]),
      ]
      for (const backend of configured) {
        const { health } = backend.recovery
        if (!waiting(health) || checks.has(backend.runtime) || !available(backend.executor)) {
          continue
        }
        if (health.retryAt > now) {
          wakeups.push(health.retryAt)
        } else if (occupied() < limits.concurrency) {
          launchCheck(backend)
        }
      }
      const candidates = queues
        .flatMap((queue) => {
          const candidate = running.has(queue.run) ? null : candidateOf(queue, now, over)
          return candidate === null ? [] : [candidate]
        })
        .sort((left, right) => left.due - right.due || left.order - right.order)
      for (const candidate of candidates) {
        if (candidate.due > now) {
          wakeups.push(candidate.due)
          break
        }
        if (occupied() >= limits.concurrency) {
          break
        }
        const { recovery } = candidate
        if (recovery.health.kind !== 'backoff' || recovery.inflight === 0) {
          launch(candidate)
        }
      }
      const next = Math.min(...wakeups)
      if (Number.isFinite(next)) {
        cancelTimer = clock.schedule(next - now, plan)
      }
      publish(
        over,
        queues.flatMap((queue) => (runStateOf(queue, now, over).state === 'lagging' ? [queue.run] : [])),
      )
    } catch (error) {
      failure.resolve(error)
    }
  }

  const requestPlan = (): void => {
    if (!planRequested) {
      planRequested = true
      queueMicrotask(() => {
        planRequested = false
        plan()
      })
    }
  }

  const readmit = (backend: Backend): void => {
    try {
      adopt(
        backend.recovery,
        store.transaction((transaction) => transit(transaction, backend, backend.recovery.generation, healthy, clock.now())),
      )
    } catch (error) {
      failure.resolve(error)
    }
  }

  const unsubscribes = configured.map((backend) =>
    backend.executor.subscribe((status) => {
      const { recovery } = backend
      const disabled = status.state.state === 'disabled'
      if (recovery.disabled && !disabled) {
        readmit(backend)
      }
      recovery.disabled = disabled
      requestPlan()
    }),
  )

  const idle = async (): Promise<void> => {
    while (running.size > 0 || checks.size > 0) {
      await Promise.all([...running.values(), ...checks.values()])
    }
  }

  return {
    wake: plan,
    chat: (work) => {
      if (closed) {
        return Promise.reject(new Error('the observer scheduler is closed'))
      }
      const result = chatTail.then(() => work(controller.signal))
      chatTail = result.then(
        ({ stopped }) => Promise.race([stopped, closing.promise]),
        () => undefined,
      )
      chatWork = result.catch(() => undefined)
      return result
    },
    state: (run) => {
      const now = clock.now()
      const queue = { run, queued: store.interpretations.pending(run), backlog: store.interpretations.backlogRuns().includes(run) }
      return runStateOf(queue, now, budgetOf(now).over)
    },
    backendState: (runtime) => backendStateOf(runtime, budgetOf(clock.now()).over),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    idle,
    close: async () => {
      closed = true
      cancelTimer?.()
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
      controller.abort()
      closing.resolve(undefined)
      await Promise.all(settling)
      await chatWork
    },
    failure: failure.promise,
  }
}
