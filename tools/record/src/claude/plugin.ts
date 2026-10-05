import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { check, type Definition, present, sessionOf } from './definition.js'
import { agentCall, checkDefinedAgent, childScript, listedSkill } from './listings.js'
import { findTranscript, named, toolResult, toolUses } from './transcripts.js'

const pluginName = 'aang-kit'
const skill = `${pluginName}:greeting`
const agentType = `${pluginName}:reviewer`
const skillDescription = 'Chooses the greeting of the project notes. Use it when asked which greeting the notes use.'
const skillRule = 'The project notes greet the reader with Hello.'
const agentDescription = 'Reviews the project notes and reports what it checked. Use it to review the notes.'

const pluginFiles: readonly (readonly [string, string])[] = [
  ['.claude-plugin/plugin.json', `${JSON.stringify({ name: pluginName, version: '1.0.0', description: 'An agent and a skill for the aang plugin recording', author: { name: 'aang' } }, null, 2)}\n`],
  ['agents/reviewer.md', ['---', 'name: reviewer', `description: ${agentDescription}`, 'tools: Bash', '---', '', 'You review the project notes. Run the command from the task with the Bash tool and report its output.', ''].join('\n')],
  ['skills/greeting/SKILL.md', ['---', 'name: greeting', `description: ${skillDescription}`, '---', '', skillRule, ''].join('\n')],
]

const writePlugin = async (directory: string): Promise<void> => {
  for (const [file, content] of pluginFiles) {
    const path = join(directory, ...file.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

const skillOf = (input: unknown): string | undefined => z.looseObject({ skill: z.string() }).safeParse(input).data?.skill

export const plugin: Definition = {
  name: 'plugin',
  models: ['stub'],
  expectedFacts: [
    `The session loads the plugin ${pluginName} with --plugin-dir; the agent listing describes its agent ${agentType} and the skill listing describes its skill ${skill}`,
    `The root session invokes the plugin skill ${skill} with the Skill tool and the skill instructions enter the session`,
    `The root session starts the plugin subagent ${agentType}, which runs one Bash action; its meta file and SubagentStart hook carry the type ${agentType}`,
  ],
  script: () => ({
    plugin: [
      [{ tool: 'Skill', input: { skill } }],
      [agentCall(agentType, 'plugin-review', 'reviewed', 'Review the notes')],
      [{ text: 'The greeting is Hello and the reviewer checked the notes.' }],
    ],
    ...childScript('plugin-review', 'reviewed'),
  }),
  run: async ({ session, stage }) => {
    const directory = join(session.work, pluginName)
    await writePlugin(directory)
    const summary = await stage('plugin', {
      plugins: [directory],
      turns: [{ prompt: `[aang:plugin] Use the ${skill} skill with the Skill tool to choose the greeting of the project notes, then ask the ${agentType} subagent with the Agent tool to run \`echo reviewed\`. Reply with one sentence.` }],
      decisions: [{ tool: 'Skill', behavior: 'allow', delayMs: 500, optional: true }],
    })
    check(summary.tools.includes('Skill'), 'The engine offered no Skill tool')
    const sessionId = sessionOf(summary)
    const transcript = await findTranscript(session, sessionId)
    const listed = listedSkill(transcript, skill)
    check(listed.includes(skillDescription), `The skill listing does not carry the description of ${skill}: ${listed}`)
    const invoked = present(named(toolUses(transcript), 'Skill').find(({ input }) => skillOf(input) === skill), `The session never invoked ${skill}`)
    const result = present(toolResult(transcript, invoked.id), `${skill} has no result`)
    check(!result.isError, `${skill} failed: ${result.text}`)
    check(JSON.stringify(transcript.entries).includes(skillRule), `The instructions of ${skill} did not enter the session`)
    const spawned = await checkDefinedAgent(session, transcript, agentType, agentDescription, 'reviewed')
    await session.checkpoint('skill-invoked', { hook: { event: 'PostToolUse', toolUseId: invoked.id } },
      `The session invokes the plugin skill ${skill}; the skill with its description enters the run context`)
    await session.checkpoint('plugin-agent-finished', { hook: { event: 'PostToolUse', toolUseId: spawned.id } },
      `The plugin subagent ${agentType} finishes its Bash action; the child agent is shown with the definition of the plugin agent`)
    await session.checkpoint('turn-finished', { hook: { event: 'Stop', sessionId } },
      'The turn ends: the root session becomes idle after the skill and the plugin subagent')
  },
}
