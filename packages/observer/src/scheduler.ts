import { randomUUID } from 'node:crypto'
import { EpochNs, type FactId, ObserverCallId, type ObserverInput, type RunId, type Runtime } from '@aang/contract'
import {
  applyObserverResponse,
  beginObserverFollowUp,
  boundObserverQueue,
  exhaustObserverCall,
  failObserverCall,
  type ObserverResponseResult,
  startObserverBatch,
} from '@aang/engine'
import type { PendingFact, Store } from '@aang/store'
import type { ObserverRequest, ObserverResult } from './backend.js'
import type { LaunchStatus } from './process.js'

export interface ObserverExecutor {
  readonly execute: (request: ObserverRequest) => Promise<ObserverResult>
  readonly status: () => LaunchStatus
  readonly subscribe: (listener: (status: LaunchStatus) => void) => () => void
}

export interface SchedulerClock {
  readonly now: () => number
  readonly schedule: (delayMs: number, task: () => void) => () => void
}

export interface SchedulerLimits {
  readonly batchFacts: number
  readonly batchBytes: number
  readonly textLength: number
  readonly delayMs: number
  readonly intervalMs: number
  readonly concurrency: number
  readonly queueFacts: number
  readonly queueAgeMs: number
  readonly attempts: number
}

export interface SchedulerOptions {
  readonly store: Store
  readonly backends: Partial<Record<Runtime, ObserverExecutor>>
  readonly backend?: Runtime | null
  readonly crossVendor?: boolean
  readonly clock?: SchedulerClock
  readonly limits?: Partial<SchedulerLimits>
}

export interface ObserverScheduler {
  readonly wake: () => void
  readonly chat: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>
  readonly idle: () => Promise<void>
  readonly close: () => Promise<void>
  readonly failure: Promise<unknown>
}

interface Candidate {
  readonly run: RunId
  readonly backend: Runtime
  readonly executor: ObserverExecutor
  readonly due: number
  readonly order: number
}

const defaultLimits: SchedulerLimits = {
  batchFacts: 30,
  batchBytes: 96_000,
  textLength: 4_000,
  delayMs: 5_000,
  intervalMs: 10_000,
  concurrency: 2,
  queueFacts: 2_000,
  queueAgeMs: 24 * 60 * 60 * 1_000,
  attempts: 3,
}

export const systemClock: SchedulerClock = {
  now: () => Date.now(),
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs).unref()
    return () => {
      clearTimeout(timer)
    }
  },
}

const epoch = (milliseconds: number): EpochNs => EpochNs.parse(BigInt(Math.trunc(milliseconds)) * 1_000_000n)

const available = (executor: ObserverExecutor): boolean => {
  const { state } = executor.status().state
  return state !== 'disabled' && state !== 'unavailable'
}

