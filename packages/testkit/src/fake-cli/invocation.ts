import type { Runtime } from '@aang/contract'
import { environment, finish, say } from './io.js'
import { scenarioMessage } from './profile.js'
import { fakeCliExitCodes, type FakeCall, type FakeCommand } from './scenario.js'
import { claimCall, claimReply, writeCall } from './state.js'
import { TemplateError } from './template.js'

export interface PickedReply<R> {
  readonly index: number
  readonly reply: R | undefined
}

export interface Invocation {
  readonly state: string
  readonly argv: readonly string[]
  readonly record: (command: FakeCommand, fields?: Partial<FakeCall>) => void
  readonly nextReply: <R>(replies: readonly R[]) => PickedReply<R>
  readonly missingReply: (index: number | null) => void
}

export const invocation = (runtime: Runtime): Invocation => {
  const [state = '', ...argv] = process.argv.slice(2)
  return {
    state,
    argv,
    record: (command, fields = {}) => {
      writeCall(state, {
        sequence: claimCall(state),
        runtime,
        command,
        argv,
        cwd: process.cwd(),
        env: environment(),
        pid: process.pid,
        prompt: null,
        systemPrompt: null,
        schema: null,
        reply: null,
        violations: [],
        ...fields,
      })
    },
    nextReply: (replies) => {
      const index = claimReply(state)
      return { index, reply: replies[Math.min(index, replies.length - 1)] }
    },
    missingReply: (index) => {
      say(process.stderr, scenarioMessage(runtime, `no reply for call ${String(index)}`))
      finish(fakeCliExitCodes.scenario)
    },
  }
}

export const runEntry = async (runtime: Runtime, main: () => Promise<void>): Promise<void> => {
  try {
    await main()
  } catch (error) {
    if (!(error instanceof TemplateError)) {
      throw error
    }
    say(process.stderr, scenarioMessage(runtime, error.message))
    finish(fakeCliExitCodes.scenario)
  }
}
