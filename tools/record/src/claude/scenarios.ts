import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { z } from 'zod'
import type { Scenario, ScenarioSession } from '../scenario.js'
import type { HostSummary } from './plan.js'
import { planFilePlaceholder, type StubBlock, type StubScript } from './stub.js'
import { type ClaudeRun, type ClaudeSurface, withClaude } from './surfaces.js'
import {
  commandOf, findTranscript, named, subagentTranscripts, toolResult, toolUses, type ToolUse, type Transcript, transcriptFiles, userTexts,
} from './transcripts.js'

interface Definition {
  readonly name: string
  readonly expectedFacts: readonly string[]
  readonly script: (session: ScenarioSession) => StubScript
  readonly run: (run: ClaudeRun) => Promise<void>
}

const check = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

const present = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message)
  return value
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

const sessionOf = (summary: HostSummary): string => present(summary.results.at(-1)?.sessionId, 'The host saw no result')

const bash = (command: string, description: string): StubBlock => ({ tool: 'Bash', input: { command, description } })

const echo = (key: string, word: string): { readonly prompt: string; readonly script: StubScript } => ({
  prompt: `[aang:${key}] Run \`echo ${word}\` with the Bash tool and reply with its output.`,
  script: { [key]: [[bash(`echo ${word}`, `Print ${word}`)], [{ text: word }]] },
})

const echoUse = (transcript: Transcript, word: string): ToolUse => present(
  named(toolUses(transcript), 'Bash').find((use) => commandOf(use).includes(`echo ${word}`)),
  `${transcript.target.path} has no Bash action running echo ${word}`,
)

const entryIndex = (transcript: Transcript, toolUseId: string): number => transcript.entries.findIndex((entry) =>
  Array.isArray(entry.message?.content) && entry.message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === toolUseId))

const playerPath = (session: ScenarioSession, file: string): { readonly root: 'claude'; readonly path: string } =>
  ({ root: 'claude', path: relative(session.claude, file).replaceAll('\\', '/') })

const Task = z.looseObject({ id: z.string(), subject: z.string(), status: z.string() })
const TaskUpdate = z.looseObject({ taskId: z.string(), status: z.string().optional() })

const taskFiles = async (session: ScenarioSession, sessionId: string): Promise<{ readonly file: string; readonly task: z.infer<typeof Task> }[]> => {
  const directory = join(session.claude, 'tasks', sessionId)
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.json'))
  return Promise.all(names.map(async (name) => ({ file: join(directory, name), task: Task.parse(JSON.parse(await readFile(join(directory, name), 'utf8'))) })))
}

const tools: Definition = {
  name: 'tools',
  expectedFacts: [
    'One turn of the root session runs Read, Bash, Write and Edit tool actions in order',
    'Write and Edit are approved through the host permission prompt after ~0.5 s each',
    'Every assistant message of the turn carries usage',
  ],
  script: (session) => ({
    tools: [
      [{ tool: 'Read', input: { file_path: join(session.project, 'notes.txt') } }],
      [bash('ls', 'List project files')],
      [{ tool: 'Write', input: { file_path: join(session.project, 'result.txt'), content: 'draft\n' } }],
      [{ tool: 'Edit', input: { file_path: join(session.project, 'result.txt'), old_string: 'draft', new_string: 'final', replace_all: false } }],
      [{ text: 'Read the notes, listed the project and wrote result.txt.' }],
    ],
  }),
  run: async ({ session, stage }) => {
    await writeFile(join(session.project, 'notes.txt'), 'Reference notes for the aang recording.\n')
    const summary = await stage('tools', {
      turns: [{ prompt: '[aang:tools] Read notes.txt with the Read tool, run `ls` with the Bash tool, create result.txt containing the single word draft with the Write tool, then replace draft with final in result.txt using the Edit tool. Reply with one short sentence.' }],
      decisions: [{ tool: 'Write', behavior: 'allow', delayMs: 500 }, { tool: 'Edit', behavior: 'allow', delayMs: 500 }],
    })
    const sessionId = sessionOf(summary)
    const transcript = await findTranscript(session, sessionId)
    const uses = toolUses(transcript)
    const order = ['Read', 'Bash', 'Write', 'Edit'].map((name) => uses.findIndex((use) => use.name === name))
    check(order.every((index, position) => index >= 0 && index > (order[position - 1] ?? -1)), `The session did not run Read, Bash, Write and Edit in order: ${uses.map(({ name }) => name).join(', ')}`)
    check(transcript.entries.filter((entry) => entry.type === 'assistant').every((entry) => entry.message?.usage !== undefined), 'An assistant message has no usage')
    check((await readFile(join(session.project, 'result.txt'), 'utf8')).trim() === 'final', 'result.txt was not edited to final')
    const edit = present(named(uses, 'Edit').at(-1), 'No Edit action')
    await session.checkpoint('edit-finished', { hook: { event: 'PostToolUse', toolUseId: edit.id } },
      'The Edit action on result.txt is finished; Read, Bash, Write and Edit are listed as completed actions of the root session')
    await session.checkpoint('turn-finished', { hook: { event: 'Stop', sessionId } },
      'The turn ends: the root session becomes idle and shows token usage for the turn')
  },
}

