import { renameSync, writeFileSync } from 'node:fs'

const [lifetime = '0', path] = process.argv.slice(2)
if (path !== undefined) {
  writeFileSync(`${path}.tmp`, String(process.pid))
  renameSync(`${path}.tmp`, path)
}
setTimeout(() => undefined, Number(lifetime))
