import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { JsonValue } from '@aang/contract'
import type { z } from 'zod'
import { bundledCatalog } from './codex-catalog.js'
import { catalogEntry, codexExecOptions, codexViolations, readCatalog } from './codex-profile.js'
import { emit, finish, hang, parseJson, readStdin, readText, say } from './io.js'
import { allValues, lastValue, parseOptions, type ParsedOptions } from './options.js'
import { invocation, runEntry } from './invocation.js'
import { isolationMessage } from './profile.js'
import { converse, type ResponsesRequest } from './responses.js'
import { CodexScenario, fakeCliExitCodes, type CodexUsage } from './scenario.js'
import { readScenario } from './state.js'
import { configOverrides, configValue } from './toml.js'
import { extractInput, renderTemplate } from './template.js'

type Scenario = z.output<typeof CodexScenario>
type Reply = Scenario['replies'][number]
type JsonObject = { readonly [key: string]: JsonValue }

interface Turn {
  readonly threadId: string
  readonly lastMessage: string | undefined
}

const { state, argv, record, nextReply, missingReply } = invocation('codex')

const defaultCodexUsage: CodexUsage = {
  inputTokens: 1531,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 463,
  reasoningOutputTokens: 0,
}

const unauthorized =
  'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses'

const usageJson = (usage: CodexUsage): JsonValue => ({
  input_tokens: usage.inputTokens,
  cached_input_tokens: usage.cachedInputTokens,
  cache_write_input_tokens: usage.cacheWriteInputTokens,
  output_tokens: usage.outputTokens,
  reasoning_output_tokens: usage.reasoningOutputTokens,
})

const routerError = (message: string): void => {
  say(process.stderr, `${new Date().toISOString()} ERROR codex_core::tools::router: error=${message}`)
}

const startTurn = (turn: Turn): void => {
  emit({ type: 'thread.started', thread_id: turn.threadId })
  emit({ type: 'turn.started' })
}

const completeTurn = (turn: Turn, text: string, usage: CodexUsage): void => {
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } })
  emit({ type: 'turn.completed', usage: usageJson(usage) })
  if (turn.lastMessage !== undefined) {
    writeFileSync(turn.lastMessage, text)
  }
  finish(0)
}

const failTurn = (message: string): void => {
  emit({ type: 'error', message })
  emit({ type: 'turn.failed', error: { message } })
  finish(1)
}

const limitMessage = (resetsAt: number | undefined): string =>
  `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again ${
    resetsAt === undefined ? 'later' : `at ${new Date(resetsAt * 1000).toISOString()}`
  }.`

const respond = (turn: Turn, reply: Reply, prompt: string): void => {
  switch (reply.kind) {
    case 'answer': {
      const output = renderTemplate(reply.output, extractInput(prompt))
      startTurn(turn)
      reply.toolAttempts.forEach((tool) => {
        routerError(`unsupported call: ${tool}`)
      })
      completeTurn(turn, JSON.stringify(output), reply.usage ?? defaultCodexUsage)
      return
    }
    case 'auth':
      startTurn(turn)
      emit({ type: 'error', message: `Reconnecting... 1/5 (${unauthorized})` })
      failTurn(unauthorized)
      return
    case 'limit':
      startTurn(turn)
      failTurn(limitMessage(reply.resetsAt))
      return
    case 'timeout':
      startTurn(turn)
      hang()
      return
    case 'invalid_json':
      startTurn(turn)
      completeTurn(turn, reply.text, defaultCodexUsage)
  }
}

const tool = (name: string): JsonValue => {
  const separator = name.indexOf('/')
  return {
    type: 'function',
    name: name.slice(separator + 1),
    ...(separator === -1 ? {} : { namespace: name.slice(0, separator) }),
    description: '',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }
}

const message = (role: string, text: string): JsonValue => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text }],
})

interface MockCall {
  readonly url: string
  readonly options: ParsedOptions
  readonly scenario: Scenario
  readonly entry: JsonObject | undefined
  readonly instructions: string | null
  readonly schema: JsonValue | null
  readonly prompt: string
  readonly turn: Turn
}

const mockRequest = (call: MockCall, config: JsonValue): ResponsesRequest => {
  const model = lastValue(call.options, 'model') ?? ''
  const originator = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? 'codex_exec'
  const effort = configValue(config, 'model_reasoning_effort') ?? call.entry?.default_reasoning_level ?? 'low'
  const tools = call.scenario.leakedTools.map(tool)
  const lite = call.entry?.use_responses_lite === true
  const metadata = {
    session_id: call.turn.threadId,
    thread_id: call.turn.threadId,
    agent_name: '/root',
    turn_id: randomUUID(),
    thread_source: lastValue(call.options, 'thread-source') ?? 'user',
    turn_trigger: 'exec',
    sandbox_mode: lastValue(call.options, 'sandbox') ?? 'read-only',
    model,
    reasoning_effort: effort,
  }
  return {
    url: call.url,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator,
      'user-agent': `${originator}/${call.scenario.version} (fake-cli)`,
      'session-id': call.turn.threadId,
      'x-codex-turn-metadata': JSON.stringify(metadata),
      ...(lite ? { 'x-openai-internal-codex-responses-lite': 'true' } : {}),
    },
    body: {
      model,
      ...(lite ? {} : { tools }),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort, context: 'all_turns' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: call.turn.threadId,
      text: {
        verbosity: 'low',
        format: { type: 'json_schema', strict: true, schema: call.schema, name: 'codex_output_schema' },
      },
      client_metadata: metadata,
    },
    input: [
      ...(lite ? [{ type: 'additional_tools', id: `at_${randomUUID()}`, role: 'developer', tools }] : []),
      message(
        'developer',
        call.instructions ?? (typeof call.entry?.base_instructions === 'string' ? call.entry.base_instructions : ''),
      ),
      message('user', call.prompt),
    ],
  }
}