const subagentPrompt = (key: string, command: string): string => `[aang:${key}] Run \`${command}\` with the Bash tool and report its output.`
const agent = (key: string, command: string, description: string, background: boolean): StubBlock =>
  ({ tool: 'Agent', input: { description, prompt: subagentPrompt(key, command), subagent_type: 'general-purpose', run_in_background: background } })
const child = (command: string, description: string, report: string): (readonly StubBlock[])[] => [[bash(command, description)], [{ text: report }]]
const backgroundOf = (use: ToolUse): unknown => (use.input as Readonly<Record<string, unknown>> | undefined)?.['run_in_background']

const subagents: Definition = {
  name: 'subagents',
  expectedFacts: [
    'A foreground subagent runs a Bash action and reports back to the root session',
    'Two foreground subagents start from one assistant message and run in parallel, each with its own Bash action',
    'A background subagent finishes after the root turn ended and its notification starts a follow-up turn',
    'Every subagent has its own transcript under the root session',
  ],
  script: () => ({
    subagents: [
      [agent('sub-solo', 'echo solo', 'Echo solo', false)],
      [agent('sub-left', 'echo left', 'Echo left', false), agent('sub-right', 'echo right', 'Echo right', false)],
      [agent('sub-back', 'sleep 2 && echo back', 'Echo back later', true)],
      [{ text: 'The foreground subagents finished and the background subagent is running.' }],
    ],
    'sub-solo': child('echo solo', 'Print solo', 'solo'),
    'sub-left': child('echo left', 'Print left', 'left'),
    'sub-right': child('echo right', 'Print right', 'right'),
    'sub-back': child('sleep 2 && echo back', 'Print back after a pause', 'back'),
  }),
  run: async ({ session, stage }) => {
    const summary = await stage('subagents', {
      turns: [{
        prompt: [
          '[aang:subagents] Use the Agent tool with the general-purpose subagent type for each step.',
          `First start one foreground subagent (run_in_background false) with the prompt "${subagentPrompt('sub-solo', 'echo solo')}" and wait for it.`,
          `Then, in a single message, start two foreground subagents in parallel with the prompts "${subagentPrompt('sub-left', 'echo left')}" and "${subagentPrompt('sub-right', 'echo right')}".`,
          `Finally start one background subagent (run_in_background true) with the prompt "${subagentPrompt('sub-back', 'sleep 2 && echo back')}" and reply with one sentence without waiting for it.`,
        ].join(' '),
      }],
    })
    const sessionId = sessionOf(summary)
    const transcript = await findTranscript(session, sessionId)
    const agents = toolUses(transcript).filter(({ name }) => name === 'Agent' || name === 'Task')
    const foreground = agents.filter((use) => backgroundOf(use) === false)
    const background = agents.filter((use) => backgroundOf(use) !== false)
    check(foreground.length >= 3 && background.length >= 1, `Expected three foreground and one background subagent, got ${String(foreground.length)} and ${String(background.length)}`)
    const parallel = present(Object.values(Object.groupBy(foreground, (use) => use.messageId ?? use.id)).find((group) => (group?.length ?? 0) >= 2),
      'No assistant message started two foreground subagents')
    const children = await subagentTranscripts(session.claude, transcript)
    for (const word of ['solo', 'left', 'right', 'back']) {
      check(children.some((transcriptOfChild) => named(toolUses(transcriptOfChild), 'Bash').some((use) => commandOf(use).includes(`echo ${word}`))),
        `No subagent transcript runs echo ${word}`)
    }
    check(summary.results.length >= 2, 'The background subagent did not notify the root session after the turn')
    const solo = present(foreground[0], 'No foreground subagent')
    const lastParallel = present(parallel.toSorted((left, right) => entryIndex(transcript, left.id) - entryIndex(transcript, right.id)).at(-1), 'No parallel subagent')
    await session.checkpoint('solo-finished', { hook: { event: 'PostToolUse', toolUseId: solo.id } },
      'The foreground subagent finishes: its Agent action completes with the subagent report and the child agent is closed')
    await session.checkpoint('parallel-finished', { hook: { event: 'PostToolUse', toolUseId: lastParallel.id } },
      'Both parallel subagents are finished; the root session shows two completed child agents started by one message')
    await session.checkpoint('background-finished', { hook: { event: 'SubagentStop' } },
      'The background subagent finishes after the root turn ended; the root session is notified and runs a short follow-up turn')
  },
}

