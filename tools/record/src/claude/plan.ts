import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'

export const Decision = z.strictObject({
  tool: z.string().min(1),
  behavior: z.enum(['allow', 'deny']),
  delayMs: z.int().nonnegative().default(0),
  message: z.string().default('The user denied this action'),
  answer: z.int().nonnegative().optional(),
})
export type Decision = z.infer<typeof Decision>

export const ElicitationAnswer = z.strictObject({
  mode: z.enum(['form', 'url']),
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.record(z.string(), z.unknown()).optional(),
  delayMs: z.int().nonnegative().default(0),
})
export type ElicitationAnswer = z.infer<typeof ElicitationAnswer>

const McpServer = z.strictObject({ command: z.string().min(1), args: z.array(z.string()).default([]) })

const Turn = z.strictObject({
  prompt: z.string().min(1),
  pauseMs: z.int().nonnegative().default(0),
  interrupt: z.strictObject({ tool: z.string().min(1), delayMs: z.int().nonnegative() }).optional(),
})

export const SettingSource = z.enum(['user', 'project', 'local'])
export type SettingSource = z.infer<typeof SettingSource>

export const HostPlan = z.strictObject({
  engine: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  initialize: z.boolean().default(false),
  resume: z.string().min(1).optional(),
  fork: z.boolean().default(false),
  permissionMode: z.enum(['default', 'plan']).default('default'),
  turns: z.array(Turn).min(1),
  decisions: z.array(Decision).default([]),
  mcpServers: z.record(z.string(), McpServer).default({}),
  elicitations: z.array(ElicitationAnswer).default([]),
  turnTimeoutMs: z.int().positive().default(240_000),
})
export type HostPlan = z.infer<typeof HostPlan>
export type HostPlanInput = z.input<typeof HostPlan>

export const HostSummary = z.strictObject({
  sessionIds: z.array(z.string()),
  tools: z.array(z.string()),
  results: z.array(z.strictObject({ sessionId: z.string(), subtype: z.string(), isError: z.boolean(), numTurns: z.number() })),
  toolUses: z.array(z.strictObject({ id: z.string(), name: z.string(), parent: z.string().nullable(), input: z.unknown().optional() })),
  decisions: z.array(z.strictObject({
    tool: z.string(),
    behavior: z.enum(['allow', 'deny']),
    toolUseId: z.string().nullable(),
    waitedMs: z.number(),
    answers: z.record(z.string(), z.string()).nullable(),
  })),
  interrupts: z.array(z.strictObject({ tool: z.string(), toolUseId: z.string() })),
  elicitations: z.array(z.strictObject({
    server: z.string(),
    mode: z.enum(['form', 'url']),
    elicitationId: z.string().nullable(),
    action: z.enum(['accept', 'decline', 'cancel']),
    opened: z.boolean(),
    waitedMs: z.number(),
  })),
  completedElicitations: z.array(z.string()),
  error: z.string().nullable(),
})
export type HostSummary = z.infer<typeof HostSummary>

export const readPlan = async (path: string): Promise<HostPlan> => HostPlan.parse(JSON.parse(await readFile(path, 'utf8')))

export const emptySummary = (): HostSummary =>
  ({ sessionIds: [], tools: [], results: [], toolUses: [], decisions: [], interrupts: [], elicitations: [], completedElicitations: [], error: null })

export const writeSummary = (path: string, summary: HostSummary): Promise<void> => writeFile(path, `${JSON.stringify(summary, null, 2)}\n`)

export const readSummary = async (path: string): Promise<HostSummary | undefined> => {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  return text === undefined ? undefined : HostSummary.parse(JSON.parse(text))
}

export const pluginDirectory = (argv: readonly string[]): string => {
  const index = argv.lastIndexOf('--plugin-dir')
  const directory = argv[index + 1]
  if (index < 0 || directory === undefined) throw new Error('The recorder did not pass --plugin-dir')
  return directory
}

export const forwardedSettings = (argv: readonly string[]): { readonly settingSources?: SettingSource[]; readonly strictMcpConfig: boolean } => {
  const index = argv.lastIndexOf('--setting-sources')
  const sources = index < 0 ? undefined : argv[index + 1]
  return {
    ...sources === undefined ? {} : { settingSources: z.array(SettingSource).min(1).parse(sources.split(',')) },
    strictMcpConfig: argv.includes('--strict-mcp-config'),
  }
}

const answersFor = (input: Readonly<Record<string, unknown>>, choice: number): Record<string, string> => {
  const questions = z.array(z.looseObject({ question: z.string(), options: z.array(z.looseObject({ label: z.string() })) }))
    .parse(input['questions'])
  return Object.fromEntries(questions.map(({ question, options }) => {
    const option = options[Math.min(choice, options.length - 1)]
    if (option === undefined) throw new Error(`Question without options: ${question}`)
    return [question, option.label]
  }))
}

export const decide = (decision: Decision, tool: string, input: Readonly<Record<string, unknown>>): {
  readonly response: { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
  readonly answers: Record<string, string> | null
} => {
  if (decision.behavior === 'deny') return { response: { behavior: 'deny', message: decision.message }, answers: null }
  const answers = tool === 'AskUserQuestion' ? answersFor(input, decision.answer ?? 0) : null
  return { response: { behavior: 'allow', updatedInput: answers === null ? { ...input } : { ...input, answers } }, answers }
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
