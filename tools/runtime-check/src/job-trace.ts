import { readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import { describeProcessTrace, StartedProcess } from './process-trace.js'

const JobProcess = z.object({ Pid: z.number(), Name: z.string().nullable() })

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
  started: z.array(StartedProcess),
  traceError: z.string().nullable(),
  traceVersion: z.number().int().positive(),
  traceState: z.enum(['collecting', 'complete', 'timedOut', 'failed']),
  traceElapsedMs: z.number().nonnegative(),
  traceSnapshots: z.array(z.object({ afterRunMs: z.number(), started: z.array(StartedProcess) })),
})
export type HarnessResult = z.infer<typeof HarnessResult>

export const readHarnessResult = async (path: string): Promise<HarnessResult> =>
  HarnessResult.parse(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')))

export const traceEvidence = (result: HarnessResult, rootName: string, observerPid: number) => ({
  rootPid: result.job.RootPid,
  rootName,
  harnessPid: result.harnessPid,
  observerPid,
  started: result.started,
})

interface TraceDrain {
  readonly resultPath: string
  readonly controlPath: string
  readonly rootName: string
  readonly observerPid: number
  readonly completed: Promise<unknown>
}

export const collectProcessTrace = async (drain: TraceDrain): Promise<HarnessResult> => {
  let running = true
  void drain.completed.then(() => { running = false }, () => { running = false })
  const hasExited = () => !running
  while (!hasExited()) {
    const snapshot = await readHarnessResult(drain.resultPath).catch(() => null)
    if (snapshot !== null) {
      if (snapshot.traceState !== 'collecting') break
      const { job } = snapshot
      let tracedProcesses: number
      try {
        tracedProcesses = describeProcessTrace(traceEvidence(snapshot, drain.rootName, drain.observerPid)).treeFromTrace.processes
      } catch { tracedProcesses = 0 }
      if (snapshot.traceError === null && snapshot.traceElapsedMs >= 1500 && job.Error === null &&
        job.RootExitCode === 0 && !job.RootTimedOut && job.ActiveAfterTerminate === 0 && job.StopConfirmedMs >= 0 &&
        job.TotalProcesses > 0 && tracedProcesses === job.TotalProcesses) {
        await writeFile(`${drain.controlPath}.next`, JSON.stringify({ traceVersion: snapshot.traceVersion }))
        await rename(`${drain.controlPath}.next`, drain.controlPath)
        break
      }
    }
    await setTimeout(25)
  }
  await drain.completed
  return readHarnessResult(drain.resultPath)
}
