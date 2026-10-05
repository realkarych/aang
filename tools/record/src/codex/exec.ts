import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hookRecords, hooksNamed } from '../hooks.js'
import type { Scenario, ScenarioSession } from '../scenario.js'
import { checkSubagents, commandOutputs, exists, plan, question, rootReplies, shell, subagentFacts, subagentScript, toolSteps } from './calls.js'
import { codexCommand, codexExec, stubScenario } from './harness.js'
import { check, completedItems, containing, events, finished, items, jsonLines, records, responseItems, rolloutOf, sessionMeta, threadOf } from './rollout.js'

const surface = 'codex_exec'

const tools = stubScenario({
  name: 'tools',
  surface,
  expectedFacts: [
    'One codex exec turn runs exec_command `echo hi`, applies a patch that adds result.json, and runs `echo code` from a code-mode exec cell',
    'Every model response has a token_usage_record and turn.completed reports cumulative usage',
    'PreToolUse/PostToolUse hooks fire for Bash and apply_patch with tool_use_id equal to the rollout call_id',
  ],
  script: { tools: toolSteps },
  run: async ({ session, stub }) => {
    const { stdout } = await codexExec(session, ['[aang:tools] Run `echo hi`, add result.json with a patch, run `echo code` from a code cell, then reply done.'])
    const rollout = await rolloutOf(session.codex, threadOf(stdout))
    check(commandOutputs(stdout).includes('hi') && commandOutputs(stdout).includes('code'), 'both shell commands completed')
    check(items(stdout, 'file_change').length === 1, 'the patch completed as a file change')
    const result: unknown = JSON.parse(await readFile(join(session.project, 'result.json'), 'utf8'))
    check(typeof result === 'object' && result !== null && 'status' in result && result.status === 'ok', 'result.json was written by apply_patch')
    check(records(rollout, 'token_usage_record').length === rootReplies(stub.replies), 'each model response has a token_usage_record')
    check(jsonLines(stdout).some((event) => event['type'] === 'turn.completed' && typeof event['usage'] === 'object'), 'turn.completed carries usage')
    const hooks = await hookRecords(session.spool)
    check(hooksNamed(hooks, 'PostToolUse', { key: 'tool_name', value: 'Bash' }).length === 2, 'two Bash PostToolUse hooks were spooled')
    check(hooksNamed(hooks, 'PostToolUse', { key: 'tool_name', value: 'apply_patch' }).length === 1, 'an apply_patch PostToolUse hook was spooled')
    await session.checkpoint('result-written', { root: 'home', path: 'project/result.json' }, 'result.json appears as the output file of the running stage')
    await session.checkpoint('turn-complete', finished(rollout), 'The turn completes with three finished actions and its usage counted once per response')
  },
})

const subagent = stubScenario({
  name: 'subagents',
  surface,
  expectedFacts: subagentFacts,
  script: (session) => subagentScript(session, 'subagent'),
  run: async ({ session, stub }) => {
    const root = threadOf((await codexExec(session, ['[aang:subagent] Spawn subagents scout and builder, wait for them, then reply done.'])).stdout)
    const [first] = await checkSubagents(session, stub.replies, root)
    if (first !== undefined) await session.checkpoint('child-finished', finished(first), 'A subagent stage finishes under the root session and its result returns to the parent')
    await session.checkpoint('root-finished', finished(await rolloutOf(session.codex, root)), 'The root turn completes after waiting for both subagents')
  },
})

const fork = stubScenario({
  name: 'fork',
  surface,
  expectedFacts: [
    'codex exec fork <id> creates a new thread whose session_meta.forked_from_id is the source thread id',
    'The fork continues the ordinal sequence of the source without copying its history',
    'SessionStart in the fork has source "fork"',
  ],
  script: { 'fork-source': [[shell('echo source')]], fork: [[shell('echo fork')]] },
  run: async ({ session }) => {
    const source = threadOf((await codexExec(session, ['[aang:fork-source] Run `echo source`, then reply done.'])).stdout)
    await session.checkpoint('source-complete', finished(await rolloutOf(session.codex, source)), 'The source session completes its first turn')
    const forked = threadOf((await codexExec(session, ['fork', source, '[aang:fork] Run `echo fork` in the fork, then reply done.'])).stdout)
    check(forked !== source, 'the fork has its own thread id')
    const rollout = await rolloutOf(session.codex, forked)
    const meta = sessionMeta(rollout)
    check(meta['forked_from_id'] === source, 'session_meta.forked_from_id names the source thread')
    check(typeof meta['forked_from_ordinal_exclusive'] === 'number' && rollout.lines[0]?.['ordinal'] === meta['forked_from_ordinal_exclusive'], 'the fork continues the source ordinals without copying its history')
    check(completedItems(rollout, 'CommandExecution').length === 1, 'the fork ran its command')
    check(hooksNamed(await hookRecords(session.spool), 'SessionStart', { key: 'source', value: 'fork' }).length === 1, 'SessionStart reported source fork')
    await session.checkpoint('fork-complete', finished(rollout), 'A forked session appears linked to its source and completes its own turn')
  },
})

