import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const startDescendant = async (options: { readonly pidFile: string; readonly inheritStdio: boolean } | undefined): Promise<void> => {
  if (options === undefined) return
  const child = spawn(process.execPath, [fileURLToPath(new URL('descendant.js', import.meta.url)), options.pidFile], {
    stdio: options.inheritStdio ? 'inherit' : 'ignore',
    windowsHide: true,
  })
  child.unref()
  const deadline = Date.now() + 10_000
  while (!existsSync(options.pidFile)) {
    if (Date.now() > deadline) throw new Error('Fake CLI descendant did not start')
    await setTimeout(10)
  }
}
