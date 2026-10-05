import type { ChatMessage, RunId, RunSnapshot } from '@aang/contract'
import { useCallback, useEffect, useReducer } from 'react'
import { NotFound, readChat, readRun, SignedOut } from './api.js'
import { applyEvent } from './feed.js'
import { pause } from './pause.js'
import { type FeedEvent, followRun } from './stream.js'

export type FeedConnection = 'loading' | 'live' | 'reconnecting' | 'missing'

export interface RunFeedState {
  readonly snapshot: RunSnapshot | null
  readonly chat: readonly ChatMessage[]
  readonly connection: FeedConnection
}

export interface RunFeed extends RunFeedState {
  readonly record: (message: ChatMessage) => void
}

type FeedAction =
  | { readonly kind: 'start' }
  | { readonly kind: 'snapshot'; readonly snapshot: RunSnapshot; readonly chat: readonly ChatMessage[] }
  | { readonly kind: 'event'; readonly event: FeedEvent }
  | { readonly kind: 'message'; readonly message: ChatMessage }
  | { readonly kind: 'connection'; readonly connection: FeedConnection }
  | { readonly kind: 'missing' }

const initial: RunFeedState = { snapshot: null, chat: [], connection: 'loading' }

const byAsking = (left: ChatMessage, right: ChatMessage): number =>
  left.asked_at < right.asked_at ? -1 : left.asked_at > right.asked_at ? 1 : left.id < right.id ? -1 : 1

const settled = (messages: readonly ChatMessage[], message: ChatMessage): boolean =>
  message.status === 'pending' && messages.some(({ id, status }) => id === message.id && status !== 'pending')

const withMessage = (messages: readonly ChatMessage[], message: ChatMessage): readonly ChatMessage[] =>
  settled(messages, message) ? messages : [...messages.filter(({ id }) => id !== message.id), message].sort(byAsking)

const reduce = (state: RunFeedState, action: FeedAction): RunFeedState => {
  switch (action.kind) {
    case 'start':
      return initial
    case 'snapshot':
      return { ...state, snapshot: action.snapshot, chat: [...action.chat].sort(byAsking) }
    case 'event':
      return state.snapshot === null
        ? state
        : {
            ...state,
            snapshot: applyEvent(state.snapshot, action.event),
            chat: action.event.event === 'chat' ? withMessage(state.chat, action.event.data.message) : state.chat,
          }
    case 'message':
      return { ...state, chat: withMessage(state.chat, action.message) }
    case 'connection':
      return state.connection === action.connection ? state : { ...state, connection: action.connection }
    case 'missing':
      return { snapshot: null, chat: [], connection: 'missing' }
  }
}

const retryMs = 1_000

const follow = async (
  run: RunId,
  dispatch: (action: FeedAction) => void,
  signal: AbortSignal,
): Promise<void> => {
  while (!signal.aborted) {
    let snapshot: RunSnapshot
    let chat: ChatMessage[]
    try {
      snapshot = await readRun(run, signal)
      chat = await readChat(run, signal)
    } catch (error) {
      if (error instanceof SignedOut) {
        throw error
      }
      dispatch(error instanceof NotFound ? { kind: 'missing' } : { kind: 'connection', connection: 'reconnecting' })
      await pause(retryMs, signal)
      continue
    }
    dispatch({ kind: 'snapshot', snapshot, chat })
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
      signal,
    )
  }
}

export const useRunFeed = (run: RunId, onSignedOut: () => void): RunFeed => {
  const [state, dispatch] = useReducer(reduce, initial)
  useEffect(() => {
    const controller = new AbortController()
    dispatch({ kind: 'start' })
    follow(run, dispatch, controller.signal).catch((error: unknown) => {
      if (error instanceof SignedOut) {
        onSignedOut()
      } else if (!controller.signal.aborted) {
        throw error
      }
    })
    return () => {
      controller.abort()
    }
  }, [run, onSignedOut])
  const record = useCallback((message: ChatMessage) => {
    dispatch({ kind: 'message', message })
  }, [])
  return { ...state, record }
}