const resumeFirst = echo('resume-first', 'first')
const resumeSecond = echo('resume-second', 'second')

const resume: Definition = {
  name: 'resume',
  expectedFacts: [
    'The first run creates session S and exits',
    'A second run resumes S, keeps its session id and appends to the same transcript',
  ],
  script: () => ({ ...resumeFirst.script, ...resumeSecond.script }),
  run: async ({ session, stage }) => {
    const sessionId = sessionOf(await stage('first', { turns: [{ prompt: resumeFirst.prompt }] }))
    const before = await findTranscript(session, sessionId)
    echoUse(before, 'first')
    await session.checkpoint('first-run-idle', before.target, 'Session S is idle after its first run and its process has exited')
    const resumed = sessionOf(await stage('resumed', { turns: [{ prompt: resumeSecond.prompt }], resume: sessionId }))
    check(resumed === sessionId, `The resumed run reported session ${resumed} instead of ${sessionId}`)
    const after = await findTranscript(session, sessionId)
    echoUse(after, 'first')
    const action = echoUse(after, 'second')
    check((await transcriptFiles(session)).length === 1, 'Resume created another root transcript')
    await session.checkpoint('resumed-action', { hook: { event: 'PostToolUse', toolUseId: action.id } },
      'The resumed run appends a new action to session S; no second root session appears')
  },
}

const compactWork = echo('compact-work', 'history')
const compactAfter = echo('compact-after', 'after')

const compaction: Definition = {
  name: 'compaction',
  expectedFacts: [
    'After one turn with a Bash action the user runs /compact',
    'The transcript gets a manual compact_boundary followed by a compact summary',
    'The same session continues after compaction with another Bash action',
  ],
  script: () => ({ ...compactWork.script, ...compactAfter.script }),
  run: async ({ session, stage }) => {
    const summary = await stage('compaction', { turns: [{ prompt: compactWork.prompt }, { prompt: '/compact' }, { prompt: compactAfter.prompt }] })
    const sessionId = sessionOf(summary)
    check(summary.results.every((result) => result.sessionId === sessionId), 'Compaction changed the session id')
    const transcript = await findTranscript(session, sessionId)
    const boundary = transcript.entries.findIndex((entry) => entry.type === 'system' && entry.subtype === 'compact_boundary')
    check(boundary >= 0, 'The transcript has no compact_boundary')
    check(transcript.entries[boundary]?.compactMetadata?.trigger === 'manual', 'The compaction was not manual')
    check(transcript.entries.slice(boundary).some((entry) => entry.isCompactSummary === true), 'The transcript has no compact summary')
    check(entryIndex(transcript, echoUse(transcript, 'history').id) < boundary, 'The first action is not before the boundary')
    const after = echoUse(transcript, 'after')
    check(entryIndex(transcript, after.id) > boundary, 'The action after compaction is not after the boundary')
    await session.checkpoint('compacted', { hook: { event: 'PostCompact', sessionId } },
      'Session S shows a manual compaction: the earlier history is summarized and context usage drops; no subagent appears for the compaction')
    await session.checkpoint('after-compaction', { hook: { event: 'PostToolUse', toolUseId: after.id } },
      'Session S continues after compaction with a new action; no new session appears')
  },
}

