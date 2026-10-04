import childProcess, { type ExecFileOptions } from 'node:child_process'
import { writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const [, , home, project, session, commit] = process.argv

if (home === undefined || project === undefined || session === undefined || commit === undefined) {
  throw new Error('usage: criteria-process <home> <project> <session> <commit>')
}

const storedRecords = (): number => {
  const database = new DatabaseSync(join(home, 'aang.db'), { readOnly: true })
  try {
    return (database.prepare('SELECT count(*) AS records FROM raw_records').get() as { records: number }).records
  } finally {
    database.close()
  }
}

const { execFile } = childProcess
const runGit = promisify(execFile)
const killedAfterCommit = (file: string, args: readonly string[], options: ExecFileOptions) => {
  if (file === 'git' && storedRecords() > 0) {
    process.kill(process.pid, 'SIGKILL')
  }
  return runGit(file, args, options)
}
Object.defineProperty(childProcess, 'execFile', {
  value: Object.assign((...args: Parameters<typeof execFile>) => execFile(...args), { [promisify.custom]: killedAfterCommit }),
})
syncBuiltinESMExports()

const { createEngine } = await import('@aang/engine')
const { openStore } = await import('@aang/store')
const { hookBatch } = await import('./batches.ts')
const { testContract, verifiedCheck } = await import('./check-hooks.ts')
const { adapters } = await import('./harness.ts')

const store = openStore({ home })
const engine = createEngine({
  store,
  adapters,
  watch: { all: true, roots: [{ path: project, contracts: [testContract(['src'])] }] },
  fsWatch: false,
})
await engine.ingest(hookBatch(...verifiedCheck({ session, cwd: project }, commit)))
writeSync(1, 'ingested\n')
