import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
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

export const leaveProcessGroup = async (options: { readonly pidFile?: string | undefined; readonly lifetimeMs: number }): Promise<void> => {
  if (process.platform === 'win32') return
  const script = fileURLToPath(new URL('escaped-descendant.js', import.meta.url))
  const child = spawn(process.execPath, [script, String(options.lifetimeMs), ...(options.pidFile === undefined ? [] : [options.pidFile])], { detached: true, stdio: 'ignore' })
  const exited = once(child, 'exit')
  await once(child, 'spawn')
  child.unref()
  await Promise.race([exited, setTimeout(500)])
}
