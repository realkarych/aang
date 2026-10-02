import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const execFileAsync = promisify(execFile)

test('deferred payloads are released after ingest returns while the engine keeps running', async () => {
  const script = fileURLToPath(new URL('./ingest-memory-process.ts', import.meta.url))
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--expose-gc', script])
  expect(stdout).toBe('')
  expect(stderr).toBe('')
})
