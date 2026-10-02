import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { collectProcessTrace, traceEvidence } from '../dist/job-trace.js'
import { describeProcessTrace } from '../dist/process-trace.js'
import { quoteWindowsArgument, run, type RunResult } from '../dist/process.js'

test('Windows PowerShell publishes and replaces real Job trace snapshots atomically', async ({ skip }) => {
  skip(process.platform !== 'win32', 'The native Job Object harness requires Windows PowerShell 5.1 and Windows WMI')
  const directory = await mkdtemp(join(tmpdir(), 'aang native job проверка '))
  let running: Promise<RunResult> | undefined
  try {
    const specPath = join(directory, 'spec.json')
    const resultPath = join(directory, 'result.json')
    const controlPath = join(directory, 'control.json')
    const stdinPath = join(directory, 'stdin.txt')
    const stdoutPath = join(directory, 'stdout.txt')
    const payload = 'native job fixture\n'
    await writeFile(stdinPath, payload)
    await writeFile(specPath, JSON.stringify({
      commandLine: [process.execPath, fileURLToPath(new URL('./fixtures/job-child.mjs', import.meta.url))]
        .map(quoteWindowsArgument).join(' '),
      environment: Object.entries(process.env).flatMap(([name, value]) => value === undefined ? [] : [`${name}=${value}`])
        .sort((left, right) => left.toUpperCase() < right.toUpperCase() ? -1 : 1),
      cwd: directory, stdin: stdinPath, stdout: stdoutPath, stderr: join(directory, 'stderr.txt'),
      timeoutMs: 5000, traceControl: controlPath,
    }))
    running = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../assets/job-run.ps1', import.meta.url)), specPath, resultPath],
    { env: process.env, cwd: directory, timeoutMs: 45_000 })
    const result = await collectProcessTrace({ resultPath, controlPath, rootName: basename(process.execPath),
      observerPid: process.pid, completed: running })
    const launched = await running
    expect(launched, launched.stderr).toMatchObject({ status: 0, error: null, timedOut: false })
    expect(result).toMatchObject({ traceState: 'complete', traceError: null,
      job: { Error: null, RootExitCode: 0, RootTimedOut: false, ActiveAfterTerminate: 0 } })
    expect(result.traceVersion).toBeGreaterThan(1)
    expect(result.job.StopConfirmedMs).toBeGreaterThanOrEqual(0)
    const trace = describeProcessTrace(traceEvidence(result, basename(process.execPath), process.pid))
    expect(trace.treeFromTrace.processes).toBeGreaterThan(0)
    expect(trace.treeFromTrace.processes).toBe(result.job.TotalProcesses)
    expect(await readFile(stdoutPath, 'utf8')).toBe(payload)
  } finally {
    await running
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
