import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [fixtures] = process.argv.slice(2)
if (fixtures === undefined) throw new Error('Usage: plan-sizes.mjs <fixtures>')

const isPlan = (path) => typeof path === 'string' && path.endsWith('PLAN.md')

const writes = (value, found) => {
  if (Array.isArray(value)) {
    for (const item of value) writes(item, found)
    return found
  }
  if (value === null || typeof value !== 'object') return found
  if (value.name === 'Write' && isPlan(value.input?.file_path)) found.push(['Write', value.input.content?.length ?? 0])
  if (value.name === 'Edit' && isPlan(value.input?.file_path)) found.push(['Edit', value.input.new_string?.length ?? 0])
  if (value.changes !== null && typeof value.changes === 'object' && !Array.isArray(value.changes)) {
    for (const [path, change] of Object.entries(value.changes)) {
      if (isPlan(path)) found.push([change.type, (change.content ?? change.unified_diff ?? '').length])
    }
  }
  for (const item of Object.values(value)) writes(item, found)
  return found
}

const directories = async (path) => (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name)

for (const runtime of await directories(fixtures)) {
  for (const version of await directories(join(fixtures, runtime))) {
    for (const surface of await directories(join(fixtures, runtime, version))) {
      for (const os of await directories(join(fixtures, runtime, version, surface))) {
        for (const scenario of (await directories(join(fixtures, runtime, version, surface, os))).filter((name) => name.startsWith('workload-'))) {
          const data = join(fixtures, runtime, version, surface, os, scenario, 'data')
          const found = []
          for (const file of (await readdir(data)).filter((name) => name.endsWith('.jsonl')).sort()) {
            for (const line of (await readFile(join(data, file), 'utf8')).split('\n')) {
              if (line.trim() === '') continue
              try {
                writes(JSON.parse(line), found)
              } catch {
                continue
              }
            }
          }
          const unique = [...new Map(found.map((entry) => [entry.join(':'), entry])).values()]
          process.stdout.write(`${runtime}/${version}/${surface}/${os}/${scenario}: ${unique.map(([kind, length]) => `${String(kind)} ${String(length)}`).join(', ')}\n`)
        }
      }
    }
  }
}
