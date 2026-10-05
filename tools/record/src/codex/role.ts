import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

const roleConfig = [
  '',
  `[agents.${role}]`,
  `description = ${JSON.stringify(roleDescription)}`,
  `config_file = "agents/${role}.toml"`,
  '',
].join('\n')

const writeRole = async (codexHome: string): Promise<void> => {
  await appendFile(join(codexHome, 'config.toml'), roleConfig)
  await mkdir(join(codexHome, 'agents'), { recursive: true })
  await writeFile(join(codexHome, 'agents', `${role}.toml`), `developer_instructions = ${JSON.stringify(roleInstructions)}\n`)
}

const ThreadSpawn = z.looseObject({ source: z.looseObject({ subagent: z.looseObject({ thread_spawn: z.looseObject({ agent_role: z.string().nullable() }) }) }) })

const roleOf = (rollout: Rollout): string | null | undefined => ThreadSpawn.safeParse(sessionMeta(rollout)).data?.source.subagent.thread_spawn.agent_role

const developerTexts = (rollout: Rollout): string[] =>
  responseItems(rollout, 'message').filter((item) => item['role'] === 'developer').map((item) => JSON.stringify(item['content']))

export const agentRole = stubScenario({
  name: 'agent-role',
  surface: 'codex_exec',
  expectedFacts: [
    `config.toml declares the agent role ${role} ([agents.${role}]) with a description and a config_file layer whose developer_instructions define the role`,
    `The root thread spawns ${reviewTask} with agent_type ${role} and ${scanTask} without a role in one step (fork_turns none), then one wait_agent returns after both finished`,
    `The ${reviewTask} child has agent_role ${role} in session_meta and the role instructions as a developer message; the ${scanTask} child has no role`,
    `SubagentStart hooks carry agent_type ${role} for ${reviewTask} and default for ${scanTask}`,
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
    check(roleOf(scanner) !== role, `the child ${scanTask} has no role (got ${String(roleOf(scanner))})`)
    check(developerTexts(reviewer).some((text) => text.includes(roleInstructions)), `the child ${reviewTask} received the instructions of the role ${role}`)
    check(!developerTexts(scanner).some((text) => text.includes(roleInstructions)), `the child ${scanTask} did not receive the instructions of the role ${role}`)
    check([reviewer, scanner].every((child) => completedItems(child, 'CommandExecution').length === 1), 'each child ran its command')
    check(stub.replies.some((reply) => reply.agent === `/root/${reviewTask}` && reply.subagent === 'collab_spawn'), `the ${reviewTask} request carries x-openai-subagent: collab_spawn`)
    const started = hooksNamed(await hookRecords(session.spool), 'SubagentStart')
    check(hooksNamed(started, 'SubagentStart', { key: 'agent_type', value: role }).length === 1, `one SubagentStart hook has agent_type ${role} (got ${started.map((hook) => String(hook['agent_type'])).join(', ')})`)
    await session.checkpoint('role-agent-finished', finished(reviewer),
      `The subagent ${reviewTask} of role ${role} finishes under the root session; it is shown with the role definition from config.toml`)
    await session.checkpoint('root-finished', finished(await rolloutOf(session.codex, root)),
      `The root turn completes after waiting for the ${role} subagent and the subagent without a role`)
  },
})
