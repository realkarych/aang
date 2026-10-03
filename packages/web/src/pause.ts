export const pause = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const stop = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      resolve()
    }
    const timer = setTimeout(stop, milliseconds)
    signal.addEventListener('abort', stop, { once: true })
  })
