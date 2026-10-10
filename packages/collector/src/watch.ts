import { type FSWatcher, statSync, watch } from 'node:fs'
import { dirname } from 'node:path'

export interface WatchEvents {
  readonly changed: (name: string) => void
  readonly missed: () => void
}

export interface DirectoryWatch {
  readonly ensure: () => boolean
  readonly reset: () => void
  readonly close: () => void
}

export interface RootWatch {
  readonly ensure: () => void
  readonly close: () => void
}

export const watchDirectory = (directory: string, recursive: boolean, events: WatchEvents): DirectoryWatch => {
  let watcher: FSWatcher | null = null

  const close = (): void => {
    watcher?.close()
    watcher = null
  }

  const reset = (): void => {
    close()
    events.missed()
  }

  const ensure = (): boolean => {
    if (watcher !== null) {
      return true
    }
    try {
      watcher = watch(directory, { recursive, encoding: 'utf8' }, (_event, name) => {
        if (name === null) {
          reset()
        } else {
          events.changed(name)
        }
      }).on('error', reset)
    } catch {
      watcher = null
    }
    return watcher !== null
  }

  return { ensure, reset, close }
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
  } catch {
    return false
  }
}

const awaitedEntry = (directory: string): string | null => {
  for (let entry = directory, parent = dirname(entry); parent !== entry; entry = parent, parent = dirname(entry)) {
    if (isDirectory(parent)) {
      return entry
    }
  }
  return null
}

interface Awaiting {
  readonly entry: string
  readonly parent: DirectoryWatch
}

export const watchRoot = (directory: string, recursive: boolean, events: WatchEvents): RootWatch => {
  const root = watchDirectory(directory, recursive, events)
  let awaiting: Awaiting | null = null

  const stopAwaiting = (): void => {
    awaiting?.parent.close()
    awaiting = null
  }

  const ensure = (): void => {
    for (;;) {
      if (isDirectory(directory)) {
        root.ensure()
        if (awaiting !== null) {
          stopAwaiting()
          events.missed()
        }
        return
      }
      root.close()
      const entry = awaitedEntry(directory)
      if (awaiting?.entry !== entry) {
        stopAwaiting()
        awaiting =
          entry === null ? null : { entry, parent: watchDirectory(dirname(entry), false, { changed: check, missed: ensure }) }
      }
      if (awaiting === null || !awaiting.parent.ensure() || !isDirectory(awaiting.entry)) {
        return
      }
    }
  }

  const check = (): void => {
    if (awaiting !== null && isDirectory(awaiting.entry)) {
      ensure()
    }
  }

  const close = (): void => {
    root.close()
    stopAwaiting()
  }

  return { ensure, close }
}
