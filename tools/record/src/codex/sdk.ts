import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hookRecords, hooksNamed } from '../hooks.js'
import type { RunOutput } from '../record.js'
import type { Scenario, ScenarioSession } from '../scenario.js'
import { checkSubagents, commandOutputs, question, rootReplies, shell, subagentFacts, subagentScript, toolSteps } from './calls.js'
import { hostScript, stubScenario } from './harness.js'
import { check, completedItems, containing, events, finished, items, jsonLines, records, responseItems, rolloutOf, sessionMeta, threadOf } from './rollout.js'

const surface = 'codex_sdk'

interface SdkTurn {
  readonly prompt: string
  readonly resume: boolean
}

const runSdk = async (session: ScenarioSession, turns: readonly SdkTurn[]): Promise<RunOutput> => {
  const module = session.engine.module
  if (module === undefined) throw new Error('The Codex SDK engine has no module path')
  const plan = join(session.work, 'codex-sdk-plan.json')
  await writeFile(plan, `${JSON.stringify({ module, cwd: session.project, turns })}\n`)
  return session.run(process.execPath, [hostScript('sdk-host'), plan], { env: { OTEL_BLRP_SCHEDULE_DELAY: '200' } })
}

const threadIds = (stdout: string): string[] =>
  jsonLines(stdout).flatMap((event) => event['type'] === 'thread.started' && typeof event['thread_id'] === 'string' ? [event['thread_id']] : [])

const checkSdkOrigin = (meta: Readonly<Record<string, unknown>>): void => {
  check(meta['originator'] === 'codex_sdk_ts' && meta['source'] === 'exec', `the SDK thread has originator codex_sdk_ts and source exec (${String(meta['originator'])})`)
}

const tools = stubScenario({
  name: 'tools',
  surface,
  trust: true,
  expectedFacts: [
    'A Codex SDK thread (runStreamed, bundled codex exec --experimental-json, originator codex_sdk_ts, source exec) runs `echo hi`, applies a patch adding result.json and runs `echo code` from a code-mode exec cell',
    'Hooks are trusted through app-server hooks/list and hooks.state trusted_hash in config.toml, without a bypass flag, and fire for Bash and apply_patch',
    'The SDK stream ends with turn.completed usage; every model response has a token_usage_record',
  ],
  script: { 'sdk-tools': toolSteps },
  run: async ({ session, stub }) => {
    const { stdout } = await runSdk(session, [{ prompt: '[aang:sdk-tools] Run `echo hi`, add result.json with a patch, run `echo code` from a code cell, then reply done.', resume: false }])
    const rollout = await rolloutOf(session.codex, threadOf(stdout))
    checkSdkOrigin(sessionMeta(rollout))
    check(commandOutputs(stdout).includes('hi') && commandOutputs(stdout).includes('code') && items(stdout, 'file_change').length === 1, 'the SDK stream shows both commands and the patch')
    check(jsonLines(stdout).some((event) => event['type'] === 'turn.completed'), 'the SDK stream completed the turn')
    check(records(rollout, 'token_usage_record').length === rootReplies(stub.replies), 'each model response has a token_usage_record')
    const hooks = await hookRecords(session.spool)
    check(hooksNamed(hooks, 'PostToolUse', { key: 'tool_name', value: 'Bash' }).length === 2 && hooksNamed(hooks, 'PostToolUse', { key: 'tool_name', value: 'apply_patch' }).length === 1, 'trusted hooks fired for the tools')
    const result: unknown = JSON.parse(await readFile(join(session.project, 'result.json'), 'utf8'))
    check(typeof result === 'object' && result !== null && 'status' in result && result.status === 'ok', 'result.json was written by apply_patch')
    await session.checkpoint('result-written', { root: 'home', path: 'project/result.json' }, 'result.json appears as the output file of the SDK stage')
    await session.checkpoint('turn-complete', finished(rollout), 'The SDK turn completes with three finished actions and its usage counted once per response')
  },
})

