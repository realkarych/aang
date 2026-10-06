import type { ChangeSeq, ChangesResponse, RunId, ViewMark } from '@aang/contract'
import { useEffect, useRef, useState } from 'react'
import { readChanges, SignedOut } from './api.js'
import { pause } from './pause.js'

export interface ChangesState {
  readonly changes: ChangesResponse | null
  readonly failing: boolean
}

interface Loaded {
  readonly changes: ChangesResponse | null
  readonly failing: boolean
}

const refreshMs = 500

const retryMs = 2_000

const readTimeoutMs = 10_000

const idle = (): void => undefined

const awaken = (wake: { current: () => void }, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      wake.current = idle
      signal.removeEventListener('abort', done)
      resolve()
    }
    wake.current = done
    signal.addEventListener('abort', done, { once: true })
  })

const fromMark = (changes: ChangesResponse, mark: ViewMark): boolean =>
  changes.from.version === mark.version && changes.from.change_seq === mark.change_seq

export const useChanges = (
  run: RunId,
  mark: ViewMark | null,
  position: ChangeSeq,
  onSignedOut: () => void,
): ChangesState => {
  const [loaded, setLoaded] = useState<Loaded>({ changes: null, failing: false })
  const wanted = useRef(position)
  const wake = useRef(idle)
  useEffect(() => {
    wanted.current = position
    wake.current()
  }, [position])
  const version = mark?.version ?? null
  const seq = mark?.change_seq ?? null
  useEffect(() => {
    if (version === null || seq === null) {
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    const follow = async (): Promise<void> => {
      let fetched: ChangeSeq | null = null
      while (!signal.aborted) {
        const target = wanted.current
        if (fetched === target) {
          await awaken(wake, signal)
          continue
        }
        try {
          const changes = await readChanges(
            run,
            { version, change_seq: seq },
            AbortSignal.any([signal, AbortSignal.timeout(readTimeoutMs)]),
          )
          fetched = target
          setLoaded({ changes, failing: false })
          await pause(refreshMs, signal)
        } catch (error) {
          if (controller.signal.aborted) {
            return
          }
          if (error instanceof SignedOut) {
            onSignedOut()
            return
          }
          setLoaded((previous) => ({ ...previous, failing: true }))
          await pause(retryMs, signal)
        }
      }
    }
    void follow()
    return () => {
      controller.abort()
    }
  }, [run, version, seq, onSignedOut])
  if (mark === null) {
    return { changes: null, failing: false }
  }
  const current = loaded.changes !== null && fromMark(loaded.changes, mark) ? loaded.changes : null
  return { changes: current, failing: loaded.failing }
}
