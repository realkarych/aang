import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const built = (relative: string): string => {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; run pnpm build first`)
  }
  return path
}

export const daemonEntry = built('../../aang/dist/main.js')

export const hookBinary = built(`../../hook/bin/aang-hook${process.platform === 'win32' ? '.exe' : ''}`)