const forkBase = echo('fork-base', 'base')
const forkBranch = echo('fork-branch', 'branch')

const fork: Definition = {
  name: 'fork',
  expectedFacts: [
    'The first run creates session S',
    'A resumed run with fork creates session F with a copy of the history of S',
    'F runs its own Bash action while the transcript of S stays unchanged',
  ],
  script: () => ({ ...forkBase.script, ...forkBranch.script }),
  run: async ({ session, stage }) => {
    const parent = sessionOf(await stage('base', { turns: [{ prompt: forkBase.prompt }] }))
    const original = await findTranscript(session, parent)
    echoUse(original, 'base')
    await session.checkpoint('base-idle', original.target, 'Session S is idle after its first run')
    const forked = sessionOf(await stage('fork', { turns: [{ prompt: forkBranch.prompt }], resume: parent, fork: true }))
    check(forked !== parent, 'The fork kept the parent session id')
    const copy = await findTranscript(session, forked)
    echoUse(copy, 'base')
    const action = echoUse(copy, 'branch')
    const unchanged = await findTranscript(session, parent)
    check(unchanged.entries.length === original.entries.length && !userTexts(unchanged).some((text) => text.includes('[aang:fork-branch]')),
      'The fork changed the parent transcript')
    await session.checkpoint('fork-started', { hook: { event: 'SessionStart', sessionId: forked } },
      'A new session F appears with a copy of the history of S; S stays idle')
    await session.checkpoint('fork-action', { hook: { event: 'PostToolUse', toolUseId: action.id } },
      'F runs its own action; the parent session S does not change')
  },
}

