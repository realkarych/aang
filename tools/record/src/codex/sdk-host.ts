import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

const Plan = z.strictObject({
  module: z.string().min(1),
  cwd: z.string().min(1),
  turns: z.array(z.strictObject({ prompt: z.string().min(1), resume: z.boolean() })).min(1),
})

interface Streamed {
  readonly events: AsyncIterable<unknown>
}

interface Thread {
  readonly runStreamed: (input: string) => Promise<Streamed>
}

interface Codex {
  readonly startThread: (options: Readonly<Record<string, unknown>>) => Thread
  readonly resumeThread: (id: string, options: Readonly<Record<string, unknown>>) => Thread
}

const Sdk = z.looseObject({ Codex: z.custom<new () => Codex>((value) => typeof value === 'function') })
const Started = z.looseObject({ type: z.literal('thread.started'), thread_id: z.string() })

const [planPath, ...extra] = process.argv.slice(2)
if (planPath === undefined || extra.length > 0) throw new Error('Usage: sdk-host <plan.json>')
const plan = Plan.parse(JSON.parse(await readFile(planPath, 'utf8')))
const sdk = Sdk.parse(await import(pathToFileURL(plan.module).href))
const codex = new sdk.Codex()
const options = { workingDirectory: plan.cwd, skipGitRepoCheck: true }
let thread = codex.startThread(options)
let threadId: string | undefined
for (const turn of plan.turns) {
  if (turn.resume) {
    if (threadId === undefined) throw new Error('A resumed turn needs a started thread')
    thread = codex.resumeThread(threadId, options)
  }
  const { events } = await thread.runStreamed(turn.prompt)
  for await (const event of events) {
    process.stdout.write(`${JSON.stringify(event)}\n`)
    const started = Started.safeParse(event)
    if (started.success) threadId = started.data.thread_id
  }
}
