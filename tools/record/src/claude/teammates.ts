import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { hookRecords, hooksNamed } from '../hooks.js'
import { bash, check, type Definition, present, taskFiles } from './definition.js'
import { commandOf, findTranscript, named, subagentTranscripts, toolUses, transcriptFiles } from './transcripts.js'

const SpawnedTeammate = z.looseObject({ status: z.literal('teammate_spawned'), name: z.string(), team_name: z.string(), agent_id: z.string() })
const TeammateMeta = z.looseObject({ name: z.string(), teamName: z.string(), taskKind: z.string() })

export const teammatePrompt = '[aang:teammate] Run `echo mate` with the Bash tool, then complete your tasks.'

export const spawnTeammate = { tool: 'Agent', input: { description: 'Echo mate', name: 'helper', prompt: teammatePrompt, subagent_type: 'general-purpose' } } as const

export const teamEnv = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }

export const teammates: Definition = {
  name: 'teammates',
  models: ['stub'],
  surfaces: ['claude_cli'],
  os: ['macos', 'linux'],
  expectedFacts: [
    'An interactive CLI session with agent teams creates the task Echo mate and spawns the in-process teammate helper of its session team',
    'The team config lists the lead and helper; helper has its own transcript and meta with the team name',
    'helper creates and completes the task Report mate, completes Echo mate and runs one Bash action; TaskCreated and TaskCompleted carry teammate_name helper',
    'helper becomes idle (TeammateIdle) and the lead session reports back',
  ],
  script: () => ({
    team: [
      [{ tool: 'TaskCreate', input: { subject: 'Echo mate', description: 'Run echo mate', activeForm: 'Echoing mate' } }],
      [spawnTeammate],
      [{ text: 'The teammate helper is working on Echo mate.' }],
    ],
    teammate: [
      [{ tool: 'TaskUpdate', input: { taskId: '1', owner: 'helper', status: 'in_progress' } }],
      [{ tool: 'TaskCreate', input: { subject: 'Report mate', description: 'Report the echo output', activeForm: 'Reporting mate' } }],
      [bash('echo mate', 'Print mate')],
      [{ tool: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }],
      [{ tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }],
      [{ text: 'mate' }],
    ],
  }),
  run: async ({ session, tui }) => {
    await tui('team', {
      args: ['--teammate-mode', 'in-process'],
      env: teamEnv,
      steps: [
        { hook: 'SessionStart' },
        { prompt: '[aang:team] Create the task Echo mate with TaskCreate, then spawn the teammate helper with the Agent tool to run it.' },
        { file: 'teams/*/config.json', shows: '"name": "helper"' },
        { hook: 'TeammateIdle' },
        { idle: 2 },
      ],
    })
    const roots = await transcriptFiles(session)
    check(roots.length === 1, `The interactive session wrote ${String(roots.length)} root transcripts`)
    const sessionId = basename(present(roots[0], 'No root transcript'), '.jsonl')
    const hooks = await hookRecords(session.spool)
    const spawned = SpawnedTeammate.parse(present(hooksNamed(hooks, 'PostToolUse', { key: 'tool_name', value: 'Agent' }).at(-1), 'The Agent action has no PostToolUse hook')['tool_response'])
    const team = spawned.team_name
    check(spawned.name === 'helper' && spawned.agent_id === `helper@${team}`, `The Agent action did not spawn helper in the session team: ${spawned.agent_id}`)
    const byHelper = (event: string): string[] => hooksNamed(hooks, event, { key: 'teammate_name', value: 'helper' }).filter((hook) => hook['team_name'] === team).map((hook) => String(hook['task_id']))
    check(hooksNamed(hooks, 'TaskCreated').some((hook) => hook['task_id'] === '1' && hook['teammate_name'] === undefined), 'The lead did not create the task Echo mate')
    check(byHelper('TaskCreated').join(',') === '2', 'TaskCreated does not carry teammate_name helper for Report mate')
    check(byHelper('TaskCompleted').toSorted().join(',') === '1,2', 'TaskCompleted does not carry teammate_name helper for both tasks')
    check(hooksNamed(hooks, 'TeammateIdle', { key: 'teammate_name', value: 'helper' }).some((hook) => hook['team_name'] === team), 'helper never became idle')
    const tasks = await taskFiles(session, team)
    check(tasks.length === 2 && tasks.every(({ task }) => task.status === 'completed'), `The team task list is not two completed tasks: ${tasks.map(({ task }) => `${task.id}:${task.status}`).join(', ')}`)
    const transcript = await findTranscript(session, sessionId)
    const subagents = join(transcript.file.slice(0, -'.jsonl'.length), 'subagents')
    const metaFile = present((await readdir(subagents)).find((name) => /^agent-ahelper-.+\.meta\.json$/.test(name)), 'helper has no meta file')
    const meta = TeammateMeta.parse(JSON.parse(await readFile(join(subagents, metaFile), 'utf8')))
    check(meta.name === 'helper' && meta.teamName === team && meta.taskKind === 'in_process_teammate', 'The meta of helper does not name the in-process teammate of the team')
    const helper = (await subagentTranscripts(session.claude, transcript)).filter((child) => child.target.path.includes('agent-ahelper-'))
    check(helper.some((child) => named(toolUses(child), 'Bash').some((use) => commandOf(use).includes('echo mate'))), 'The transcript of helper does not run echo mate')
    await session.checkpoint('teammate-joined', { root: 'claude', path: `teams/${team}/config.json`, contains: '"name": "helper"', occurrence: 'first' },
      'The session team gets the in-process teammate helper next to the lead; helper appears as a teammate agent of the session')
    await session.checkpoint('teammate-task-completed', { hook: { event: 'TaskCompleted', sessionId }, occurrence: 'first' },
      'helper completes its own task Report mate')
    await session.checkpoint('teammate-idle', { hook: { event: 'TeammateIdle', sessionId } },
      'helper has completed Echo mate and is idle; the lead session reports back and no work is running')
  },
}
