import type { AttentionView, ChatMessage, RunId, RunSnapshot } from '@aang/contract'
import { type RefObject, useCallback, useEffect, useReducer, useRef } from 'react'
import { failureText, NotFound, readChat, readRun, SignedOut } from './api.js'
import { applyAttentionView, applyEvent } from './feed.js'
import { type Generation, generationAfter } from './generation.js'
import { pause } from './pause.js'
import { type FeedEvent, followRun } from './stream.js'

export type FeedConnection = 'loading' | 'live' | 'reconnecting' | 'missing'

export type ChatHistory =
  | { readonly state: 'loading' }
  | { readonly state: 'ready' }
  | { readonly state: 'failed'; readonly reason: string }

export interface RunFeed {
  readonly snapshot: RunSnapshot | null
  readonly chat: readonly ChatMessage[]
  readonly history: ChatHistory
  readonly connection: FeedConnection
  readonly generation: Generation
  readonly record: (message: ChatMessage) => void
  readonly noteView: (view: AttentionView) => void
}

interface FeedState {
  readonly snapshot: RunSnapshot | null
  readonly reads: number
  readonly chat: readonly ChatMessage[]
  readonly arrived: readonly ChatMessage[]
  readonly history: ChatHistory
  readonly connection: FeedConnection
  readonly generation: Generation
}

type FeedAction =
  | { readonly kind: 'start' }
  | { readonly kind: 'snapshot'; readonly snapshot: RunSnapshot; readonly renew: boolean }
  | { readonly kind: 'event'; readonly event: FeedEvent }
  | { readonly kind: 'message'; readonly message: ChatMessage }
  | { readonly kind: 'history'; readonly messages: readonly ChatMessage[] }
  | { readonly kind: 'history-failed'; readonly reason: string }
  | { readonly kind: 'view'; readonly view: AttentionView }
  | { readonly kind: 'connection'; readonly connection: FeedConnection }
  | { readonly kind: 'missing' }

const cleared = (generation: Generation): FeedState => ({
  snapshot: null,
  reads: 0,
  chat: [],
  arrived: [],
  history: { state: 'loading' },
  connection: 'loading',
  generation,
})

const initial = (): FeedState => cleared(generationAfter(null))

const nextGeneration = (state: FeedState): Generation =>
  state.snapshot === null ? state.generation : generationAfter(state.generation)

const byAsking = (left: ChatMessage, right: ChatMessage): number =>
  left.asked_at < right.asked_at ? -1 : left.asked_at > right.asked_at ? 1 : left.id < right.id ? -1 : 1

const settled = (messages: readonly ChatMessage[], message: ChatMessage): boolean =>
  message.status === 'pending' && messages.some(({ id, status }) => id === message.id && status !== 'pending')

const withMessage = (messages: readonly ChatMessage[], message: ChatMessage): readonly ChatMessage[] =>
  settled(messages, message) ? messages : [...messages.filter(({ id }) => id !== message.id), message].sort(byAsking)

const arrive = (state: FeedState, message: ChatMessage): FeedState => ({
  ...state,
  chat: withMessage(state.chat, message),
  arrived: withMessage(state.arrived, message),
})

const reduce = (state: FeedState, action: FeedAction): FeedState => {
  switch (action.kind) {
    case 'start':
      return cleared(nextGeneration(state))
    case 'snapshot':
      return {
        ...state,
        snapshot: action.snapshot,
        reads: state.reads + 1,
        arrived: [],
        generation: action.renew ? nextGeneration(state) : state.generation,
      }
    case 'event': {
      if (state.snapshot === null) {
        return state
      }
      const snapshot = applyEvent(state.snapshot, action.event)
      return action.event.event === 'chat'
        ? { ...arrive(state, action.event.data.message), snapshot }
        : { ...state, snapshot }
    }
    case 'message':
      return arrive(state, action.message)
    case 'history':
      return {
        ...state,
        chat: state.arrived.reduce<readonly ChatMessage[]>(withMessage, [...action.messages].sort(byAsking)),
        history: { state: 'ready' },
      }
    case 'history-failed':
      return { ...state, history: { state: 'failed', reason: action.reason } }
    case 'view':
      return state.snapshot === null ? state : { ...state, snapshot: applyAttentionView(state.snapshot, action.view) }
    case 'connection':
      return state.connection === action.connection ? state : { ...state, connection: action.connection }
    case 'missing':
      return { ...cleared(nextGeneration(state)), connection: 'missing' }
  }
}

const retryMs = 1_000

const follow = async (
  run: RunId,
  dispatch: (action: FeedAction) => void,
  signal: AbortSignal,
  resync: RefObject<AbortController | null>,
): Promise<void> => {
  let renew = true
  while (!signal.aborted) {
    const pass = new AbortController()
    resync.current = pass
    let snapshot: RunSnapshot
    try {
      snapshot = await readRun(run, signal)
    } catch (error) {
      if (error instanceof SignedOut) {
        throw error
      }
      dispatch(error instanceof NotFound ? { kind: 'missing' } : { kind: 'connection', connection: 'reconnecting' })
      await pause(retryMs, signal)
      continue
    }
    dispatch({ kind: 'snapshot', snapshot, renew })
    await followRun(
      run,
      snapshot.change_seq,
      {
        onOpen: () => {
          dispatch({ kind: 'connection', connection: 'live' })
        },
        onEvent: (event) => {
          dispatch({ kind: 'event', event })
        },
        onInterrupted: () => {
          dispatch({ kind: 'connection', connection: 'reconnecting' })
        },
      },
      AbortSignal.any([signal, pass.signal]),
    )
    renew = !pass.signal.aborted
  }
}

const readHistory = async (
  run: RunId,
  dispatch: (action: FeedAction) => void,
  signal: AbortSignal,
): Promise<void> => {
  while (!signal.aborted) {
    try {
      dispatch({ kind: 'history', messages: await readChat(run, signal) })
      return
    } catch (error) {
      if (error instanceof SignedOut) {
        throw error
      }
      dispatch({ kind: 'history-failed', reason: failureText(error) })
      await pause(retryMs, signal)
    }
  }
}

const unlessAborted =
  (signal: AbortSignal, onSignedOut: () => void) =>
  (error: unknown): void => {
    if (error instanceof SignedOut) {
      onSignedOut()
    } else if (!signal.aborted) {
      throw error
    }
  }

export const useRunFeed = (run: RunId, onSignedOut: () => void): RunFeed => {
  const [state, dispatch] = useReducer(reduce, undefined, initial)
  const resync = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    dispatch({ kind: 'start' })
    follow(run, dispatch, controller.signal, resync).catch(unlessAborted(controller.signal, onSignedOut))
    return () => {
      controller.abort()
    }
  }, [run, onSignedOut])
  const { reads } = state
  useEffect(() => {
    if (reads === 0) {
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    const current = (action: FeedAction): void => {
      if (!signal.aborted) {
        dispatch(action)
      }
    }
    readHistory(run, current, signal).catch(unlessAborted(signal, onSignedOut))
    return () => {
      controller.abort()
    }
  }, [run, reads, onSignedOut])
  const record = useCallback((message: ChatMessage) => {
    dispatch({ kind: 'message', message })
  }, [])
  const noteView = useCallback((view: AttentionView) => {
    dispatch({ kind: 'view', view })
    resync.current?.abort()
  }, [])
  const { snapshot, chat, history, connection, generation } = state
  return { snapshot, chat, history, connection, generation, record, noteView }
}
