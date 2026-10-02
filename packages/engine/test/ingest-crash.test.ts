import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { type SpoolEnv, spoolFormat } from '@aang/contract'
import { openStore, type Store } from '@aang/store'
import { expect, test } from 'vitest'
import { factsOf, recordsOf } from './harness.js'
import { claudeHook, claudeHookEnv, claudeTranscript } from './samples.js'
import { createWorkspace, type Register } from './workspace.js'

type Child = ChildProcessByStdio<null, Readable, Readable>

interface Fixture {
  readonly home: string
  readonly spool: string
  readonly claude: string
  readonly codex: string
  readonly root: string
  readonly records: number
}

interface Running {
  readonly exited: Promise<never>
  readonly output: (text: string) => Promise<void>
  readonly kill: () => Promise<void>
}

const processScript = fileURLToPath(new URL('./ingest-process.ts', import.meta.url))
const hookSamples = [
  'SessionStart.startup.json',
  'PreToolUse.Bash.json',
  'PermissionRequest.Bash.json',
  'PostToolUse.Bash.json',
]
const settleTimeoutMs = 20_000

const spoolFile = (payload: string, env: SpoolEnv): Buffer =>
  Buffer.concat([
    Buffer.from(`${spoolFormat.magic} claude plugin${spoolFormat.headerLineTerminator}`),
    ...Object.entries(env).map(([key, value]) =>
      Buffer.from(`${key}${spoolFormat.envAssignment}${value}${spoolFormat.envEntryTerminator}`),
    ),
    Buffer.from(spoolFormat.envEntryTerminator),
    Buffer.from(payload),
  ])

const prepareFixture = async (register: Register, root: string): Promise<Fixture> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aang-ingest-')))
  register(() => rm(base, { recursive: true, force: true, maxRetries: 5 }))
  const home = join(base, 'aang')
  const spool = join(home, 'spool')
  const claude = join(base, 'claude')
  const session = { session: 's-crash', cwd: root }
  await mkdir(join(spool, 'new'), { recursive: true })
  for (const [index, sample] of hookSamples.entries()) {
    await writeFile(
      join(spool, 'new', `hook-${String(index)}.evt`),
      spoolFile(claudeHook(sample, session), claudeHookEnv),
    )
  }
  const lines = claudeTranscript(session)
  await mkdir(join(claude, 'projects', '-watched'), { recursive: true })
  await writeFile(join(claude, 'projects', '-watched', 's-crash.jsonl'), `${lines.join('\n')}\n`)
  return { home, spool, claude, codex: join(base, 'codex'), root, records: hookSamples.length + lines.length }
}

const killChild = async (child: Child): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

const runIngest = (register: Register, fixture: Fixture, mode = 'drain'): Running => {
  const { home, spool, claude, codex, root } = fixture
  const child = spawn(process.execPath, [processScript, home, spool, claude, codex, root, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  register(() => killChild(child))
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = once(child, 'exit').then(([code, signal]) => {
    throw new Error(`ingest process exited (${String(code ?? signal)}): ${stderr}`)
  })
  exited.catch(() => undefined)
  return {
    exited,
    output: async (text) => {
      const shown = (async () => {
        while (!stdout.includes(text)) {
          await sleep(20)
        }
      })()
      await Promise.race([shown, exited])
    },
    kill: () => killChild(child),
  }
}

const storedRecords = (fixture: Fixture): number => {
  try {
    const database = new DatabaseSync(join(fixture.home, 'aang.db'), { readOnly: true })
    try {
      return (database.prepare('SELECT count(*) AS records FROM raw_records').get() as { records: number }).records
    } finally {
      database.close()
    }
  } catch {
    return 0
  }
}

const settled = async (fixture: Fixture): Promise<void> => {
  const deadline = Date.now() + settleTimeoutMs
  for (;;) {
    const records = storedRecords(fixture)
    const waiting = await readdir(join(fixture.spool, 'new'))
    if (records === fixture.records && waiting.length === 0) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`ingest did not settle: ${String(records)} records, ${String(waiting.length)} spool files`)
    }
    await sleep(50)
  }
}

const describeStore = (store: Store): unknown => ({
  records: recordsOf(store).map((record) => [record.dedupe_key, record.channel, record.stream]),
  facts: factsOf(store).map((fact) => fact.id),
  cursors: store.cursors.list().map(({ stream, offset, line, size }) => ({ stream, offset, line, size })),
  head: store.changes.head(),
})

const ingestToEnd = async (register: Register, fixture: Fixture, mode?: string): Promise<unknown> => {
  const running = runIngest(register, fixture, mode)
  await running.output('ready\n')
  await Promise.race([settled(fixture), running.exited])
  await running.kill()
  const store = openStore({ home: fixture.home })
  register(() => {
    store.close()
  })
  return describeStore(store)
}

test.for([1, 2])(
  'a SIGKILL of collector and engine right after batch %i is committed and before it is acknowledged duplicates nothing',
  async (crashAfter, { onTestFinished }) => {
    const workspace = await createWorkspace(onTestFinished)
    const reference = await ingestToEnd(onTestFinished, await prepareFixture(onTestFinished, workspace.repository))
    const fixture = await prepareFixture(onTestFinished, workspace.repository)

    const crashing = runIngest(onTestFinished, fixture, `crash-after-${String(crashAfter)}`)
    await crashing.output('committed\n')
    await crashing.kill()
    const left = await readdir(join(fixture.spool, 'new'))

    expect(left).toHaveLength(crashAfter === 1 ? hookSamples.length : 0)
    expect(await ingestToEnd(onTestFinished, fixture)).toEqual(reference)
  },
)
