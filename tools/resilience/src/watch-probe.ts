import { appendFileSync, closeSync, mkdirSync, openSync, statSync, watch, writeSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export type WriteMode = 'reopen' | 'held'

export interface WatchProbe {
  readonly mode: WriteMode
  readonly writes: number
  readonly writesSeen: number
  readonly lastWriteSeen: boolean
  readonly events: number
}

const appendAt: readonly number[] = [0, 20, 60, 150, 300, 600, 1_000, 1_500, 2_500]

export const probeWatch = async (directory: string, mode: WriteMode): Promise<WatchProbe> => {
  const root = join(directory, `watch-${mode}`)
  mkdirSync(root, { recursive: true })
  const file = join(root, 'nested', 'stream.jsonl')
  const sizes: number[] = []
  const seen = new Set<number>()
  let events = 0
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (name === null || !name.endsWith('stream.jsonl')) return
    events += 1
    try {
      seen.add(statSync(file).size)
    } catch {
      return
    }
  })
  try {
    await sleep(200)
    mkdirSync(join(root, 'nested'), { recursive: true })
    const descriptor = mode === 'held' ? openSync(file, 'a') : null
    const started = performance.now()
    try {
      for (const at of appendAt) {
        const wait = at - (performance.now() - started)
        if (wait > 0) await sleep(wait)
        const line = `{"at":${String(at)}}\n`
        if (descriptor === null) appendFileSync(file, line)
        else writeSync(descriptor, line)
        sizes.push(statSync(file).size)
      }
      await sleep(1_000)
    } finally {
      if (descriptor !== null) closeSync(descriptor)
    }
    return {
      mode,
      writes: sizes.length,
      writesSeen: sizes.filter((size) => seen.has(size)).length,
      lastWriteSeen: seen.has(sizes.at(-1) ?? -1),
      events,
    }
  } finally {
    watcher.close()
  }
}