const plan: Definition = {
  name: 'plan',
  expectedFacts: [
    'The session starts in plan mode and records two tasks with TaskCreate',
    'The plan is written to the plan file and ExitPlanMode is approved through the host after ~1.5 s',
    'After approval the session writes checklist.txt with an approved Write and completes both tasks with TaskUpdate',
    'Each task is a JSON file of the session task list whose status changes from pending to completed',
  ],
  script: (session) => ({
    plan: [
      [{ tool: 'TaskCreate', input: { subject: 'Write checklist', description: 'Create checklist.txt with both steps', activeForm: 'Writing checklist' } }],
      [{ tool: 'TaskCreate', input: { subject: 'Review checklist', description: 'Check that checklist.txt lists both steps', activeForm: 'Reviewing checklist' } }],
      [{ tool: 'Write', input: { file_path: planFilePlaceholder, content: '# Checklist plan\n\n1. Write checklist.txt with both steps.\n2. Review checklist.txt.\n' } }],
      [{ tool: 'ExitPlanMode', input: {} }],
      [{ tool: 'Write', input: { file_path: join(session.project, 'checklist.txt'), content: '- Write checklist\n- Review checklist\n' } }],
      [{ tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }],
      [{ tool: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }],
      [{ text: 'checklist.txt is written and both tasks are completed.' }],
    ],
  }),
  run: async ({ session, stage }) => {
    const summary = await stage('plan', {
      permissionMode: 'plan',
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
      turns: [{ prompt: '[aang:plan] Plan the creation of checklist.txt. While planning, record two tasks with the TaskCreate tool, one call each: "Write checklist" and "Review checklist". Write the plan to the plan file and present it with ExitPlanMode. After approval, create checklist.txt listing both steps with the Write tool, then mark both tasks completed with TaskUpdate.' }],
      decisions: [{ tool: 'ExitPlanMode', behavior: 'allow', delayMs: 1500 }, { tool: 'Write', behavior: 'allow', delayMs: 500 }],
    })
    check(summary.tools.includes('TaskCreate') && summary.tools.includes('ExitPlanMode'), 'The engine offered no TaskCreate or ExitPlanMode tool')
    const sessionId = sessionOf(summary)
    const transcript = await findTranscript(session, sessionId)
    const uses = toolUses(transcript)
    check(named(uses, 'TaskCreate').length >= 2, 'The plan has fewer than two tasks')
    const exit = present(named(uses, 'ExitPlanMode').at(-1), 'The session never called ExitPlanMode')
    check(toolResult(transcript, exit.id)?.isError === false, 'ExitPlanMode was not approved')
    check(named(uses, 'TaskUpdate').length >= 2, 'Fewer than two tasks were completed')
    check(await exists(join(session.project, 'checklist.txt')), 'checklist.txt was not written')
    const tasks = (await taskFiles(session, sessionId)).toSorted((left, right) => Number(left.task.id) - Number(right.task.id))
    check(tasks.length >= 2 && tasks.every(({ task }) => task.status === 'completed'), `The task list files are not two completed tasks: ${tasks.map(({ task }) => `${task.id}:${task.status}`).join(', ')}`)
    const lastCreated = present(tasks.at(-1), 'No task file')
    const completedId = named(uses, 'TaskUpdate').map(({ input }) => TaskUpdate.safeParse(input).data)
      .findLast((update) => update?.status === 'completed')?.taskId
    const lastCompleted = present(tasks.find(({ task }) => task.id === completedId), 'No task was completed by TaskUpdate')
    await session.checkpoint('tasks-listed', { ...playerPath(session, lastCreated.file), occurrence: 'first' },
      'The session is in plan mode and its task list shows two pending tasks')
    await session.checkpoint('plan-approved', { hook: { event: 'PostToolUse', toolUseId: exit.id } },
      'The plan is approved after ~1.5 s: the session leaves plan mode with two pending tasks')
    await session.checkpoint('tasks-completed', { ...playerPath(session, lastCompleted.file), contains: '"completed"', occurrence: 'first' },
      'Both tasks of the task list are completed')
  },
}

const approvedCommand = 'node -e "require(\'fs\').writeFileSync(\'approved.txt\', \'approved\')"'
const deniedCommand = 'node -e "require(\'fs\').writeFileSync(\'denied.txt\', \'denied\')"'

const approval: Definition = {
  name: 'approval',
  expectedFacts: [
    'A Bash command asks for permission and is approved through the host after ~2 s, then runs',
    'A second Bash command asks for permission and is denied after ~1 s; it does not run and its result is an error',
  ],
  script: () => ({
    approval: [
      [bash(approvedCommand, 'Write approved.txt')],
      [bash(deniedCommand, 'Write denied.txt')],
      [{ text: 'The first command ran; the second one was denied.' }],
    ],
  }),
  run: async ({ session, stage }) => {
    const summary = await stage('approval', {
      turns: [{ prompt: `[aang:approval] Run \`${approvedCommand}\` with the Bash tool. After it finishes, run \`${deniedCommand}\` with the Bash tool. If a command is denied, do not retry it and reply with one sentence.` }],
      decisions: [{ tool: 'Bash', behavior: 'allow', delayMs: 2000 }, { tool: 'Bash', behavior: 'deny', delayMs: 1000, message: 'The user denied this command' }],
    })
    const approved = present(summary.decisions[0], 'No permission was requested')
    const denied = present(summary.decisions[1], 'The second permission was not requested')
    check(approved.behavior === 'allow' && approved.waitedMs >= 1900 && denied.behavior === 'deny', 'The host did not approve and then deny the commands')
    check(await exists(join(session.project, 'approved.txt')), 'The approved command did not run')
    check(!await exists(join(session.project, 'denied.txt')), 'The denied command ran')
    const transcript = await findTranscript(session, sessionOf(summary))
    const approvedId = present(approved.toolUseId ?? undefined, 'The approval has no tool use id')
    const deniedId = present(denied.toolUseId ?? undefined, 'The denial has no tool use id')
    check(toolResult(transcript, approvedId)?.isError === false, 'The approved command failed')
    check(toolResult(transcript, deniedId)?.isError === true, 'The denied command has no error result')
    const sessionId = sessionOf(summary)
    await session.checkpoint('approval-requested', { hook: { event: 'PermissionRequest', sessionId }, occurrence: 'first' },
      'The first Bash action waits for permission; the session needs attention')
    await session.checkpoint('approved-finished', { hook: { event: 'PostToolUse', toolUseId: approvedId } },
      'The command approved after ~2 s finishes; the attention clears and the action is completed')
    await session.checkpoint('denial-requested', { hook: { event: 'PermissionRequest', sessionId } },
      'The second Bash action waits for permission; the session needs attention again')
  },
}

