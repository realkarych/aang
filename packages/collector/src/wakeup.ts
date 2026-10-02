export interface Wakeup {
  readonly notify: () => void
  readonly wait: () => Promise<void>
}

export const createWakeup = (): Wakeup => {
  let pending = false
  let resume: (() => void) | null = null
  return {
    notify: () => {
      pending = true
      resume?.()
      resume = null
    },
    wait: async () => {
      if (!pending) {
        await new Promise<void>((resolve) => {
          resume = resolve
        })
      }
      pending = false
    },
  }
}
