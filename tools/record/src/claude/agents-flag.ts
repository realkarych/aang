import { type Definition, sessionOf } from './definition.js'
import { agentCall, checkDefinedAgent, childScript } from './listings.js'
import { findTranscript } from './transcripts.js'

const agentType = 'notes-checker'
const agentDescription = 'Checks the project notes and reports the result. Use it to check the notes.'

export const agentsFlag: Definition = {
  name: 'agents-flag',
  models: ['stub'],
  surfaces: ['claude_cli', 'claude_sdk'],
  expectedFacts: [
    `The session defines the agent ${agentType} for this run only: --agents on the CLI, the agents option of query() in the SDK; the agent listing describes it`,
    `The root session starts the ${agentType} subagent, which runs one Bash action that prints checked and reports back`,
    `The meta file and the SubagentStart hook of the subagent carry the type ${agentType}`,
  ],
  script: () => ({
    'agents-flag': [
      [agentCall(agentType, 'flag-check', 'checked', 'Check the notes')],
      [{ text: 'The notes checker reported checked.' }],
    ],
    ...childScript('flag-check', 'checked'),
  }),
  run: async ({ session, stage }) => {
    const summary = await stage('agents-flag', {
      agents: { [agentType]: { description: agentDescription, prompt: 'You check the project notes. Run the command from the task with the Bash tool and report its output.', tools: ['Bash'] } },
      turns: [{ prompt: `[aang:agents-flag] Ask the ${agentType} subagent with the Agent tool to run \`echo checked\`. Reply with one sentence.` }],
    })
    const sessionId = sessionOf(summary)
    const spawned = await checkDefinedAgent(session, await findTranscript(session, sessionId), agentType, agentDescription, 'checked')
    await session.checkpoint('flag-agent-started', { hook: { event: 'PreToolUse', toolUseId: spawned.id } },
      `The root session starts the subagent ${agentType}, defined for this run only`)
    await session.checkpoint('flag-agent-finished', { hook: { event: 'PostToolUse', toolUseId: spawned.id } },
      `The subagent ${agentType} finishes its Bash action; the child agent is shown with the definition passed for the run`)
  },
}
