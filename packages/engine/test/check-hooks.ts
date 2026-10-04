import { CheckContract } from '@aang/contract'
import type { HookDelivery } from './batches.ts'
import { claudeHook } from './samples.ts'

export interface Source {
  readonly session: string
  readonly cwd: string
}

export const reporting = 'verified commit ([0-9a-f]+)'

export const verifyCommand =
  'git worktree add --detach ../verify HEAD && cd ../verify && pnpm test && echo "verified commit $(git rev-parse HEAD)"'

export const testContract = (masks: readonly string[], commitPattern: string | null = reporting): CheckContract =>
  CheckContract.parse({ name: 'test', command: 'pnpm test', inputMasks: masks, commitPattern })

export const passed = (commit: string): string => `Tests passed\nverified commit ${commit}\n`

export const started = (source: Source): HookDelivery => ({
  file: `${source.session}-start.evt`,
  payload: claudeHook('SessionStart.startup.json', source),
})

const bash = (call: string, command: string) => ({ tool_use_id: call, tool_input: { command, description: 'Run the check' } })

export const preTool = (source: Source, call: string, arrival: number, command = verifyCommand): HookDelivery => ({
  file: `${call}-pre.evt`,
  payload: claudeHook('PreToolUse.Bash.json', source, bash(call, command)),
  arrival,
})

export const postTool = (
  source: Source,
  call: string,
  stdout: string,
  arrival: number,
  command = verifyCommand,
): HookDelivery => ({
  file: `${call}-post.evt`,
  payload: claudeHook('PostToolUse.Bash.json', source, {
    ...bash(call, command),
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  }),
  arrival,
})

export const failedTool = (source: Source, call: string, arrival: number): HookDelivery => ({
  file: `${call}-post.evt`,
  payload: claudeHook('PostToolUseFailure.Bash.json', source, {
    ...bash(call, verifyCommand),
    error: 'Exit code 1\nchecks failed',
    is_interrupt: false,
  }),
  arrival,
})

export const stopped = (source: Source, turn: number, arrival: number): HookDelivery => ({
  file: `${source.session}-stop-${String(turn)}.evt`,
  payload: claudeHook('Stop.json', source, { last_assistant_message: `Turn ${String(turn)} done` }),
  arrival,
})

export const verifiedCheck = (source: Source, commit: string): readonly HookDelivery[] => [
  started(source),
  preTool(source, 'call-verify', 10),
  postTool(source, 'call-verify', passed(commit), 11),
]
