import { z } from 'zod'
import { decide, delay, type Decision, emptySummary, type HostPlan, type HostSummary, readPlan, writeSummary } from './plan.js'

const Message = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
})
const Init = z.looseObject({ tools: z.array(z.string()) })
const Assistant = z.looseObject({
  message: z.looseObject({ content: z.array(z.looseObject({ type: z.string(), id: z.string().optional(), name: z.string().optional(), input: z.unknown().optional() })) }),
})
const Result = z.looseObject({ subtype: z.string(), is_error: z.boolean(), num_turns: z.number(), session_id: z.string() })

export type PermissionResponse = ReturnType<typeof decide>['response']

export interface Conversation {
  readonly summary: HostSummary
  readonly failed: Promise<never>
  readonly observe: (message: unknown) => void
  readonly permission: (tool: string, toolUseId: string | null, input: Readonly<Record<string, unknown>>) => Promise<PermissionResponse>
  readonly fail: (error: unknown) => void
  readonly converse: (send: (prompt: string) => void) => Promise<void>
  readonly finish: (exitCode: number) => Promise<void>
  readonly endedByInterrupt: () => boolean
}

const errorOf = (error: unknown): Error => error instanceof Error ? error : new Error(String(error))

export const hostArguments = async (usage: string): Promise<{ readonly plan: HostPlan; readonly summary: string; readonly forwarded: readonly string[] }> => {
  const [plan, summary, ...forwarded] = process.argv.slice(2)
  if (plan === undefined || summary === undefined) throw new Error(usage)
  try {
    return { plan: await readPlan(plan), summary, forwarded }
  } catch (error) {
    await writeSummary(summary, { ...emptySummary(), error: errorOf(error).message })
    throw error
  }
}

export const createConversation = (plan: HostPlan, summaryPath: string, interrupt: () => Promise<void>): Conversation => {
  const summary = emptySummary()
  const remaining: Decision[] = [...plan.decisions]
  const state: { turn?: HostPlan['turns'][number]; interrupted: boolean; results: number; wake?: () => void } = { interrupted: false, results: 0 }
  let reject: (error: Error) => void = () => undefined
  const failed = new Promise<never>((_resolve, rejectFailure) => {
    reject = rejectFailure
  })
  failed.catch(() => undefined)
  const fail = (error: unknown): void => {
    summary.error ??= errorOf(error).message
    reject(errorOf(error))
  }
  const scheduleInterrupt = (tool: string, toolUseId: string, delayMs: number): void => {
    state.interrupted = true
    void delay(delayMs).then(async () => {
      summary.interrupts.push({ tool, toolUseId })
      await interrupt()
    }).catch(fail)
  }
  const record = (raw: unknown): void => {
    const message = Message.safeParse(raw)
    if (!message.success) {
      fail(new Error('The engine sent a message without a type'))
      return
    }
    const { type, subtype, session_id: sessionId, parent_tool_use_id: parent } = message.data
    if (sessionId !== undefined && sessionId !== '' && !summary.sessionIds.includes(sessionId)) summary.sessionIds.push(sessionId)
    if (type === 'system' && subtype === 'init') summary.tools = Init.parse(raw).tools
    if (type === 'assistant') {
      for (const block of Assistant.parse(raw).message.content) {
        if (block.type !== 'tool_use' || block.id === undefined || block.name === undefined) continue
        summary.toolUses.push({ id: block.id, name: block.name, parent: parent ?? null, input: block.input })
        const planned = state.turn?.interrupt
        if (planned !== undefined && !state.interrupted && (parent ?? null) === null && block.name === planned.tool) {
          scheduleInterrupt(block.name, block.id, planned.delayMs)
        }
      }
    }
    if (type === 'result') {
      const result = Result.parse(raw)
      summary.results.push({ sessionId: result.session_id, subtype: result.subtype, isError: result.is_error, numTurns: result.num_turns })
      state.results += 1
      state.wake?.()
    }
  }
  const observe = (raw: unknown): void => {
    try {
      record(raw)
    } catch (error) {
      fail(new Error(`Unexpected engine message: ${errorOf(error).message}`))
    }
  }
  const permission = async (tool: string, toolUseId: string | null, input: Readonly<Record<string, unknown>>): Promise<PermissionResponse> => {
    const index = remaining.findIndex((decision) => decision.tool === tool)
    const decision = remaining[index]
    if (decision === undefined) {
      fail(new Error(`Unexpected permission request for ${tool}`))
      return { behavior: 'deny', message: 'Unexpected permission request' }
    }
    remaining.splice(index, 1)
    const started = Date.now()
    await delay(decision.delayMs)
    const { response, answers } = decide(decision, tool, input)
    summary.decisions.push({ tool, behavior: decision.behavior, toolUseId, waitedMs: Date.now() - started, answers })
    return response
  }
  const nextResult = async (expected: number): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    const arrived = new Promise<void>((resolve) => {
      state.wake = () => {
        if (state.results >= expected) resolve()
      }
      state.wake()
    })
    const timeout = new Promise<never>((_resolve, rejectTimeout) => {
      timer = setTimeout(() => {
        rejectTimeout(new Error(`Turn ${String(expected)} did not finish within ${String(plan.turnTimeoutMs)} ms`))
      }, plan.turnTimeoutMs)
    })
    try {
      await Promise.race([arrived, timeout, failed])
    } finally {
      clearTimeout(timer)
      delete state.wake
    }
  }
  const converse = async (send: (prompt: string) => void): Promise<void> => {
    for (const [index, turn] of plan.turns.entries()) {
      if (index > 0) await Promise.race([delay(turn.pauseMs), failed])
      state.turn = turn
      state.interrupted = false
      send(turn.prompt)
      await nextResult(index + 1)
    }
    if (remaining.length > 0) throw new Error(`Planned permission requests did not arrive: ${remaining.map(({ tool }) => tool).join(', ')}`)
    const unsent = plan.turns.filter((turn) => turn.interrupt !== undefined).length - summary.interrupts.length
    if (unsent > 0) throw new Error('A planned interrupt was not sent')
  }
  const finish = async (exitCode: number): Promise<void> => {
    await writeSummary(summaryPath, summary)
    process.exitCode = exitCode
  }
  const endedByInterrupt = (): boolean =>
    state.turn?.interrupt !== undefined && summary.interrupts.length > 0 && summary.results.at(-1)?.isError === true
  return { summary, failed, observe, permission, fail, converse, finish, endedByInterrupt }
}
