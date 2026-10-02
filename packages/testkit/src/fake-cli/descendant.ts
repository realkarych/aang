import { renameSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
if (path === undefined) throw new Error('Descendant PID path is required')
writeFileSync(`${path}.tmp`, String(process.pid))
renameSync(`${path}.tmp`, path)
setInterval(() => undefined, 60_000)