export const createObserverScheduler = (options: SchedulerOptions): ObserverScheduler => {
  const { store, backends, backend: override = null, crossVendor = false, clock = systemClock } = options
  const limits: SchedulerLimits = { ...defaultLimits, ...options.limits }
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('scheduler limits must be positive integers')
  }
  store.transaction((transaction) => {
    for (const call of transaction.observerCalls.unfinished()) {
      failObserverCall(transaction, { call, outcome: 'failed', at: epoch(clock.now()) })
    }
  })
  const running = new Map<RunId, Promise<undefined>>()
  const lastStart = new Map<RunId, number>()
  const seen = new Map<RunId, Map<FactId, number>>()
  const controller = new AbortController()
  const failure = Promise.withResolvers<unknown>()
  let chatTail: Promise<unknown> = Promise.resolve()
  let cancelTimer: (() => void) | null = null
  let planRequested = false
  let closed = false

  const firstSeen = (run: RunId, queued: readonly PendingFact[], now: number): number => {
    const previous = seen.get(run)
    const current = new Map(queued.map(({ fact }) => [fact, previous?.get(fact) ?? now]))
    seen.set(run, current)
    return Math.min(...current.values())
  }

  const runtimeOf = (run: RunId): Runtime | null => {
    const entity = store.model.entity(run, { kind: 'run', id: run })
    return entity?.kind === 'run' ? entity.value.runtime : null
  }

  const candidateOf = (run: RunId, now: number): Candidate | null => {
    const queued = store.transaction((transaction) =>
      boundObserverQueue(transaction, { run, at: epoch(now), bounds: { facts: limits.queueFacts, ageMs: limits.queueAgeMs } }),
    )
    if (queued.length === 0) {
      seen.delete(run)
      return null
    }
    const oldest = firstSeen(run, queued, now)
    const backend = override ?? runtimeOf(run)
    const executor = backend === null ? undefined : backends[backend]
    if (backend === null || executor === undefined || !available(executor)) {
      return null
    }
    const bytes = queued.reduce((total, pending) => total + pending.bytes, 0)
    const full = queued.length >= limits.batchFacts || bytes >= limits.batchBytes
    const ready = full || queued.some(({ urgent }) => urgent) ? now : oldest + limits.delayMs
    const due = Math.max(ready, (lastStart.get(run) ?? -Infinity) + limits.intervalMs)
    return { run, backend, executor, due, order: Math.min(...queued.map(({ seq }) => seq)) }
  }

  const settle = (call: ObserverCallId, result: ObserverResult): ObserverResponseResult | null =>
    store.transaction((transaction) => {
      const at = epoch(clock.now())
      if (!result.ok) {
        if (result.error.class === 'invalid_output') {
          failObserverCall(transaction, { call, outcome: 'rejected', message: result.error.message, at, usage: result.usage })
          exhaustObserverCall(transaction, { call, attempts: limits.attempts, at })
        } else {
          failObserverCall(transaction, { call, outcome: 'failed', at, usage: result.usage })
        }
        return null
      }
      const response = applyObserverResponse(transaction, { call, output: result.output, at, usage: result.usage })
      if (response.status === 'rejected') {
        exhaustObserverCall(transaction, { call, attempts: limits.attempts, at })
      }
      return response
    })

  const perform = async ({ executor }: Candidate, call: ObserverCallId, input: ObserverInput): Promise<void> => {
    const execute = (body: ObserverInput) => executor.execute({ input: body, signal: controller.signal })
    const first = settle(call, await execute(input))
    if (first?.status !== 'needs_requested') {
      return
    }
    const followUp = ObserverCallId.parse(randomUUID())
    const materials = store.transaction((transaction) =>
      beginObserverFollowUp(transaction, { previous: call, id: followUp, at: epoch(clock.now()), crossVendor }),
    )
    settle(followUp, await execute(materials))
  }

  const launch = (candidate: Candidate): void => {
    const { run, backend } = candidate
    const call = ObserverCallId.parse(randomUUID())
    const now = clock.now()
    const input = store.transaction((transaction) =>
      startObserverBatch(transaction, {
        run,
        backend,
        crossVendor,
        id: call,
        at: epoch(now),
        limits: { facts: limits.batchFacts, bytes: limits.batchBytes, textLength: limits.textLength },
      }),
    )
    if (input === null) {
      return
    }
    lastStart.set(run, now)
    const finished = Promise.withResolvers<undefined>()
    running.set(run, finished.promise)
    perform(candidate, call, input)
      .catch(failure.resolve)
      .finally(() => {
        running.delete(run)
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
      const pendingRuns = store.interpretations.pendingRuns()
      const queuedRuns = new Set(pendingRuns)
      for (const run of seen.keys()) {
        if (!queuedRuns.has(run) && !running.has(run)) {
          seen.delete(run)
        }
      }
      for (const [run, start] of lastStart) {
        if (now - start >= limits.intervalMs) {
          lastStart.delete(run)
        }
      }
      const candidates = pendingRuns
        .filter((run) => !running.has(run))
        .flatMap((run) => {
          const candidate = candidateOf(run, now)
          return candidate === null ? [] : [candidate]
        })
        .sort((left, right) => left.due - right.due || left.order - right.order)
      for (const candidate of candidates) {
        if (candidate.due > now) {
          cancelTimer = clock.schedule(candidate.due - now, plan)
          return
        }
        if (running.size >= limits.concurrency) {
          return
        }
        launch(candidate)
      }
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

  const unsubscribes = Object.values(backends).map((executor) => executor.subscribe(requestPlan))

  const idle = async (): Promise<void> => {
    while (running.size > 0) {
      await Promise.all(running.values())
    }
  }

  return {
    wake: plan,
    chat: (work) => {
      if (closed) {
        return Promise.reject(new Error('the observer scheduler is closed'))
      }
      const result = chatTail.then(() => work(controller.signal))
      chatTail = result.catch(() => undefined)
      return result
    },
    idle,
    close: async () => {
      closed = true
      cancelTimer?.()
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
      controller.abort()
      await idle()
      await chatTail
    },
    failure: failure.promise,
  }
}
