import { createContext, useContext, useEffect, useState } from 'react'
import { NotFound, SignedOut } from './api.js'

export type Read<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly retry: () => void }

export interface ReadSource<T> {
  readonly cache: Map<string, T>
  readonly load: (key: string, signal: AbortSignal) => Promise<T>
}

export const readSource = <T>(load: (key: string, signal: AbortSignal) => Promise<T>): ReadSource<T> => ({
  cache: new Map(),
  load,
})

export const SignedOutContext = createContext<() => void>(() => undefined)

type Settled<T> = { readonly kind: 'ready'; readonly value: T } | { readonly kind: 'missing' } | { readonly kind: 'failed' }

const cached = <T>(source: ReadSource<T>, key: string): Settled<T> | null => {
  const value = source.cache.get(key)
  return value === undefined ? null : { kind: 'ready', value }
}

export const useRead = <T>(source: ReadSource<T>, key: string): Read<T> => {
  const onSignedOut = useContext(SignedOutContext)
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<{ readonly attempt: number; readonly result: Settled<T> } | null>(null)
  const known = cached(source, key)

  useEffect(() => {
    if (source.cache.has(key)) {
      return
    }
    const controller = new AbortController()
    source.load(key, controller.signal).then(
      (value) => {
        source.cache.set(key, value)
        setSettled({ attempt, result: { kind: 'ready', value } })
      },
      (error: unknown) => {
        if (controller.signal.aborted) {
          return
        }
        if (error instanceof SignedOut) {
          onSignedOut()
          return
        }
        setSettled({ attempt, result: error instanceof NotFound ? { kind: 'missing' } : { kind: 'failed' } })
      },
    )
    return () => {
      controller.abort()
    }
  }, [source, key, attempt, onSignedOut])

  const result = known ?? (settled?.attempt === attempt ? settled.result : null)
  if (result === null) {
    return { kind: 'loading' }
  }
  if (result.kind === 'failed') {
    return {
      kind: 'failed',
      retry: () => {
        setAttempt(attempt + 1)
      },
    }
  }
  return result
}
