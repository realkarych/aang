import type { RunId, RunSnapshot } from '@aang/contract'
import { useEffect, useReducer } from 'react'
import { NotFound, readRun, SignedOut } from './api.js'
import { applyEvent } from './feed.js'
import { pause } from './pause.js'
import { type FeedEvent, followRun } from './stream.js'

export type FeedConnection = 'loading' | 'live' | 'reconnecting' | 'missing'

export interface RunFeedState {
  readonly snapshot: RunSnapshot | null
  readonly connection: FeedConnection
  readonly generation: number
}

type FeedAction =
  | { readonly kind: 'start' }
  | { readonly kind: 'snapshot'; readonly snapshot: RunSnapshot }
  | { readonly kind: 'event'; readonly event: FeedEvent }
  | { readonly kind: 'connection'; readonly connection: FeedConnection }
  | { readonly kind: 'missing' }

const initial: RunFeedState = { snapshot: null, connection: 'loading', generation: 0 }

const nextGeneration = (state: RunFeedState): number => (state.snapshot === null ? state.generation : state.generation + 1)

const reduce = (state: RunFeedState, action: FeedAction): RunFeedState => {
  switch (action.kind) {
    case 'start':
      return { ...initial, generation: nextGeneration(state) }
    case 'snapshot':
      return { ...state, snapshot: action.snapshot, generation: nextGeneration(state) }
    case 'event':
      return state.snapshot === null ? state : { ...state, snapshot: applyEvent(state.snapshot, action.event) }
    case 'connection':
      return state.connection === action.connection ? state : { ...state, connection: action.connection }
    case 'missing':
      return { snapshot: null, connection: 'missing', generation: nextGeneration(state) }
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
