import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Wakeup } from './wakeup.js'
import { type DirectoryWatch, watchDirectory } from './watch.js'

export interface TreeRoot {
  readonly directory: string
  readonly recursive: boolean
}

export interface TreeEvents {
  readonly changed: (root: TreeRoot, path: string) => void
  readonly listed: (root: TreeRoot, paths: readonly string[]) => Promise<void>
}

export interface TreeOptions {
  readonly roots: readonly TreeRoot[]
  readonly fsWatch: boolean
  readonly scanIntervalMs: number
}

export interface Tree {
  readonly open: () => void
  readonly close: () => Promise<void>
}

export const segmentsOf = (root: TreeRoot, path: string): string[] => relative(root.directory, path).split(sep)

const listFiles = async (root: TreeRoot): Promise<string[]> => {
  const found: string[] = []
  const pending = [root.directory]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of await readdir(next, { withFileTypes: true }).catch(() => [])) {
      const path = join(next, entry.name)
      if (entry.isDirectory() && root.recursive) {
        pending.push(path)
      } else if (entry.isFile()) {
        found.push(path)
      }
    }
  }
  return found
}

export const createTree = (options: TreeOptions, events: TreeEvents, wakeup: Wakeup): Tree => {
  const watches = new Map<TreeRoot, DirectoryWatch>()
  let scanRequested = false
  let scanning: Promise<void> | null = null
  let timer: NodeJS.Timeout | undefined
  let closed = false

  const scan = async (): Promise<void> => {
    for (const root of options.roots) {
      watches.get(root)?.ensure()
      await events.listed(root, await listFiles(root))
    }
  }

  const runScans = async (): Promise<void> => {
    while (scanRequested && !closed) {
      scanRequested = false
      await scan()
      wakeup.notify()
    }
    scanning = null
    timer = closed ? undefined : setTimeout(requestScan, options.scanIntervalMs)
  }

  const requestScan = (): void => {
    scanRequested = true
    if (scanning === null) {
      clearTimeout(timer)
      scanning = runScans()
    }
  }

  const open = (): void => {
    if (options.fsWatch) {
      for (const root of options.roots) {
        watches.set(
          root,
          watchDirectory(root.directory, root.recursive, {
            changed: (name) => {
              events.changed(root, join(root.directory, name))
            },
            lost: requestScan,
          }),
        )
      }
    }
    requestScan()
  }

  const close = async (): Promise<void> => {
    closed = true
    clearTimeout(timer)
    for (const watch of watches.values()) {
      watch.close()
    }
    await scanning
  }

  return { open, close }
}
