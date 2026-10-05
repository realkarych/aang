import { randomUUID } from 'node:crypto'
import {
  type CallUsage,
  type ChatInput,
  type ChatMessage,
  type ChatOutput,
  type ChatQuestionRequest,
  EpochNs,
  type JsonValue,
  type ModelVersion,
  ObserverCallId,
  type RunId,
  type Runtime,
} from '@aang/contract'
import {
  answerChat,
  type ChatLimits,
  type ChatTurnStart,
  defaultChatLimits,
  failChat,
  failInterruptedChats,
  followUpChat,
  startChat,
} from '@aang/engine'
import type { ObserverCallError, Store, Transaction } from '@aang/store'
import type { ChatResult, LaunchFailure, ObserverRequest } from './backend.js'
import { storedError } from './recovery.js'

export interface ChatExecutor {
  readonly chat: (request: ObserverRequest) => Promise<ChatResult>
}

export type ChatCallVerdict = 'accepted' | 'rejected' | 'needs_requested' | 'failed'

export interface ChatCallRecord {
  readonly id: ObserverCallId
  readonly run: RunId
  readonly backend: Runtime
  readonly base_version: ModelVersion
  readonly previous: ObserverCallId | null
  readonly input: ChatInput
  readonly output: JsonValue | null
  readonly verdict: ChatCallVerdict
  readonly error: ObserverCallError | null
  readonly usage: CallUsage | null
  readonly started_at: EpochNs
  readonly finished_at: EpochNs
}

export type ChatJournal = (transaction: Transaction, call: ChatCallRecord) => void

export type ChatSlot = <T extends { readonly stopped: Promise<void> }>(
  work: (signal: AbortSignal) => Promise<T>,
) => Promise<T>

export interface ChatOptions {
  readonly store: Store
  readonly backends: Partial<Record<Runtime, ChatExecutor>>
  readonly backend?: Runtime | null
  readonly crossVendor?: boolean
  readonly slot: ChatSlot
  readonly journal?: ChatJournal
  readonly now?: () => number
  readonly limits?: ChatLimits
}

export interface Chat {
  readonly ask: (run: RunId, request: ChatQuestionRequest) => ChatMessage | null
  readonly idle: () => Promise<void>
  readonly close: () => Promise<void>
  readonly failure: Promise<unknown>
}

export class ChatClosedError extends Error {
  override readonly name = 'ChatClosedError'

  constructor() {
    super('the chat is stopping')
  }
}

interface Conversation {
  readonly run: RunId
  readonly backend: Runtime
  readonly started: ChatTurnStart
}

interface Exchange {
  readonly id: ObserverCallId
  readonly input: ChatInput
  readonly result: ChatResult
  readonly started_at: EpochNs
}

const stopping: LaunchFailure = { class: 'cancelled', message: 'the observer stopped before the chat answered' }

const epoch = (milliseconds: number): EpochNs => EpochNs.parse(BigInt(Math.trunc(milliseconds)) * 1_000_000n)

const describe = (failure: LaunchFailure): string => `${failure.class}: ${failure.message}`

const requested = (output: ChatOutput): boolean => output.answer === null && output.needs.length > 0

const outputOf = (output: ChatOutput): JsonValue => JSON.parse(JSON.stringify(output)) as JsonValue

export const createChat = (options: ChatOptions): Chat => {
  const { store, backends, backend: override = null, crossVendor = false, slot, journal } = options
  const now = options.now ?? Date.now
  const limits = options.limits ?? defaultChatLimits
  const failure = Promise.withResolvers<unknown>()
  const conversations = new Set<Promise<void>>()
  let closed = false

  store.transaction((transaction) => {
    failInterruptedChats(transaction, epoch(now()))
  })

  const exchange = async (executor: ChatExecutor, input: ChatInput): Promise<Exchange> => {
    const id = ObserverCallId.parse(randomUUID())
    const startedAt = epoch(now())
    const result = await slot((signal) => executor.chat({ input, signal })).catch(
      (): ChatResult => ({ ok: false, error: stopping, usage: null, stopped: Promise.resolve() }),
    )
    return { id, input, result, started_at: startedAt }
  }

  const record = (
    transaction: Transaction,
    { run, backend, started }: Conversation,
    { id, input, result, started_at: startedAt }: Exchange,
    previous: ObserverCallId | null,
    at: EpochNs,
  ): void => {
    const verdict: ChatCallVerdict = result.ok
      ? previous === null && requested(result.output)
        ? 'needs_requested'
        : 'accepted'
      : result.error.class === 'invalid_output'
        ? 'rejected'
        : 'failed'
    journal?.(transaction, {
      id,
      run,
      backend,
      base_version: started.message.version,
      previous,
      input,
      output: result.ok ? outputOf(result.output) : null,
      verdict,
      error: result.ok ? null : storedError(result.error),
      usage: result.usage,
      started_at: startedAt,
      finished_at: at,
    })
  }

  const conclude = (transaction: Transaction, { run, started }: Conversation, { input, result }: Exchange, at: EpochNs): void => {
    const message = started.message.id
    if (result.ok) {
      answerChat(transaction, { run, message, input, output: result.output, at })
    } else {
      failChat(transaction, { run, message, error: describe(result.error), at })
    }
  }

  const converse = async (conversation: Conversation): Promise<void> => {
    const { run, backend, started } = conversation
    const executor = backends[backend]
    if (executor === undefined) {
      store.transaction((transaction) => {
        failChat(transaction, { run, message: started.message.id, error: `cli_missing: no ${backend} backend`, at: epoch(now()) })
      })
      return
    }
    const first = await exchange(executor, started.input)
    const followUp = store.transaction((transaction): ChatInput | null => {
      const at = epoch(now())
      record(transaction, conversation, first, null, at)
      if (!first.result.ok || !requested(first.result.output)) {
        conclude(transaction, conversation, first, at)
        return null
      }
      const input = followUpChat(transaction, {
        input: started.input,
        needs: first.result.output.needs,
        backend,
        crossVendor,
        limits,
      })
      if (input === null) {
        failChat(transaction, {
          run,
          message: started.message.id,
          error: `limit: no requested material fits the chat input limit of ${String(limits.inputTokens)} tokens`,
          at,
        })
      }
      return input
    })
    if (followUp === null) {
      return
    }
    const second = await exchange(executor, followUp)
    store.transaction((transaction) => {
      const at = epoch(now())
      record(transaction, conversation, second, first.id, at)
      conclude(transaction, conversation, second, at)
    })
  }

  const ask = (run: RunId, { question, stage }: ChatQuestionRequest): ChatMessage | null => {
    if (closed) {
      throw new ChatClosedError()
    }
    const entity = store.model.entity(run, { kind: 'run', id: run })
    if (entity?.kind !== 'run') {
      return null
    }
    const backend = override ?? entity.value.runtime
    const started = store.transaction((transaction) =>
      startChat(transaction, { run, stage, question, backend, crossVendor, at: epoch(now()), limits }),
    )
    if (started === null) {
      return null
    }
    const work = converse({ run, backend, started }).catch(failure.resolve)
    conversations.add(work)
    void work.finally(() => conversations.delete(work))
    return started.message
  }

  const idle = async (): Promise<void> => {
    while (conversations.size > 0) {
      await Promise.all(conversations)
    }
  }

  return {
    ask,
    idle,
    close: async () => {
      closed = true
      await idle()
    },
    failure: failure.promise,
  }
}
