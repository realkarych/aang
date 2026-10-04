import type { ChangeSeq, RunId, StageId, StageInspector } from '@aang/contract'
import { useEffect, useRef, useState } from 'react'
import { NotFound, readStage, SignedOut } from './api.js'
import { pause } from './pause.js'

export type StageLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly inspector: StageInspector; readonly failing: boolean }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failing' }

const refreshGapMs = 400

const retryMs = 1_000

interface Loaded {
  readonly seq: ChangeSeq | null
}

const changed = (wanted: ChangeSeq | null, loaded: Loaded | null): boolean =>
  loaded === null || (wanted !== null && (loaded.seq === null || wanted > loaded.seq))

const nextChange = (wake: { current: (() => void) | null }, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      wake.current = null
      resolve()
    }
    wake.current = done
    signal.addEventListener('abort', done, { once: true })
  })

export const useStage = (run: RunId, stage: StageId, seq: ChangeSeq | null, onSignedOut: () => void): StageLoad => {
  const [load, setLoad] = useState<StageLoad>({ kind: 'loading' })
  const wanted = useRef(seq)
  const wake = useRef<(() => void) | null>(null)

  useEffect(() => {
    wanted.current = seq
    wake.current?.()
  }, [seq])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const stopped = (): boolean => signal.aborted
    const follow = async (): Promise<void> => {
      let loaded: Loaded | null = null
      while (!signal.aborted) {
        if (!changed(wanted.current, loaded)) {
          await nextChange(wake, signal)
          continue
        }
        const target = wanted.current
        try {
          const inspector = await readStage(run, stage, signal)
          loaded = { seq: target === null || inspector.change_seq > target ? inspector.change_seq : target }
          setLoad({ kind: 'ready', inspector, failing: false })
          await pause(refreshGapMs, signal)
        } catch (error) {
          if (stopped()) {
            return
          }
          if (error instanceof SignedOut) {
            onSignedOut()
            return
          }
          if (error instanceof NotFound) {
            loaded = { seq: target }
            setLoad({ kind: 'missing' })
            await pause(refreshGapMs, signal)
            continue
          }
          setLoad((previous) => (previous.kind === 'ready' ? { ...previous, failing: true } : { kind: 'failing' }))
          await pause(retryMs, signal)
        }
      }
    }
    void follow()
    return () => {
      controller.abort()
    }
  }, [run, stage, onSignedOut])

  return load
}
