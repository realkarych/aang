import type { AttentionView, RunId, RunSnapshot } from '@aang/contract'
import { type RefObject, useCallback, useEffect, useReducer, useRef } from 'react'
import { NotFound, readRun, SignedOut } from './api.js'
import { applyAttentionView, applyEvent } from './feed.js'
import { type Generation, generationAfter } from './generation.js'
import { pause } from './pause.js'
import { type FeedEvent, followRun } from './stream.js'

export type FeedConnection = 'loading' | 'live' | 'reconnecting' | 'missing'

export interface RunFeedState {
  readonly snapshot: RunSnapshot | null
  readonly connection: FeedConnection
  readonly generation: Generation
}

export interface RunFeed extends RunFeedState {
  readonly noteView: (view: AttentionView) => void
}

type FeedAction =
  | { readonly kind: 'start' }
  | { readonly kind: 'snapshot'; readonly snapshot: RunSnapshot; readonly renew: boolean }
  | { readonly kind: 'event'; readonly event: FeedEvent }
  | { readonly kind: 'view'; readonly view: AttentionView }
  | { readonly kind: 'connection'; readonly connection: FeedConnection }
  | { readonly kind: 'missing' }

const initial = (): RunFeedState => ({ snapshot: null, connection: 'loading', generation: generationAfter(null) })

const nextGeneration = (state: RunFeedState): Generation =>
  state.snapshot === null ? state.generation : generationAfter(state.generation)

const reduce = (state: RunFeedState, action: FeedAction): RunFeedState => {
  switch (action.kind) {
    case 'start':
      return { snapshot: null, connection: 'loading', generation: nextGeneration(state) }
    case 'snapshot':
      return {
        ...state,
        snapshot: action.snapshot,
        generation: action.renew ? nextGeneration(state) : state.generation,
      }
    case 'event':
      return state.snapshot === null ? state : { ...state, snapshot: applyEvent(state.snapshot, action.event) }
    case 'view':
      return state.snapshot === null ? state : { ...state, snapshot: applyAttentionView(state.snapshot, action.view) }
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

export const useRunFeed = (run: RunId, onSignedOut: () => void): RunFeed => {
  const [state, dispatch] = useReducer(reduce, undefined, initial)
  const resync = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    dispatch({ kind: 'start' })
    follow(run, dispatch, controller.signal, resync).catch((error: unknown) => {
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
  const noteView = useCallback((view: AttentionView) => {
    dispatch({ kind: 'view', view })
    resync.current?.abort()
  }, [])
  return { ...state, noteView }
}