const subagent = stubScenario({
  name: 'subagents',
  surface,
  trust: true,
  expectedFacts: subagentFacts,
  script: (session) => subagentScript(session, 'sdk-subagent'),
  run: async ({ session, stub }) => {
    const root = threadOf((await runSdk(session, [{ prompt: '[aang:sdk-subagent] Spawn subagents scout and builder, wait for them, then reply done.', resume: false }])).stdout)
    const children = await checkSubagents(session, stub.replies, root)
    checkSdkOrigin(sessionMeta(await rolloutOf(session.codex, root)))
    check(children.every((child) => sessionMeta(child)['originator'] === 'codex_sdk_ts'), 'the children inherit originator codex_sdk_ts')
    const [first] = children
    if (first !== undefined) await session.checkpoint('child-finished', finished(first), 'A subagent stage finishes under the root SDK session and its result returns to the parent')
    await session.checkpoint('root-finished', finished(await rolloutOf(session.codex, root)), 'The root SDK turn completes after waiting for both subagents')
  },
})

const questionScenario = stubScenario({
  name: 'question',
  surface,
  trust: true,
  expectedFacts: [
    'The SDK turn asks the user through request_user_input_async; the rollout has item_completed AgentMessage with delivery "async" and one question with two options',
    'A reply arrives as a new user message through resumeThread(id).runStreamed',
  ],
  script: { 'sdk-question': [[question]] },
  run: async ({ session }) => {
    const { stdout } = await runSdk(session, [
      { prompt: '[aang:sdk-question] Ask me which greeting notes.txt should use, then stop.', resume: false },
      { prompt: 'hello', resume: true },
    ])
    const [thread, resumed] = threadIds(stdout)
    check(thread !== undefined && resumed === thread, 'resumeThread continued the same thread')
    const rollout = await rolloutOf(session.codex, thread ?? '')
    check(completedItems(rollout, 'AgentMessage').filter((item) => item['delivery'] === 'async' && Array.isArray(item['questions'])).length === 1, 'an async question was recorded')
    check(responseItems(rollout, 'message').some((item) => item['role'] === 'user' && JSON.stringify(item['content']).includes('"text":"hello"')), 'the reply is in the rollout')
    await session.checkpoint('question-asked', containing(rollout, '"delivery":"async"'), 'A non-blocking question to the user opens an attention item; it does not block the SDK turn, nothing waits in the runtime and the stage is not waiting')
    await session.checkpoint('question-reply', finished(rollout), 'A user prompt replies after the SDK question; the attention item may be marked likely answered as an interpretation, stays open until the user dismisses it, and the stage is not waiting')
  },
})

const resume = stubScenario({
  name: 'resume',
  surface,
  trust: true,
  expectedFacts: [
    'Codex SDK startThread runs a first turn, then codex.resumeThread(id).runStreamed runs a second turn in the same thread',
    'Both turns emit thread.started with the same id; the second turn appends to the same rollout, which gets a second task_started and SessionStart source resume',
  ],
  script: { 'sdk-first': [[shell('echo first')]], 'sdk-second': [[shell('echo second')]] },
  run: async ({ session }) => {
    const { stdout } = await runSdk(session, [
      { prompt: '[aang:sdk-first] Run `echo first`, then reply done.', resume: false },
      { prompt: '[aang:sdk-second] Run `echo second`, then reply done.', resume: true },
    ])
    const [thread, resumed] = threadIds(stdout)
    check(thread !== undefined && resumed === thread, 'resumeThread kept the thread id')
    const rollout = await rolloutOf(session.codex, thread ?? '')
    check(events(rollout, 'task_started').length === 2 && completedItems(rollout, 'CommandExecution').length === 2, 'both turns ran in the same rollout')
    check(hooksNamed(await hookRecords(session.spool), 'SessionStart', { key: 'source', value: 'resume' }).length === 1, 'SessionStart reported source resume')
    await session.checkpoint('first-turn', finished(rollout, 'first'), 'The first SDK turn completes')
    await session.checkpoint('resumed', finished(rollout), 'The resumed SDK session continues in place with a second completed turn')
  },
})

export const sdkScenarios: readonly Scenario[] = [tools, subagent, questionScenario, resume]
