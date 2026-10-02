import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { checkSection } from '../dist/checks.js'
import { collectProcessTrace, type HarnessResult, traceEvidence } from '../dist/job-trace.js'
import { describeProcessTrace, StartedProcess } from '../dist/process-trace.js'

const root = { pid: 10, ppid: 1, name: 'codex.exe', parentName: null, createdAt: '134354340829078202' }
const child = { pid: 20, ppid: 10, name: 'aang-hook.exe', parentName: null, createdAt: '134354340829078203' }
const first: HarnessResult = {
  harnessPid: 1,
  job: { Error: null, RootPid: 10, RootExitCode: 0, RootTimedOut: false, TotalProcesses: 2,
    Seen: [{ Pid: 10, Name: 'codex' }, { Pid: 20, Name: 'aang-hook' }], RemainingAfterRootExit: [],
    ActiveAfterTerminate: 0, StopConfirmedMs: 1, DurationMs: 100 },
  started: [root], traceError: null, traceVersion: 1, traceState: 'collecting', traceElapsedMs: 1500, traceSnapshots: [],
}

const publish = async (next: HarnessResult, finalEvent?: typeof child, initial = first, rootName = 'codex.exe', observerPid = 2) => {
  const directory = await mkdtemp(join(tmpdir(), 'aang-trace-'))
  try {
    const specPath = join(directory, 'spec.json')
    const resultPath = join(directory, 'result.json')
    const controlPath = join(directory, 'control.json')
    await writeFile(specPath, JSON.stringify({ first: initial, next, finalEvent }))
    const publisher = spawn(process.execPath,
      [fileURLToPath(new URL('./fixtures/trace-publisher.mjs', import.meta.url)), specPath, resultPath, controlPath],
      { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    publisher.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const completed = new Promise<void>((resolve, reject) => {
      publisher.once('error', reject)
      publisher.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(stderr)) })
    })
    const result = await collectProcessTrace({ resultPath, controlPath, rootName, observerPid, completed })
    const acknowledgment = await readFile(controlPath, 'utf8').catch(() => null)
    return { result, acknowledgment }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const acceptance = (result: HarnessResult, rootName = 'codex.exe', observerPid = 2) => {
  const entry = { harness: { status: 0, timedOut: false, error: null }, error: result.job.Error,
    rootExitCode: result.job.RootExitCode, rootTimedOut: result.job.RootTimedOut,
    activeAfterTerminate: result.job.ActiveAfterTerminate, stopConfirmedMs: result.job.StopConfirmedMs,
    jobTotalProcesses: result.job.TotalProcesses, traceError: result.traceError,
    ...describeProcessTrace(traceEvidence(result, rootName, observerPid)) }
  return checkSection('process trees in a job object', Object.fromEntries([
    'claude session with hooks and Bash', 'codex.exe session with hooks and a shell command', 'codex npm wrapper session',
    'claude observer profile', 'codex observer profile',
  ].map((name) => [name, entry])))
}

test('late trace delivery completes only after exact Job accounting, and the final snapshot is read again', async () => {
  const captured = z.object({ rootPid: z.number(), rootName: z.string(), harnessPid: z.number(), observerPid: z.number(), jobTotalProcesses: z.number(),
    earlyAfterRunMs: z.number(), lateAfterRunMs: z.number(), started: z.array(StartedProcess), delivered: z.array(StartedProcess) })
    .parse(JSON.parse(await readFile(new URL('./fixtures/delayed-trace.json', import.meta.url), 'utf8')))
  const initial = { ...first, harnessPid: captured.harnessPid, traceElapsedMs: captured.earlyAfterRunMs, started: captured.started,
    job: { ...first.job, RootPid: captured.rootPid, TotalProcesses: captured.jobTotalProcesses, Seen: [] } }
  const next = { ...initial, traceVersion: 2, traceElapsedMs: captured.lateAfterRunMs,
    started: [...captured.started, ...captured.delivered] }
  expect(describeProcessTrace(traceEvidence(initial, captured.rootName, captured.observerPid)).treeFromTrace.processes).toBe(46)
  const { result, acknowledgment } = await publish(next, undefined, initial, captured.rootName, captured.observerPid)
  expect(acknowledgment).toBe(JSON.stringify({ traceVersion: 2 }))
  expect(result.traceVersion).toBe(3)
  expect(result.traceState).toBe('complete')
  expect(describeProcessTrace(traceEvidence(result, captured.rootName, captured.observerPid)).treeFromTrace.processes).toBe(47)
  expect(acceptance(result, captured.rootName, captured.observerPid).status).toBe('passed')
})

test('a CLI process delivered after acknowledgment still fails the final containment check', async () => {
  const { result } = await publish({ ...first, traceVersion: 2, started: [root, child] },
    { ...child, pid: 30, createdAt: '134354340829078204' })
  expect(result.traceState).toBe('complete')
  expect(acceptance(result).status).toBe('failed')
})

test('a permanently incomplete trace expires without acknowledgment and fails acceptance', async () => {
  const { result, acknowledgment } = await publish({ ...first, traceVersion: 2 })
  expect(acknowledgment).toBeNull()
  expect(result.traceState).toBe('timedOut')
  expect(acceptance(result).status).toBe('failed')
})
