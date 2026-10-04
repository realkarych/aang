import { type FSWatcher, statSync, watch } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { RunId } from '@aang/contract'
import { contains } from '../ingest/scope.js'

export interface TreeWatch {
  readonly track: (run: RunId, targets: readonly string[]) => void
  readonly close: () => void
}

interface Watched {
  readonly watcher: FSWatcher
  readonly runs: Set<RunId>
}

const wildcard = /[*?[]/

const staticPart = (mask: string): string => {
  const segments = mask.split(/[\\/]/)
  const first = segments.findIndex((segment) => wildcard.test(segment))
  return first === -1 ? mask : segments.slice(0, first).join('/')
}

export const maskTargets = (worktree: string, maskRoot: string, masks: readonly string[]): string[] => [
  ...new Set(
    masks.flatMap((mask) => {
      const target = resolve(maskRoot, staticPart(mask))
      return contains(worktree, target) ? [target] : contains(target, worktree) ? [worktree] : []
    }),
  ),
]

const insideGit = (filename: string): boolean => filename.split(/[\\/]/)[0] === '.git'

const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false

export const createTreeWatch = (onChange: (runs: ReadonlySet<RunId>) => void, settleMs: number): TreeWatch => {
  const watched = new Map<string, Watched>()
  const tracked = new Map<RunId, ReadonlySet<string>>()
  const pending = new Set<RunId>()
  let timer: NodeJS.Timeout | null = null
  let closed = false

  const flush = (): void => {
    timer = null
    const runs = new Set(pending)
    pending.clear()
    if (!closed && runs.size > 0) {
      onChange(runs)
    }
  }

  const changed = (target: string): void => {
    const entry = watched.get(target)
    if (closed || entry === undefined) {
      return
    }
    for (const run of entry.runs) {
      pending.add(run)
    }
    timer ??= setTimeout(flush, settleMs).unref()
  }

  const open = (target: string): FSWatcher | null => {
    try {
      if (isDirectory(target)) {
        return watch(target, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename === null || !insideGit(filename)) {
            changed(target)
          }
        })
      }
      const name = basename(target)
      return watch(dirname(target), { persistent: false }, (_event, filename) => {
        if (filename === null || filename === name) {
          changed(target)
        }
      })
    } catch {
      return null
    }
  }

  const acquire = (run: RunId, target: string): void => {
    const known = watched.get(target)
    if (known !== undefined) {
      known.runs.add(run)
      return
    }
    const watcher = open(target)
    if (watcher === null) {
      return
    }
    const entry: Watched = { watcher, runs: new Set([run]) }
    watcher.on('error', () => {
      watcher.close()
      if (watched.get(target) === entry) {
        watched.delete(target)
      }
    })
    watched.set(target, entry)
  }

  const release = (run: RunId, target: string): void => {
    const entry = watched.get(target)
    entry?.runs.delete(run)
    if (entry !== undefined && entry.runs.size === 0) {
      entry.watcher.close()
      watched.delete(target)
    }
  }

  return {
    track: (run, targets) => {
      if (closed) {
        return
      }
      const next = new Set(targets)
      const previous = tracked.get(run) ?? new Set<string>()
      for (const target of previous) {
        if (!next.has(target)) {
          release(run, target)
        }
      }
      for (const target of next) {
        if (!watched.get(target)?.runs.has(run)) {
          acquire(run, target)
        }
      }
      if (next.size === 0) {
        tracked.delete(run)
      } else {
        tracked.set(run, next)
      }
    },
    close: () => {
      closed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      for (const { watcher } of watched.values()) {
        watcher.close()
      }
      watched.clear()
      tracked.clear()
      pending.clear()
    },
  }
}