const questionScenario = stubScenario({
  name: 'question',
  surface,
  expectedFacts: [
    'The model asks the user through request_user_input_async; the rollout has item_completed AgentMessage with delivery "async" and one question with two options',
    'The turn ends without waiting; a reply arrives later as a new user message through codex exec resume',
  ],
  script: { question: [[question]] },
  run: async ({ session }) => {
    const thread = threadOf((await codexExec(session, ['[aang:question] Ask me which greeting notes.txt should use, then stop.'])).stdout)
    const asked = await rolloutOf(session.codex, thread)
    const questions = completedItems(asked, 'AgentMessage').filter((item) => item['delivery'] === 'async' && Array.isArray(item['questions']))
    check(questions.length === 1, 'an async question was recorded')
    await session.checkpoint('question-asked', containing(asked, '"delivery":"async"'), 'A non-blocking question to the user opens an attention item; it does not block the turn, nothing waits in the runtime and the stage is not waiting')
    await codexExec(session, ['resume', thread, 'hello'])
    const replied = await rolloutOf(session.codex, thread)
    check(events(replied, 'task_started').length === 2, 'the reply started a second turn in the same rollout')
    check(responseItems(replied, 'message').some((item) => item['role'] === 'user' && JSON.stringify(item['content']).includes('"text":"hello"')), 'the reply is in the rollout')
    await session.checkpoint('question-reply', finished(replied), 'A user prompt replies after the question; the attention item may be marked likely answered as an interpretation, stays open until the user dismisses it, and the stage is not waiting')
  },
})

const planScenario = stubScenario({
  name: 'plan',
  surface,
  expectedFacts: [
    'With tools.update_plan.enabled the model publishes a two-step plan, runs one command, then marks both steps completed',
    'codex exec --json shows the plan as a todo_list item; the rollout has two update_plan function calls',
  ],
  script: {
    plan: [
      [plan([['Inspect the project', 'in_progress'], ['Write the summary', 'pending']])],
      [shell('echo inspect')],
      [plan([['Inspect the project', 'completed'], ['Write the summary', 'completed']])],
    ],
  },
  run: async ({ session }) => {
    const { stdout } = await codexExec(session, ['-c', 'tools.update_plan.enabled=true', '[aang:plan] Make a two-step plan, inspect the project with `echo inspect`, complete the plan, then reply done.'])
    const rollout = await rolloutOf(session.codex, threadOf(stdout))
    check(items(stdout, 'todo_list').length > 0, 'the plan is visible as a todo_list item')
    const [published, completed] = responseItems(rollout, 'function_call').filter((item) => item['name'] === 'update_plan').map((item) => String(item['call_id']))
    check(published !== undefined && completed !== undefined, 'two plan updates are in the rollout')
    await session.checkpoint('plan-published', { hook: { event: 'PostToolUse', toolUseId: published ?? '' } }, 'The stage shows a two-step plan with the first step in progress')
    await session.checkpoint('plan-complete', { hook: { event: 'PostToolUse', toolUseId: completed ?? '' } }, 'The plan of the stage shows both steps completed')
  },
})

const sourceLoss = stubScenario({
  name: 'source-loss',
  surface,
  expectedFacts: [
    'codex archive moves the first rollout from sessions/YYYY/MM/DD into the flat archived_sessions directory (remove + write)',
    'codex delete --force removes the second rollout (remove step)',
  ],
  script: { archive: [[shell('echo archive')]], delete: [[shell('echo delete')]] },
  run: async ({ session }) => {
    const archived = threadOf((await codexExec(session, ['[aang:archive] Run `echo archive`, then reply done.'])).stdout)
    await codexCommand(session, ['archive', archived])
    const moved = await rolloutOf(session.codex, archived)
    check(moved.target.path.startsWith('archived_sessions/'), 'the archived rollout moved into archived_sessions')
    await session.checkpoint('archived', moved.target, 'The session source moves to archived_sessions; the session stays visible as archived')
    const deleted = threadOf((await codexExec(session, ['[aang:delete] Run `echo delete`, then reply done.'])).stdout)
    const original = await rolloutOf(session.codex, deleted)
    await codexCommand(session, ['delete', '--force', deleted])
    check(!await exists(original.path), 'the deleted rollout is gone')
    await session.checkpoint('deleted', original.target, 'The session source is deleted; the session keeps its last state and is marked as source lost')
  },
})

