import { type FSWatcher, watch } from 'node:fs'

export interface WatchEvents {
  readonly changed: (name: string) => void
  readonly lost: () => void
}

export interface DirectoryWatch {
  readonly ensure: () => void
  readonly close: () => void
}

export const watchDirectory = (directory: string, recursive: boolean, events: WatchEvents): DirectoryWatch => {
  let watcher: FSWatcher | null = null

  const close = (): void => {
    watcher?.close()
    watcher = null
  }

  const fail = (): void => {
    close()
    events.lost()
  }

  const ensure = (): void => {
    if (watcher !== null) {
      return
    }
    try {
      watcher = watch(directory, { recursive, encoding: 'utf8' }, (_event, name) => {
        if (name === null) {
          fail()
        } else {
          events.changed(name)
        }
      }).on('error', fail)
    } catch {
      watcher = null
    }
  }

  return { ensure, close }
}
