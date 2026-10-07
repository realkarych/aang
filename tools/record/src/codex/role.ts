import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadManifest } from '@aang/testkit'
import { z } from 'zod'
import { hookRecords, hooksNamed } from '../hooks.js'
import { childrenFinished, collaboration, shell } from './calls.js'
import { codexExec, stubScenario } from './harness.js'
import { allRollouts, check, completedItems, finished, type Rollout, responseItems, rolloutOf, sessionMeta, threadOf } from './rollout.js'

const role = 'reviewer'
const roleDescription = 'Reviews the project notes and reports what it checked.'
const roleInstructions = 'You are the notes reviewer of the aang recording. Run the command from your task and report its output.'
const reviewTask = 'notes_review'
const scanTask = 'notes_scan'
const roleFile = `agents/${role}.toml`
const roleLayer = `developer_instructions = ${JSON.stringify(roleInstructions)}\n`

const roleConfig = [
  '',
  `[agents.${role}]`,
  `description = ${JSON.stringify(roleDescription)}`,
  `config_file = ${JSON.stringify(roleFile)}`,
  '',
].join('\n')

const writeRole = async (codexHome: string): Promise<void> => {
  await appendFile(join(codexHome, 'config.toml'), roleConfig)
  await mkdir(join(codexHome, 'agents'), { recursive: true })
  await writeFile(join(codexHome, ...roleFile.split('/')), roleLayer)
}

const replayedCodexFiles = async (recording: string): Promise<ReadonlyMap<string, string>> => {
  const playback = await loadManifest(join(recording, 'playback.json'))
  return new Map(playback.steps.flatMap((step) =>
    step.kind === 'write' && step.target.root === 'codex' ? [[step.target.path, playback.sources.get(step.source)?.toString('utf8') ?? ''] as const] : []))
}

const ThreadSpawn = z.looseObject({ source: z.looseObject({ subagent: z.looseObject({ thread_spawn: z.looseObject({ agent_role: z.string().nullable() }) }) }) })

const roleOf = (rollout: Rollout): string | null => ThreadSpawn.parse(sessionMeta(rollout)).source.subagent.thread_spawn.agent_role

const ranCommand = (rollout: Rollout, word: string): boolean => {
  const commands = completedItems(rollout, 'CommandExecution')
  return commands.length === 1 && commands.every((item) =>
    JSON.stringify(item['command']).includes(`echo ${word}`) && item['exit_code'] === 0 && String(item['aggregated_output']).includes(word))
}

const developerTexts = (rollout: Rollout): string[] =>
  responseItems(rollout, 'message').filter((item) => item['role'] === 'developer').map((item) => JSON.stringify(item['content']))

export const agentRole = stubScenario({
  name: 'agent-role',
  surface: 'codex_exec',
  expectedFacts: [
    `config.toml declares the agent role ${role} ([agents.${role}]) with a description and the config_file ${roleFile} whose developer_instructions define the role; the recording replays both files into CODEX_HOME`,
    `The root thread spawns ${reviewTask} with agent_type ${role} and ${scanTask} without a role in one step (fork_turns none), then one wait_agent returns after both finished`,
    `The ${reviewTask} child has agent_role ${role} in session_meta and the role instructions as a developer message; the ${scanTask} child has agent_role null`,
    `Each child runs its echo command, which exits with 0 and prints its word; the SubagentStart hook of ${reviewTask} carries agent_type ${role}, that of ${scanTask} default`,
  ],
  script: (session) => ({
    'agent-role': [
      [
        collaboration('spawn_agent', { task_name: reviewTask, message: 'Run `echo reviewed` and report.', agent_type: role, fork_turns: 'none' }),
        collaboration('spawn_agent', { task_name: scanTask, message: 'Run `echo scanned` and report.', fork_turns: 'none' }),
      ],
      { calls: [collaboration('wait_agent', { timeout_ms: 30_000 })], when: childrenFinished(session, 2) },
    ],
    [reviewTask]: [[shell('echo reviewed')]],
    [scanTask]: [[shell('echo scanned')]],
  }),
  run: async ({ session, stub }) => {
    await writeRole(session.codex)
    await session.keep({ root: 'codex', path: 'config.toml' })
    await session.keep({ root: 'codex', path: roleFile })
    const root = threadOf((await codexExec(session, [`[aang:agent-role] Spawn the ${role} agent ${reviewTask} and the default agent ${scanTask}, wait for them, then reply done.`])).stdout)
    const children = (await allRollouts(session.codex)).filter((rollout) => sessionMeta(rollout)['parent_thread_id'] === root)
    const childAt = (task: string): Rollout => {
      const child = children.find((rollout) => sessionMeta(rollout)['agent_path'] === `/root/${task}`)
      check(child !== undefined, `the child ${task} of ${root} was written (${children.map((rollout) => String(sessionMeta(rollout)['agent_path'])).join(', ')})`)
      return child as Rollout
    }
    const reviewer = childAt(reviewTask)
    const scanner = childAt(scanTask)
    check(roleOf(reviewer) === role, `the child ${reviewTask} has agent_role ${role} (got ${String(roleOf(reviewer))})`)
    check(roleOf(scanner) === null, `the child ${scanTask} has agent_role null (got ${String(roleOf(scanner))})`)
    check(developerTexts(reviewer).some((text) => text.includes(roleInstructions)), `the child ${reviewTask} received the instructions of the role ${role}`)
    check(!developerTexts(scanner).some((text) => text.includes(roleInstructions)), `the child ${scanTask} did not receive the instructions of the role ${role}`)
    check(ranCommand(reviewer, 'reviewed') && ranCommand(scanner, 'scanned'), 'each child ran its echo command once, with exit code 0 and its word in the output')
    check(stub.replies.some((reply) => reply.agent === `/root/${reviewTask}` && reply.subagent === 'collab_spawn'), `the ${reviewTask} request carries x-openai-subagent: collab_spawn`)
    const started = hooksNamed(await hookRecords(session.spool), 'SubagentStart')
    const startedAs = (child: Rollout): string => started.filter((hook) => hook['agent_id'] === sessionMeta(child)['id']).map((hook) => String(hook['agent_type'])).join(', ')
    check(startedAs(reviewer) === role && startedAs(scanner) === 'default',
      `the SubagentStart hook of ${reviewTask} has agent_type ${role} and that of ${scanTask} default (got ${startedAs(reviewer) || 'none'} and ${startedAs(scanner) || 'none'})`)
    await session.checkpoint('role-agent-finished', finished(reviewer),
      `The subagent ${reviewTask} of role ${role} finishes under the root session; it is shown with the role definition from config.toml`)
    await session.checkpoint('root-finished', finished(await rolloutOf(session.codex, root)),
      `The root turn completes after waiting for the ${role} subagent and the subagent without a role`)
  },
  checkRecording: async (recording) => {
    const files = await replayedCodexFiles(recording)
    check(files.get('config.toml')?.includes(roleConfig) === true, `the recording replays config.toml with [agents.${role}], its description and config_file ${roleFile}`)
    check(files.get(roleFile) === roleLayer, `the recording replays ${roleFile} with the developer_instructions of the role ${role}`)
  },
})