const question: Definition = {
  name: 'question',
  expectedFacts: [
    'The session asks an explicit AskUserQuestion with the options Hello and Hi',
    'The host answers Hello after ~1.5 s and the session writes the answer into greeting.txt',
  ],
  script: (session) => ({
    question: [
      [{
        tool: 'AskUserQuestion',
        input: {
          questions: [{
            question: 'Which greeting should I use?',
            header: 'Greeting',
            options: [{ label: 'Hello', description: 'A formal greeting' }, { label: 'Hi', description: 'A casual greeting' }],
            multiSelect: false,
          }],
        },
      }],
      [{ tool: 'Write', input: { file_path: join(session.project, 'greeting.txt'), content: 'Hello\n' } }],
      [{ text: 'greeting.txt contains Hello.' }],
    ],
  }),
  run: async ({ session, stage }) => {
    const summary = await stage('question', {
      turns: [{ prompt: '[aang:question] Use the AskUserQuestion tool to ask me which greeting to use, with exactly two options: Hello and Hi. Then write the chosen greeting into greeting.txt with the Write tool.' }],
      decisions: [{ tool: 'AskUserQuestion', behavior: 'allow', delayMs: 1500, answer: 0 }, { tool: 'Write', behavior: 'allow', delayMs: 500 }],
    })
    const asked = present(summary.decisions.find(({ tool }) => tool === 'AskUserQuestion'), 'The session asked no question')
    const answer = present(Object.values(asked.answers ?? {})[0], 'The host gave no answer')
    const askedId = present(asked.toolUseId ?? undefined, 'The question has no tool use id')
    const transcript = await findTranscript(session, sessionOf(summary))
    const result = present(toolResult(transcript, askedId), 'The question has no result')
    check(!result.isError && result.text.includes(answer), `The question result does not carry the answer: ${result.text}`)
    check((await readFile(join(session.project, 'greeting.txt'), 'utf8')).includes(answer), 'greeting.txt does not contain the answer')
    await session.checkpoint('question-asked', { hook: { event: 'PermissionRequest', sessionId: sessionOf(summary) }, occurrence: 'first' },
      'The session asks an explicit question and waits for the user to answer it; the session needs attention')
    await session.checkpoint('question-answered', { hook: { event: 'PostToolUse', toolUseId: askedId } },
      'The question is answered with Hello after ~1.5 s; the attention clears and the session continues')
  },
}

const interrupt: Definition = {
  name: 'interrupt',
  expectedFacts: [
    'A Bash action running sleep 30 is interrupted by the host about 2 s after it starts',
    'The interrupted turn ends with an error result and the transcript records the interruption',
    'The session then ends without waiting for the command',
  ],
  script: () => ({ interrupt: [[bash('sleep 30', 'Wait for thirty seconds')], [{ text: 'Finished waiting.' }]] }),
  run: async ({ session, stage }) => {
    const started = Date.now()
    const summary = await stage('interrupt', {
      turns: [{ prompt: '[aang:interrupt] Run `sleep 30` with the Bash tool.', interrupt: { tool: 'Bash', delayMs: 2000 } }],
    })
    check(Date.now() - started < 28_000, 'The sleep was not interrupted')
    const sleep = present(summary.interrupts[0], 'The host sent no interrupt')
    check(summary.results.length === 1 && summary.results[0]?.isError === true, 'The interrupted turn did not end with an error result')
    const transcript = await findTranscript(session, sessionOf(summary))
    check(userTexts(transcript).some((text) => text.includes('[Request interrupted by user')), 'The transcript does not record the interruption')
    check(toolResult(transcript, sleep.toolUseId)?.isError === true, 'The interrupted action has no error result')
    await session.checkpoint('command-running', { hook: { event: 'PreToolUse', toolUseId: sleep.toolUseId } },
      'A long Bash action is running in the root session')
    await session.checkpoint('interrupted', { ...transcript.target, contains: '[Request interrupted', occurrence: 'first' },
      'The user interrupted the turn: the Bash action is cancelled, the turn ends as interrupted and the session is no longer running')
  },
}

