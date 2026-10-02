import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeInvocation, readSteps } from './claude.js'
import { codexInvocation, type CommandForm, newPatch, writeCodexHome } from './codex.js'
import type { CheckContext, Invocation } from './context.js'
import { collectProcessTrace, type HarnessResult, traceEvidence } from './job-trace.js'
import { allEventHooks } from './latency.js'
import { prepareClaudeObserver, prepareCodexObserver } from './observer.js'
import { describeProcessTrace, nameCounts } from './process-trace.js'
import { writeJson } from './profile.js'
import { errorCode, excerpt, isWindows, outcome, quoteWindowsArgument, run } from './process.js'

const harness = fileURLToPath(new URL('../assets/job-run.ps1', import.meta.url))

const environmentBlock = (env: NodeJS.ProcessEnv): string[] =>
  Object.entries(env)
    .flatMap(([name, value]) => (value === undefined ? [] : [{ name, entry: `${name}=${value}` }]))
    .sort((left, right) => (left.name.toUpperCase() < right.name.toUpperCase() ? -1 : 1))
    .map(({ entry }) => entry)

const windowsCommandLine = (argv: readonly string[]): string => argv.map(quoteWindowsArgument).join(' ')

const runInJob = async (
  context: CheckContext,
  id: string,
  invocation: Invocation,
): Promise<Record<string, unknown>> => {
  const prefix = join(context.work, `job-${id}`)
  const files = {
    spec: `${prefix}-spec.json`,
    result: `${prefix}-result.json`,
    control: `${prefix}-trace-control.json`,
    stdin: `${prefix}-stdin.txt`,
    stdout: `${prefix}-stdout.txt`,
    stderr: `${prefix}-stderr.txt`,
  }
  await Promise.all([files.result, files.control].map((path) => rm(path, { force: true })))
  await writeFile(files.stdin, invocation.stdin)
  await writeJson(files.spec, {
    commandLine: windowsCommandLine([invocation.command, ...invocation.args]),
    environment: environmentBlock(invocation.env),
    cwd: invocation.cwd,
    stdin: files.stdin,
    stdout: files.stdout,
    stderr: files.stderr,
    timeoutMs: 150_000,
    traceControl: files.control,
  })
  invocation.arm()
  const running = run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, files.spec, files.result],
    { env: process.env, cwd: invocation.cwd, timeoutMs: 240_000 },
  )
  let parsed: HarnessResult
  try {
    parsed = await collectProcessTrace({ resultPath: files.result, controlPath: files.control,
      rootName: basename(invocation.command), observerPid: process.pid, completed: running })
  } catch (error) {
    return { harness: outcome(await running), unreadableResult: errorCode(error) }
  }
  const launched = await running
  const { job } = parsed
  const evidence = traceEvidence(parsed, basename(invocation.command), process.pid)
  let trace: ReturnType<typeof describeProcessTrace> | undefined
  let traceError = parsed.traceError ?? (parsed.traceState === 'complete' ? null : 'Process trace collection did not complete')
  try { trace = describeProcessTrace(evidence) } catch (error) { traceError ??= errorCode(error) }
  const stdout = await readFile(files.stdout, 'utf8').catch(() => '')
  return {
    harness: outcome(launched),
    error: job.Error,
    rootExitCode: job.RootExitCode,
    rootTimedOut: job.RootTimedOut,
    durationMs: job.DurationMs,
    jobTotalProcesses: job.TotalProcesses,
    seenInJob: nameCounts(job.Seen.map(({ Name }) => ({ name: Name }))),
    remainingAfterRootExit: job.RemainingAfterRootExit.map(({ Pid, Name }) => ({ pid: Pid, name: Name })),
    activeAfterTerminate: job.ActiveAfterTerminate,
    stopConfirmedMs: job.StopConfirmedMs,
    traceError,
    ...trace,
    stdoutTail: excerpt(stdout.trim().split(/\r?\n/).at(-1) ?? '', 400),
    processEvidence: { ...evidence, seenInJob: job.Seen, traceSnapshots: parsed.traceSnapshots,
      traceVersion: parsed.traceVersion, traceState: parsed.traceState, traceElapsedMs: parsed.traceElapsedMs },
  }
}

export const processTrees = async (
  context: CheckContext,
  form: CommandForm | null,
): Promise<Record<string, unknown>> => {
  if (!isWindows) {
    return { skipped: 'Job Objects exist only on Windows' }
  }
  const codexHome = join(context.work, 'codex-jobs')
  await writeCodexHome(context, codexHome, form === null ? null : allEventHooks(context, form))
  const codexSteps = [
    newPatch(context, 'jobs').step,
    { type: 'function_call' as const, name: 'exec_command', arguments: { cmd: 'echo aang' } },
  ]
  const claudeSteps = [...readSteps(context, 1), { name: 'Bash', input: { command: 'echo aang', description: 'echo' } }]
  const claudeObserver = await prepareClaudeObserver(context)
  const codexObserver = await prepareCodexObserver(context)
  const runs: readonly [string, Invocation][] = [
    [
      'claude session with hooks and Bash',
      claudeInvocation(context, { steps: 0, toolSteps: claudeSteps, tools: 'Read,Bash' }),
    ],
    [
      'codex.exe session with hooks and a shell command',
      codexInvocation(context, { home: codexHome, steps: codexSteps }),
    ],
    ['codex npm wrapper session', codexInvocation(context, { home: codexHome, steps: codexSteps, wrapper: true })],
    ['claude observer profile', claudeObserver.invocation({})],
    ['codex observer profile', codexObserver.invocation({})],
  ]
  const results: Record<string, unknown> = {}
  for (const [id, invocation] of runs) {
    results[id] = await runInJob(context, id.replaceAll(' ', '-'), invocation)
  }
  return results
}
