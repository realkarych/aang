import { Runtime } from '@aang/contract'
import { z } from 'zod'
import { ScenarioScript } from '../observer-scenarios/scripts.js'

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
  z.strictObject({ kind: z.literal('network') }),
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
  z.strictObject({ kind: z.literal('script'), script: ScenarioScript, usage: ClaudeUsage.optional() }),
  ...faults,
])
export type ClaudeReply = z.input<typeof ClaudeReply>

const Descendant = z.strictObject({
  pidFile: z.string(),
  inheritStdio: z.boolean().default(false),
})

export const ClaudePluginCommand = z.enum([
  'marketplace-add',
  'marketplace-remove',
  'install',
  'uninstall',
  'disable',
  'list',
])
export type ClaudePluginCommand = z.infer<typeof ClaudePluginCommand>

export const ClaudeScenario = z.strictObject({
  admissionFault: z.enum(['hook_missing', 'hook_leak', 'registry_missing', 'registry_marker', 'transcript', 'tool_execution']).optional(),
  descendant: Descendant.optional(),
  version: z.string().default('2.1.286'),
  loggedIn: z.boolean().default(true),
  leakedTools: z.array(z.string()).default(() => []),
  replies: z.array(ClaudeReply).default(() => []),
  chatReplies: z.array(ClaudeReply).default(() => []),
  pluginFailures: z.array(ClaudePluginCommand).default(() => []),
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
  z.strictObject({ kind: z.literal('script'), script: ScenarioScript, usage: CodexUsage.optional() }),
  ...faults,
])
export type CodexReply = z.input<typeof CodexReply>

export const CodexScenario = z.strictObject({
  admissionFault: z.enum(['hook_missing', 'hook_leak', 'rollout', 'sqlite', 'tool_supported', 'no_http', 'missing_last']).optional(),
  descendant: Descendant.optional(),
  version: z.string().default('0.159.3'),
  loggedIn: z.boolean().default(true),
  leakedTools: z.array(z.string()).default(() => []),
  replies: z.array(CodexReply).default(() => []),
  chatReplies: z.array(CodexReply).default(() => []),
  hooks: z.enum(['untrusted', 'trusted', 'disabled', 'unlisted']).default('untrusted'),
})
export type CodexScenario = z.input<typeof CodexScenario>

export const FakeCommand = z.enum([
  'print',
  'auth_status',
  'exec',
  'login_status',
  'debug_models',
  'version',
  'plugin',
  'app_server',
  'unknown',
])
export type FakeCommand = z.infer<typeof FakeCommand>

export const FakePurpose = z.enum(['observer', 'chat'])
export type FakePurpose = z.infer<typeof FakePurpose>

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
  purpose: FakePurpose.nullable(),
  reply: z.int().nonnegative().nullable(),
  violations: z.array(z.string()),
})
export type FakeCall = z.infer<typeof FakeCall>
