import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

const { registry, directory } = workerData as { readonly registry: string; readonly directory: string }
const markers = new Set<string>()

const markerOf = (file: string): string | null => {
  try {
    const entry: unknown = JSON.parse(readFileSync(join(registry, file), 'utf8'))
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || !('cwd' in entry) || entry.cwd !== directory) return null
    return 'entrypoint' in entry && typeof entry.entrypoint === 'string' ? entry.entrypoint : 'missing'
  } catch { return null }
}

const inspect = (): void => {
  if (!existsSync(registry)) return
  let files: string[]
  try { files = readdirSync(registry) }
  catch { markers.add('unreadable'); return }
  for (const file of files) {
    const marker = file.endsWith('.json') ? markerOf(file) : null
    if (marker !== null) markers.add(marker)
  }
}

const timer = setInterval(inspect, 10)

parentPort?.on('message', (request: unknown) => {
  inspect()
  parentPort?.postMessage([...markers])
  markers.clear()
  if (request === 'stop') {
    clearInterval(timer)
    parentPort?.close()
  }
})