const providerUrl = (config: JsonValue): { url: string | undefined; provider: string | undefined } => {
  const provider = configValue(config, 'model_provider')
  if (typeof provider !== 'string' || provider === 'openai') {
    return { url: undefined, provider: undefined }
  }
  const baseUrl = configValue(config, `model_providers.${provider}.base_url`)
  return { url: typeof baseUrl === 'string' ? `${baseUrl.replace(/\/+$/, '')}/responses` : undefined, provider }
}

const runMock = async (call: MockCall, config: JsonValue): Promise<void> => {
  startTurn(call.turn)
  const outcome = await converse(mockRequest(call, config))
  outcome.attempts.forEach(routerError)
  if (outcome.failure !== null) {
    failTurn(outcome.failure)
    return
  }
  completeTurn(call.turn, outcome.text ?? '', outcome.usage)
}

const exec = async (scenario: Scenario, options: ParsedOptions): Promise<void> => {
  const positional = options.positionals[0]
  const prompt = positional === undefined || positional === '-' ? await readStdin() : positional
  const config = configOverrides(allValues(options, 'config'))
  const catalog = readCatalog(config, process.cwd())
  const violations = codexViolations({ options, config, catalog, env: process.env })
  const { url, provider } = providerUrl(config)
  const mock = provider !== undefined
  const reachesModel = violations.length === 0 && (mock || scenario.loggedIn)
  const { index, reply } = reachesModel && !mock ? nextReply(scenario.replies) : { index: null, reply: undefined }
  const instructionsFile = configValue(config, 'model_instructions_file')
  const instructions = typeof instructionsFile === 'string' ? (readText(instructionsFile) ?? null) : null
  const schemaFile = lastValue(options, 'output-schema')
  const schema = parseJson(schemaFile === undefined ? undefined : readText(schemaFile)) ?? null
  record('exec', { prompt, systemPrompt: instructions, schema, reply: index, violations })
  if (violations.length > 0) {
    say(process.stderr, isolationMessage('codex', violations))
    finish(fakeCliExitCodes.isolation)
    return
  }
  const lastMessage = lastValue(options, 'output-last-message')
  const turn: Turn = {
    threadId: randomUUID(),
    lastMessage: lastMessage === undefined ? undefined : resolve(lastMessage),
  }
  if (mock) {
    if (url === undefined) {
      say(process.stderr, `Error: Model provider \`${provider}\` not found`)
      finish(1)
      return
    }
    const entry = catalogEntry({ options, catalog })
    await runMock({ url, options, scenario, entry, instructions, schema, prompt, turn }, config)
    return
  }
  if (!scenario.loggedIn) {
    respond(turn, { kind: 'auth' }, prompt)
    return
  }
  if (reply === undefined) {
    missingReply(index)
    return
  }
  respond(turn, reply, prompt)
}

const loginStatus = (scenario: Scenario): void => {
  record('login_status')
  say(process.stderr, scenario.loggedIn ? 'Logged in using ChatGPT' : 'Not logged in')
  finish(scenario.loggedIn ? 0 : 1)
}

const debugModels = (): void => {
  record('debug_models')
  say(process.stdout, JSON.stringify(bundledCatalog()))
  finish(0)
}

const version = (scenario: Scenario): void => {
  record('version')
  say(process.stdout, `codex-cli ${scenario.version}`)
  finish(0)
}

const usageError = (message: string): void => {
  record('unknown')
  say(process.stderr, `error: ${message}\n\nUsage: codex exec [OPTIONS] [PROMPT]`)
  finish(2)
}

const main = async (): Promise<void> => {
  const scenario = readScenario(state, CodexScenario)
  const [command, subcommand, ...rest] = argv
  if (argv.length === 1 && (command === '--version' || command === '-V')) {
    version(scenario)
    return
  }
  if (command === 'login' && subcommand === 'status') {
    loginStatus(scenario)
    return
  }
  if (command === 'debug' && subcommand === 'models' && rest.every((argument) => argument === '--bundled')) {
    debugModels()
    return
  }
  if (command !== 'exec') {
    usageError(`unrecognized subcommand '${command ?? ''}'`)
    return
  }
  const parsed = parseOptions(argv.slice(1), codexExecOptions)
  if (!parsed.ok) {
    usageError(
      parsed.problem === 'unknown'
        ? `unexpected argument '${parsed.argument}' found`
        : `a value is required for '${parsed.argument} <VALUE>' but none was supplied`,
    )
    return
  }
  await exec(scenario, parsed.options)
}

await runEntry('codex', main)
