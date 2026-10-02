import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { claudeInvocation, readSteps } from './claude.js'
import { codexInvocation, type CommandForm, newPatch, writeCodexHome } from './codex.js'
import type { CheckContext, Invocation } from './context.js'
import { allEventHooks } from './latency.js'
import { prepareClaudeObserver, prepareCodexObserver } from './observer.js'
import { writeJson } from './profile.js'
import { errorCode, excerpt, isWindows, outcome, quoteWindowsArgument, run } from './process.js'

const JobProcess = z.object({ Pid: z.number(), Name: z.string().nullable() })

const StartedProcess = z.object({
  pid: z.number(),
  ppid: z.number(),
  name: z.string(),
  parentName: z.string().nullable(),
  createdAt: z.string(),
  receivedAt: z.string(),
})
type StartedProcess = z.infer<typeof StartedProcess>

const HarnessResult = z.object({
  harnessPid: z.number(),
  job: z.object({
    Error: z.string().nullable(),
    RootPid: z.number(),
    RootExitCode: z.number(),
    RootTimedOut: z.boolean(),
    TotalProcesses: z.number(),
    Seen: z.array(JobProcess),
    RemainingAfterRootExit: z.array(JobProcess),
    ActiveAfterTerminate: z.number(),
    StopConfirmedMs: z.number(),
    DurationMs: z.number(),
  }),
  started: z
    .union([z.array(StartedProcess), StartedProcess, z.null()])
    .transform((value) => (value === null ? [] : 'pid' in value ? [value] : value)),
  traceError: z.string().nullable(),
  traceSnapshots: z.array(z.object({ afterRunMs: z.number(), started: z.array(StartedProcess) })),
})
type HarnessResult = z.infer<typeof HarnessResult>

const harness = fileURLToPath(new URL('../assets/job-run.ps1', import.meta.url))

const environmentBlock = (env: NodeJS.ProcessEnv): string[] =>
  Object.entries(env)
    .flatMap(([name, value]) => (value === undefined ? [] : [{ name, entry: `${name}=${value}` }]))
    .sort((left, right) => (left.name.toUpperCase() < right.name.toUpperCase() ? -1 : 1))
    .map(({ entry }) => entry)

const windowsCommandLine = (argv: readonly string[]): string => argv.map(quoteWindowsArgument).join(' ')

const descendants = (root: number, started: readonly StartedProcess[]): StartedProcess[] => {
  const tree = new Set([root])
  const found: StartedProcess[] = []
  let grew = true
  while (grew) {
    grew = false
    for (const candidate of started) {
      if (!tree.has(candidate.pid) && tree.has(candidate.ppid)) {
        tree.add(candidate.pid)
        found.push(candidate)
        grew = true
      }
    }
  }
  return found
}

const nameCounts = (processes: readonly { readonly name: string | null }[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const { name } of processes) {
    const key = name ?? '?'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

const runInJob = async (
  context: CheckContext,
  id: string,
  invocation: Invocation,
): Promise<Record<string, unknown>> => {
  const prefix = join(context.work, `job-${id}`)
  const files = {
    spec: `${prefix}-spec.json`,
    result: `${prefix}-result.json`,
    stdin: `${prefix}-stdin.txt`,
    stdout: `${prefix}-stdout.txt`,
    stderr: `${prefix}-stderr.txt`,
  }
  await writeFile(files.stdin, invocation.stdin)
  await writeJson(files.spec, {
    commandLine: windowsCommandLine([invocation.command, ...invocation.args]),
    environment: environmentBlock(invocation.env),
    cwd: invocation.cwd,
    stdin: files.stdin,
    stdout: files.stdout,
    stderr: files.stderr,
    timeoutMs: 150_000,
  })
  invocation.arm()
  const launched = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, files.spec, files.result],
    { env: process.env, cwd: invocation.cwd, timeoutMs: 240_000 },
  )
  let parsed: HarnessResult
  try {
    parsed = HarnessResult.parse(JSON.parse((await readFile(files.result, 'utf8')).replace(/^\uFEFF/, '')))
  } catch (error) {
    return { harness: outcome(launched), unreadableResult: errorCode(error) }
  }
  const { job, traceError, started, harnessPid } = parsed
  const tree = descendants(job.RootPid, started)
  const ownPids = new Set([process.pid, harnessPid, ...descendants(process.pid, started).map(({ pid }) => pid)])
  const treePids = new Set([job.RootPid, ...tree.map(({ pid }) => pid)])
  const names = new Map(started.map(({ pid, name }) => [pid, name]))
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
    treeFromTrace: { processes: tree.length + 1, names: nameCounts(tree) },
    startedOutsideTree: started
      .filter(({ pid }) => !treePids.has(pid) && !ownPids.has(pid))
      .map(({ pid, ppid, name, parentName }) => ({ pid, name, ppid, parent: names.get(ppid) ?? parentName })),
    stdoutTail: excerpt(stdout.trim().split(/\r?\n/).at(-1) ?? '', 400),
    processEvidence: { rootPid: job.RootPid, harnessPid, started, seenInJob: job.Seen, traceSnapshots: parsed.traceSnapshots },
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
