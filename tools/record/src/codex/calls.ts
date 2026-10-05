import { stat } from 'node:fs/promises'
import { hookRecords, hooksNamed } from '../hooks.js'
import type { ScenarioSession } from '../scenario.js'
import { allRollouts, check, completedItems, events, items, records, type Rollout, sessionMeta } from './rollout.js'
import type { StubCall, StubReply, StubScript } from './stub.js'

export const shell = (cmd: string, extra: Readonly<Record<string, unknown>> = {}): StubCall => ({ type: 'function_call', name: 'exec_command', arguments: { cmd, ...extra } })

export const patch = (file: string, line: string): StubCall => ({
  type: 'custom_tool_call', name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${file}\n+${line}\n*** End Patch\n`,
})

const codeCell = (cmd: string): StubCall => ({
  type: 'custom_tool_call', name: 'exec', input: `const result = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} });\ntext(result.output);`,
})

const collaboration = (name: string, args: Readonly<Record<string, unknown>>): StubCall => ({ type: 'function_call', namespace: 'collaboration', name, arguments: args })

export const plan = (steps: readonly (readonly [string, string])[]): StubCall => ({
  type: 'function_call', name: 'update_plan', arguments: { plan: steps.map(([step, status]) => ({ step, status })) },
})

export const question: StubCall = {
  type: 'function_call', name: 'request_user_input_async', arguments: { questions: [{ title: 'Which greeting should notes.txt use?', options: ['hello', 'hi'] }] },
}

export const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

export const commandOutputs = (stdout: string): string[] =>
  items(stdout, 'command_execution').map((item) => typeof item['aggregated_output'] === 'string' ? item['aggregated_output'].trim() : '')

export const toolSteps: readonly (readonly StubCall[])[] = [[shell('echo hi')], [patch('result.json', '{"status": "ok"}')], [codeCell('echo code')]]

const childrenFinished = (session: ScenarioSession, count: number) => async (): Promise<boolean> =>
  (await allRollouts(session.codex)).filter((rollout) => typeof records(rollout, 'session_meta')[0]?.['parent_thread_id'] === 'string' && events(rollout, 'task_complete').length > 0).length >= count

export const subagentScript = (session: ScenarioSession, key: string): StubScript => ({
  [key]: [
    [collaboration('spawn_agent', { task_name: 'scout', message: '[aang:scout] Run `echo scout` and report.' }), collaboration('spawn_agent', { task_name: 'builder', message: '[aang:builder] Run `echo builder` and report.' })],
    { calls: [collaboration('wait_agent', { timeout_ms: 30_000 })], when: childrenFinished(session, 2) },
  ],
  scout: [[shell('echo scout')]],
  builder: [[shell('echo builder')]],
})

export const subagentFacts: readonly string[] = [
  'The root thread spawns two parallel subagents `scout` and `builder` in one step through collaboration.spawn_agent, then one wait_agent returns after both finished',
  'Each child writes its own rollout with parent_thread_id of the root, agent_path /root/<task_name> and source.subagent.thread_spawn; with the default fork_turns the child rollout repeats the parent session_meta as its second line',
  'Each child runs exec_command; SubagentStart and SubagentStop hooks carry the child thread id as agent_id',
]

export const checkSubagents = async (session: ScenarioSession, replies: readonly StubReply[], root: string): Promise<Rollout[]> => {
  const children = (await allRollouts(session.codex)).filter((rollout) => sessionMeta(rollout)['parent_thread_id'] === root)
  const paths = children.map((child) => sessionMeta(child)['agent_path']).sort()
  check(JSON.stringify(paths) === JSON.stringify(['/root/builder', '/root/scout']), `two children of ${root} were written (${JSON.stringify(paths)})`)
  check(replies.some((reply) => reply.agent === '/root/scout' && reply.subagent === 'collab_spawn'), 'the scout request carries x-openai-subagent: collab_spawn')
  check(children.every((child) => completedItems(child, 'CommandExecution').length === 1), 'each child ran its command')
  check(hooksNamed(await hookRecords(session.spool), 'SubagentStop').length === 2, 'SubagentStop fired for both children')
  return children
}

export const rootReplies = (replies: readonly StubReply[]): number => replies.filter((reply) => reply.agent === '/root').length
