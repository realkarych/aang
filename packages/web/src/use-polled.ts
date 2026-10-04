import { useEffect, useState } from 'react'
import { SignedOut } from './api.js'

export interface Polled<T> {
  readonly value: T | null
  readonly failing: boolean
}

export const pollIntervalMs = 2_000

export const usePolled = <T>(
  load: (signal: AbortSignal) => Promise<T>,
  onSignedOut: () => void,
  intervalMs = pollIntervalMs,
): Polled<T> => {
  const [state, setState] = useState<Polled<T>>({ value: null, failing: false })
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const value = await load(controller.signal)
        setState({ value, failing: false })
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }
        if (error instanceof SignedOut) {
          onSignedOut()
          return
        }
        setState((previous) => ({ ...previous, failing: true }))
      }
      timer = setTimeout(() => void tick(), intervalMs)
    }
    void tick()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [load, onSignedOut, intervalMs])
  return state
}
