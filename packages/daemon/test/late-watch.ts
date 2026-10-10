import fs, { type PathLike, type WatchListener, type WatchOptionsWithStringEncoding } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const silentMs = 500
const { watch } = fs

fs.watch = ((path: PathLike, options: WatchOptionsWithStringEncoding, listener: WatchListener<string>) => {
  const openedAt = performance.now()
  return watch(path, options, (event, name) => {
    if (performance.now() - openedAt >= silentMs) {
      listener(event, name)
    }
  })
}) as typeof fs.watch
syncBuiltinESMExports()
