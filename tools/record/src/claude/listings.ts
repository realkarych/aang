import { z } from 'zod'
import { hookRecords, hooksNamed } from '../hooks.js'
import type { ScenarioSession } from '../scenario.js'
import { bash, check, present } from './definition.js'
import type { StubBlock, StubScript } from './stub.js'
import {
  attachments, commandOf, named, readTranscript, subagentMetas, toolResult, toolUses, type ToolUse, type Transcript,
} from './transcripts.js'

const AgentListing = z.looseObject({ addedTypes: z.array(z.string()), addedLines: z.array(z.string()) })
const SkillListing = z.looseObject({ content: z.string(), names: z.array(z.string()).optional() })
const AgentInput = z.looseObject({ subagent_type: z.string() })

export const agentPrompt = (key: string, word: string): string => `[aang:${key}] Run \`echo ${word}\` with the Bash tool and report its output.`

export const agentCall = (type: string, key: string, word: string, description: string): StubBlock =>
  ({ tool: 'Agent', input: { description, prompt: agentPrompt(key, word), subagent_type: type, run_in_background: false } })

export const childScript = (key: string, word: string): StubScript => ({ [key]: [[bash(`echo ${word}`, `Print ${word}`)], [{ text: word }]] })

export const listedAgent = (transcript: Transcript, type: string): string => {
  const listings = attachments(transcript).filter(({ type: kind }) => kind === 'agent_listing_delta').map((listing) => AgentListing.parse(listing))
  const line = listings.flatMap(({ addedLines }) => addedLines).find((entry) => entry.startsWith(`- ${type}:`))
  return present(line, `The agent listing of ${transcript.target.path} has no ${type}: ${listings.flatMap(({ addedTypes }) => addedTypes).join(', ')}`)
}

export const listedSkill = (transcript: Transcript, skill: string): string => {
  const listings = attachments(transcript).filter(({ type }) => type === 'skill_listing').map((listing) => SkillListing.parse(listing))
  const line = listings.flatMap(({ content }) => content.split('\n')).find((entry) => entry.startsWith(`- ${skill}:`))
  return present(line, `The skill listing of ${transcript.target.path} has no ${skill}: ${listings.flatMap(({ names }) => names ?? []).join(', ')}`)
}

const subagentTypeOf = (use: ToolUse): string | undefined => AgentInput.safeParse(use.input).data?.subagent_type

export const checkDefinedAgent = async (
  session: ScenarioSession,
  transcript: Transcript,
  type: string,
  description: string,
  word: string,
): Promise<ToolUse> => {
  const listed = listedAgent(transcript, type)
  check(listed.includes(description), `The agent listing does not carry the description of ${type}: ${listed}`)
  const call = present(toolUses(transcript).find((use) => (use.name === 'Agent' || use.name === 'Task') && subagentTypeOf(use) === type),
    `The session never started the ${type} subagent`)
  const result = present(toolResult(transcript, call.id), `The ${type} subagent has no result`)
  check(!result.isError, `The ${type} subagent failed: ${result.text}`)
  const metas = await subagentMetas(transcript)
  const meta = present(metas.find(({ toolUseId }) => toolUseId === call.id), `No subagent meta file belongs to ${call.id}: ${metas.map(({ agentType }) => agentType).join(', ')}`)
  check(meta.agentType === type, `The subagent of ${call.id} has the type ${meta.agentType} instead of ${type}`)
  const child = await readTranscript(session.claude, meta.transcript)
  check(named(toolUses(child), 'Bash').some((use) => commandOf(use).includes(`echo ${word}`)), `The ${type} subagent did not run echo ${word}`)
  const started = hooksNamed(await hookRecords(session.spool), 'SubagentStart')
  check(started.some((hook) => hook['agent_type'] === type), `No SubagentStart hook has the agent type ${type}: ${started.map((hook) => String(hook['agent_type'])).join(', ')}`)
  return call
}
