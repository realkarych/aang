import { Runtime } from '@aang/contract'
import { z } from 'zod'

export const fakeCliExitCodes = {
  isolation: 3,
  scenario: 4,
} as const

const tokens = z.int().nonnegative()
const epochSeconds = z.int().nonnegative()

const faults = [
  z.strictObject({ kind: z.literal('auth') }),
  z.strictObject({ kind: z.literal('limit'), resetsAt: epochSeconds.optional() }),
  z.strictObject({ kind: z.literal('timeout') }),
  z.strictObject({ kind: z.literal('invalid_json'), text: z.string() }),
] as const

export const ClaudeUsage = z.strictObject({
  inputTokens: tokens,
  cacheCreationInputTokens: tokens,
  cacheReadInputTokens: tokens,
  outputTokens: tokens,
  costUsd: z.number().nonnegative(),
})
export type ClaudeUsage = z.infer<typeof ClaudeUsage>

export const ClaudeReply = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answer'), output: z.json(), usage: ClaudeUsage.optional() }),
  ...faults,
])
export type ClaudeReply = z.input<typeof ClaudeReply>

const Descendant = z.strictObject({
  pidFile: z.string(),
  inheritStdio: z.boolean().default(false),
})

export const ClaudeScenario = z.strictObject({
  descendant: Descendant.optional(),
  version: z.string().default('2.1.286'),
  loggedIn: z.boolean().default(true),
  leakedTools: z.array(z.string()).default(() => []),
  replies: z.array(ClaudeReply).default(() => []),
})
export type ClaudeScenario = z.input<typeof ClaudeScenario>

export const CodexUsage = z.strictObject({
  inputTokens: tokens,
  cachedInputTokens: tokens,
  cacheWriteInputTokens: tokens,
  outputTokens: tokens,
  reasoningOutputTokens: tokens,
})
export type CodexUsage = z.infer<typeof CodexUsage>

export const CodexReply = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('answer'),
    output: z.json(),
    usage: CodexUsage.optional(),
    toolAttempts: z.array(z.string()).default(() => []),
  }),
  ...faults,
])
export type CodexReply = z.input<typeof CodexReply>

export const CodexScenario = z.strictObject({
  descendant: Descendant.optional(),
  version: z.string().default('0.159.3'),
  loggedIn: z.boolean().default(true),
  leakedTools: z.array(z.string()).default(() => []),
  replies: z.array(CodexReply).default(() => []),
})
export type CodexScenario = z.input<typeof CodexScenario>

export const FakeCommand = z.enum([
  'print',
  'auth_status',
  'exec',
  'login_status',
  'debug_models',
  'version',
  'unknown',
])
export type FakeCommand = z.infer<typeof FakeCommand>

export const FakeCall = z.strictObject({
  sequence: z.int().positive(),
  runtime: Runtime,
  command: FakeCommand,
  argv: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  pid: z.int(),
  prompt: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  schema: z.json().nullable(),
  reply: z.int().nonnegative().nullable(),
  violations: z.array(z.string()),
})
export type FakeCall = z.infer<typeof FakeCall>
