import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { hookRecords, hooksNamed } from '../hooks.js'
import { EngineUnavailableError, type ScenarioSession } from '../scenario.js'
import { check, type Definition, present, sessionOf } from './definition.js'
import type { HostPlanInput } from './plan.js'
import { findTranscript, named, toolResult, toolUses, type Transcript } from './transcripts.js'

const server = fileURLToPath(new URL('./elicitation-server.js', import.meta.url))
export const elicitationServer = 'aang-elicitation'
export const greetingTool = `mcp__${elicitationServer}__choose_greeting`
export const linkTool = `mcp__${elicitationServer}__confirm_link`

const logOf = (session: ScenarioSession): string => join(session.work, 'elicitation-server.jsonl')

export const elicitationServers = (session: ScenarioSession): NonNullable<HostPlanInput['mcpServers']> =>
  ({ [elicitationServer]: { command: process.execPath, args: [server, logOf(session)] } })

export const elicitationConfig = (session: ScenarioSession): string =>
  JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(elicitationServers(session)).map(([name, entry]) => [name, { type: 'stdio', ...entry }])) })

const ServerEvent = z.looseObject({
  event: z.string(),
  mode: z.string().nullish(),
  elicitationId: z.string().nullish(),
  action: z.string().nullish(),
  content: z.record(z.string(), z.unknown()).nullish(),
})

export interface ServerLog {
  readonly linkSupported: boolean
  readonly answered: (mode: 'form' | 'url') => z.infer<typeof ServerEvent> | undefined
  readonly confirmed: (elicitationId: string) => boolean
}

export const serverLog = async (session: ScenarioSession): Promise<ServerLog> => {
  const events = (await readFile(logOf(session), 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => ServerEvent.parse(JSON.parse(line)))
  return {
    linkSupported: events.some((event) => event.event === 'initialize' && typeof event['elicitation'] === 'object' && event['elicitation'] !== null && 'url' in event['elicitation']),
    answered: (mode) => events.find((event) => event.event === 'answered' && event.mode === mode),
    confirmed: (elicitationId) => ['visited', 'completed'].every((kind) => events.some((event) => event.event === kind && event.elicitationId === elicitationId)),
  }
}

export const greetingOf = (content: unknown): string | undefined => z.looseObject({ greeting: z.string() }).safeParse(content).data?.greeting

export const resultOf = (transcript: Transcript, tool: string): { readonly id: string; readonly isError: boolean; readonly text: string } => {
  const use = present(named(toolUses(transcript), tool).at(-1), `${transcript.target.path} has no ${tool} action`)
  const result = present(toolResult(transcript, use.id), `${tool} has no result`)
  return { id: use.id, ...result }
}

export const elicitation: Definition = {
  name: 'elicitation',
  models: ['stub'],
  expectedFacts: [
    'The MCP server aang-elicitation asks for a greeting through a form elicitation; the host answers Hello after ~1.5 s',
    'The same server asks the user to open a link through a URL elicitation; the host opens the link after ~1 s and the server confirms completion',
    'Both MCP actions finish with results that carry the answers; Elicitation and ElicitationResult hooks record each request and answer',
  ],
  script: () => ({
    elicitation: [
      [{ tool: greetingTool, input: {} }],
      [{ tool: linkTool, input: {} }],
      [{ text: 'The greeting is Hello and the project link is confirmed.' }],
    ],
  }),
  run: async ({ session, stage }) => {
    const summary = await stage('elicitation', {
      turns: [{ prompt: `[aang:elicitation] Call the choose_greeting tool of the ${elicitationServer} MCP server, then call its confirm_link tool. Reply with one sentence.` }],
      mcpServers: elicitationServers(session),
      decisions: [{ tool: greetingTool, behavior: 'allow', delayMs: 500 }, { tool: linkTool, behavior: 'allow', delayMs: 500 }],
      elicitations: [{ mode: 'form', action: 'accept', content: { greeting: 'Hello' }, delayMs: 1500 }, { mode: 'url', action: 'accept', delayMs: 1000 }],
    }).catch(async (error: unknown) => {
      if ((await serverLog(session).catch(() => undefined))?.linkSupported === false) {
        throw new EngineUnavailableError(`Claude ${session.engine.version} does not declare URL elicitation support to MCP servers`, { cause: error })
      }
      throw error
    })
    const form = present(summary.elicitations.find(({ mode }) => mode === 'form'), 'The host received no form elicitation')
    const link = present(summary.elicitations.find(({ mode }) => mode === 'url'), 'The host received no URL elicitation')
    check(form.server === elicitationServer && form.action === 'accept' && form.waitedMs >= 1400, 'The host did not answer the form elicitation after ~1.5 s')
    const linkId = present(link.elicitationId ?? undefined, 'The URL elicitation has no elicitation id')
    check(link.opened && summary.completedElicitations.includes(linkId), 'The link was not opened or its completion did not reach the host')
    const log = await serverLog(session)
    check(greetingOf(log.answered('form')?.content) === 'Hello', 'The MCP server did not receive the greeting Hello')
    check(log.confirmed(linkId), 'The MCP server did not see the link opened and did not confirm completion')
    const sessionId = sessionOf(summary)
    const transcript = await findTranscript(session.claude, sessionId)
    const greeting = resultOf(transcript, greetingTool)
    const confirmation = resultOf(transcript, linkTool)
    check(!greeting.isError && greeting.text.includes('Hello'), `The greeting action does not carry the answer: ${greeting.text}`)
    check(!confirmation.isError && confirmation.text.includes('confirmed'), `The link action does not carry the confirmation: ${confirmation.text}`)
    const hooks = await hookRecords(session.spool)
    const requested = hooksNamed(hooks, 'Elicitation')
    const answered = hooksNamed(hooks, 'ElicitationResult')
    check(requested.some((hook) => hook['mode'] === 'form' && hook['requested_schema'] !== undefined) && requested.some((hook) => hook['mode'] === 'url' && hook['elicitation_id'] === linkId),
      'Elicitation hooks do not record the form and the URL requests')
    check(answered.some((hook) => hook['mode'] === 'form' && hook['action'] === 'accept' && greetingOf(hook['content']) === 'Hello') &&
      answered.some((hook) => hook['mode'] === 'url' && hook['action'] === 'accept' && hook['elicitation_id'] === linkId),
    'ElicitationResult hooks do not record both answers')
    await session.checkpoint('form-requested', { hook: { event: 'Elicitation', sessionId }, occurrence: 'first' },
      'The MCP server asks for a greeting through a form; the session waits for the user and needs attention')
    await session.checkpoint('form-answered', { hook: { event: 'ElicitationResult', sessionId }, occurrence: 'first' },
      'The user answers Hello after ~1.5 s; the attention clears and the MCP action continues')
    await session.checkpoint('link-confirmed', { hook: { event: 'PostToolUse', toolUseId: confirmation.id } },
      'The user opened the link and the MCP server confirmed it; the MCP action finishes and no input is pending')
  },
}