const reconnect = stubScenario({
  name: 'reconnect',
  surface,
  expectedFacts: [
    'Two turns of one thread: codex exec, then codex exec resume <id> appending to the same rollout',
    'The second turn runs `sleep 3`; the checkpoint between the turns is the daemon restart point',
  ],
  script: { 'reconnect-first': [[shell('echo first')]], 'reconnect-second': [[shell('sleep 3')]] },
  run: async ({ session }) => {
    const thread = threadOf((await codexExec(session, ['[aang:reconnect-first] Run `echo first`, then reply done.'])).stdout)
    const first = await rolloutOf(session.codex, thread)
    await session.checkpoint('daemon-restart', finished(first), 'The aang daemon restarts here; after the restart it continues reading this rollout from its saved cursor')
    await codexExec(session, ['resume', thread, '[aang:reconnect-second] Run `sleep 3`, then reply done.'])
    const second = await rolloutOf(session.codex, thread)
    check(second.path === first.path && events(second, 'task_started').length === 2, 'the resumed turn appended to the same rollout')
    await session.checkpoint('second-turn', finished(second), 'The second turn appended after the restart appears once, without duplicated facts')
  },
})

const compactAt = (limit: number): string[] => ['-c', 'model_auto_compact_token_limit_scope="total"', '-c', `model_auto_compact_token_limit=${String(limit)}`]

const compaction = stubScenario({
  name: 'compaction',
  surface,
  expectedFacts: [
    'codex exec resume with model_auto_compact_token_limit below the stub usage compacts locally before the resumed turn',
    'The rollout gets a compacted record with a plain-text summary and item_completed ContextCompaction; PreCompact and PostCompact (trigger auto) hooks fire',
    'The compaction hooks fire before SessionStart with source resume and then source compact',
  ],
  script: { 'compaction-first': [[shell('echo before')]] },
  run: async ({ session }) => {
    const thread = threadOf((await codexExec(session, ['[aang:compaction-first] Run `echo before`, then reply done.'])).stdout)
    await session.checkpoint('before-compaction', finished(await rolloutOf(session.codex, thread)), 'The first turn completes with its full history')
    await codexExec(session, [...compactAt(100), 'resume', thread, '[aang:compaction-second] Reply with just: OK2'])
    const rollout = await rolloutOf(session.codex, thread)
    check(records(rollout, 'compacted').length === 1 && completedItems(rollout, 'ContextCompaction').length === 1, 'the thread was compacted once')
    const hooks = await hookRecords(session.spool)
    check(hooksNamed(hooks, 'PreCompact').length === 1 && hooksNamed(hooks, 'PostCompact', { key: 'trigger', value: 'auto' }).length === 1, 'compaction hooks fired')
    await session.checkpoint('compacted', { hook: { event: 'PostCompact' } }, 'The session is compacted in place; earlier history is replaced by the summary and the compaction call is counted once')
    await session.checkpoint('resumed', finished(rollout), 'The resumed turn after the compaction completes in the same session')
  },
})

const liveFlags: readonly string[] = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--disable', 'hooks']

const resumeCompaction: Scenario = {
  name: 'resume-compaction',
  surface,
  models: ['live'],
  codexHome: 'regular',
  expectedFacts: [
    'A real-model codex exec turn in the regular CODEX_HOME without hooks runs `echo hi` and replies OK',
    'codex exec resume <id> with model_auto_compact_token_limit 10000 (scope total) runs a remote compaction before the resumed turn: compacted with an empty message and an encrypted compaction item, then item_completed ContextCompaction',
    'The resumed turn and the compaction are appended to the same rollout; the thread id is unchanged',
    'token_usage_record and thread_token_usage include the compaction call; turn.completed usage and token_count totals do not',
  ],
  run: async (session: ScenarioSession) => {
    const first = await session.run(session.engine.executable, ['exec', ...liveFlags, '[aang:live] Run the shell command `echo hi` exactly once, then reply with just: OK'])
    const thread = threadOf(first.stdout)
    const started = await rolloutOf(session.codex, thread)
    check(sessionMeta(started)['cwd'] === session.project, `the rollout of ${thread} belongs to the temporary project`)
    check(commandOutputs(first.stdout).includes('hi') && events(started, 'task_complete').length === 1, `the first turn of ${thread} ran echo hi and completed`)
    await session.checkpoint('first-turn', finished(started), 'The first turn of a real session completes and its usage is counted')
    const resumed = await session.run(session.engine.executable, ['exec', ...liveFlags, ...compactAt(10_000), 'resume', thread, 'Reply with just: OK2'])
    check(threadOf(resumed.stdout) === thread, `resume kept the thread id ${thread}`)
    const compacted = await rolloutOf(session.codex, thread)
    check(compacted.path === started.path, `resume appended to the rollout of ${thread}`)
    check(records(compacted, 'compacted').length >= 1, `thread ${thread} was compacted`)
    check(events(compacted, 'task_started').length >= 2, `the resumed turn of ${thread} started in the same rollout`)
    await session.checkpoint('compacted', containing(compacted, '"type":"compacted"'), 'The session is compacted in place; usage includes the compaction call once')
    await session.checkpoint('resumed', finished(compacted), 'The resumed turn after the compaction completes in the same session')
  },
}

export const execScenarios: readonly Scenario[] = [tools, subagent, fork, questionScenario, planScenario, compaction, sourceLoss, reconnect, resumeCompaction]