const reconnectBefore = echo('reconnect-before', 'before')
const reconnectAfter = echo('reconnect-after', 'after')

const reconnect: Definition = {
  name: 'reconnect',
  expectedFacts: [
    'One session runs two turns separated by a 5 s pause in the same engine process',
    'The aang daemon is restarted at the daemon-restart label between the turns',
    'The second turn appends to the same session after the restart',
  ],
  script: () => ({ ...reconnectBefore.script, ...reconnectAfter.script }),
  run: async ({ session, stage }) => {
    const summary = await stage('reconnect', { turns: [{ prompt: reconnectBefore.prompt }, { prompt: reconnectAfter.prompt, pauseMs: 5000 }] })
    const sessionId = sessionOf(summary)
    check(summary.results.length === 2 && summary.results.every((result) => result.sessionId === sessionId && !result.isError), 'The two turns did not finish in one session')
    const transcript = await findTranscript(session, sessionId)
    echoUse(transcript, 'before')
    const after = echoUse(transcript, 'after')
    await session.checkpoint('daemon-restart', { hook: { event: 'Stop', sessionId }, occurrence: 'first' },
      'The first turn ends and session S is idle; the daemon restarts here, and after the restart the map shows S with its first action and no duplicates')
    await session.checkpoint('after-restart', { hook: { event: 'PostToolUse', toolUseId: after.id } },
      'The session continues after the restart: the action of the second turn appears in the same session S')
  },
}

const lossRemoved = echo('loss-removed', 'removed')
const lossMoved = echo('loss-moved', 'moved')

const sourceLoss: Definition = {
  name: 'source-loss',
  expectedFacts: [
    'Two short sessions A and B finish',
    'The transcript of A is deleted in a separate step',
    'The transcript of B is moved to another project directory in a separate step',
  ],
  script: () => ({ ...lossRemoved.script, ...lossMoved.script }),
  run: async ({ session, stage, remove, move }) => {
    const removed = sessionOf(await stage('removed-session', { turns: [{ prompt: lossRemoved.prompt }] }))
    const moved = sessionOf(await stage('moved-session', { turns: [{ prompt: lossMoved.prompt }] }))
    check(removed !== moved, 'Both runs reported the same session')
    const lost = await findTranscript(session, removed)
    const kept = await findTranscript(session, moved)
    echoUse(lost, 'removed')
    echoUse(kept, 'moved')
    await remove(lost.file)
    check(!await exists(lost.file), 'The transcript of A still exists')
    await session.checkpoint('transcript-removed', lost.target,
      'The transcript of session A disappears: the map marks its source as lost and keeps the observed history')
    const destination = join(`${dirname(kept.file)}-moved`, basename(kept.file))
    await move(kept.file, destination)
    check(!await exists(kept.file) && await exists(destination), 'The transcript of B was not moved')
    await session.checkpoint('transcript-moved', playerPath(session, destination),
      'The transcript of session B reappears under another project directory: the map keeps one session B whose source moved')
  },
}

const definitions: readonly Definition[] = [tools, subagents, resume, compaction, fork, plan, approval, question, interrupt, reconnect, sourceLoss]

export const scenariosFor = (surface: ClaudeSurface): Scenario[] => definitions.map((definition) => ({
  name: definition.name,
  surface: surface.surface,
  models: ['stub', 'live'],
  ...surface.os === undefined ? {} : { os: surface.os },
  expectedFacts: definition.expectedFacts,
  run: withClaude(surface, definition.script, definition.run),
}))
