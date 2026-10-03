import type { RunId, RunSnapshot } from '@aang/contract'
import { useEffect, useReducer } from 'react'
import { NotFound, readRun, SignedOut } from './api.js'
import { applyEvent } from './feed.js'
import { type FeedEvent, followRun } from './stream.js'

export type FeedConnection = 'loading' | 'live' | 'reconnecting' | 'missing'

export interface RunFeedState {
  readonly snapshot: RunSnapshot | null
  readonly connection: FeedConnection
}

type FeedAction =
  | { readonly kind: 'start' }
  | { readonly kind: 'snapshot'; readonly snapshot: RunSnapshot }
  | { readonly kind: 'event'; readonly event: FeedEvent }
  | { readonly kind: 'connection'; readonly connection: FeedConnection }
  | { readonly kind: 'missing' }

const initial: RunFeedState = { snapshot: null, connection: 'loading' }

const reduce = (state: RunFeedState, action: FeedAction): RunFeedState => {
  switch (action.kind) {
    case 'start':
      return initial
    case 'snapshot':
      return { ...state, snapshot: action.snapshot }
    case 'event':
      return state.snapshot === null ? state : { ...state, snapshot: applyEvent(state.snapshot, action.event) }
    case 'connection':
      return state.connection === action.connection ? state : { ...state, connection: action.connection }
    case 'missing':
      return { snapshot: null, connection: 'missing' }
  }
}

const retryMs = 1_000

const wait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })

const follow = async (
  run: RunId,
  dispatch: (action: FeedAction) => void,
  signal: AbortSignal,
): Promise<void> => {
  while (!signal.aborted) {
    let snapshot: RunSnapshot
    try {
      snapshot = await readRun(run, signal)
    } catch (error) {
      if (error instanceof SignedOut) {
        throw error
      }
      dispatch(error instanceof NotFound ? { kind: 'missing' } : { kind: 'connection', connection: 'reconnecting' })
      await wait(retryMs, signal)
      continue
    }
    dispatch({ kind: 'snapshot', snapshot })
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

export const useRunFeed = (run: RunId, onSignedOut: () => void): RunFeedState => {
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
  return state
}
