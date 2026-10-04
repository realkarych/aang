import { existsSync } from 'node:fs'
import { admissionHookPath, claudeAdmissionArtifacts, runAdmissionHook } from './admission.js'
import { randomUUID } from 'node:crypto'
import { startDescendant } from './process-tree.js'
import { resolve } from 'node:path'
import type { JsonValue } from '@aang/contract'
import type { z } from 'zod'
import {
  answerEvents,
  defaultClaudeUsage,
  errorResultEvent,
  hookEvents,
  initEvent,
  rateLimitEvent,
  textResultEvent,
  type ClaudeSession,
} from './claude-events.js'
import { emulatePluginCommand } from './claude-plugin.js'
import { claudeOptions, claudeViolations } from './claude-profile.js'
import { emit, finish, hang, parseJson, readStdin, say, tryReadText, type TextRead } from './io.js'
import { lastValue, parseOptions, type ParsedOptions } from './options.js'
import { invocation, purposeOf, runEntry } from './invocation.js'
import { isolationMessage, scenarioMessage } from './profile.js'
import { answerOutput } from './reply.js'
import { ClaudeScenario, fakeCliExitCodes } from './scenario.js'
import { readScenario } from './state.js'
import { extractInput } from './template.js'

type Scenario = z.output<typeof ClaudeScenario>
type Reply = Scenario['replies'][number]

const startedAt = performance.now()
const { state, argv, record, nextReply, missingReply } = invocation('claude')

const authStatus = (scenario: Scenario): void => {
  record('auth_status')
  emit({ loggedIn: scenario.loggedIn, authMethod: scenario.loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty' })
  finish(scenario.loggedIn ? 0 : 1)
}

const version = (scenario: Scenario): void => {
  record('version')
  say(process.stdout, `${scenario.version} (Claude Code)`)
  finish(0)
}

const systemPrompt = (options: ParsedOptions): TextRead | undefined => {
  const file = lastValue(options, 'system-prompt-file')
  const fromFile = file === undefined ? undefined : tryReadText(file)
  const inline = lastValue(options, 'system-prompt')
  return fromFile?.ok === false || inline === undefined ? fromFile : { ok: true, text: inline }
}

const unreadableSystemPrompt = (options: ParsedOptions, prompt: TextRead | undefined): string | null => {
  if (prompt === undefined || prompt.ok) {
    return null
  }
  return prompt.missing
    ? `Error: System prompt file not found: ${resolve(lastValue(options, 'system-prompt-file') ?? '')}`
    : `Error reading system prompt file: ${prompt.message}`
}

const limitMessage = (resetsAt: number | undefined): string =>
  resetsAt === undefined
    ? "You've hit your limit"
    : `You've hit your limit · resets ${new Date(resetsAt * 1000).toISOString()}`

const respond = (session: ClaudeSession, reply: Reply, input: JsonValue | undefined): void => {
  hookEvents(session).forEach(emit)
  switch (reply.kind) {
    case 'answer':
    case 'script': {
      const output = answerOutput(reply, input)
      emit(initEvent(session))
      answerEvents(session, output, reply.usage ?? defaultClaudeUsage).forEach(emit)
      finish(0)
      return
    }
    case 'auth':
      emit(initEvent(session))
      emit(errorResultEvent(session, 'Not logged in · Please run /login', null))
      finish(1)
      return
    case 'limit':
      emit(initEvent(session))
      emit(rateLimitEvent(session, 'rejected', reply.resetsAt))
      emit(errorResultEvent(session, limitMessage(reply.resetsAt), 429))
      finish(1)
      return
    case 'timeout':
      emit(initEvent(session))
      hang()
      return
    case 'network':
      emit(initEvent(session))
      emit(errorResultEvent(session, 'API Error: Connection error.', null))
      finish(1)
      return
    case 'invalid_json':
      emit(initEvent(session))
      emit(textResultEvent(session, reply.text, defaultClaudeUsage))
      finish(0)
  }
}

const print = async (scenario: Scenario, options: ParsedOptions): Promise<void> => {
  const prompt = options.positionals[0] ?? (await readStdin())
  const input = extractInput(prompt)
  const purpose = purposeOf(input)
  const instructions = systemPrompt(options)
  const unreadable = unreadableSystemPrompt(options, instructions)
  const admission = existsSync(admissionHookPath('claude'))
  const violations = claudeViolations({ options, systemPrompt: instructions, env: process.env }).filter((violation) => !admission || violation !== '--setting-sources ""')
  const streamWithoutVerbose = lastValue(options, 'output-format') === 'stream-json' && !options.flags.has('verbose')
  const reachesModel = unreadable === null && violations.length === 0 && !streamWithoutVerbose && scenario.loggedIn
  const { index, reply } = admission ? { index: null, reply: { kind: 'answer', output: { base_version: 0, ops: [], needs: [] } } as Reply } : reachesModel ? nextReply(purpose === 'chat' ? scenario.chatReplies : scenario.replies, purpose) : { index: null, reply: undefined }
  record('print', {
    prompt,
    systemPrompt: instructions?.ok === true ? instructions.text : null,
    schema: parseJson(lastValue(options, 'json-schema')) ?? null,
    purpose,
    reply: index,
    violations,
  })
  if (unreadable !== null) {
    say(process.stderr, unreadable)
    finish(1)
    return
  }
  if (streamWithoutVerbose) {
    say(process.stderr, 'Error: When using --print, --output-format=stream-json requires --verbose')
    finish(1)
    return
  }
  if (violations.length > 0) {
    say(process.stderr, isolationMessage('claude', violations))
    finish(fakeCliExitCodes.isolation)
    return
  }
  const session: ClaudeSession = {
    sessionId: lastValue(options, 'session-id') ?? randomUUID(),
    model: lastValue(options, 'model') ?? '',
    version: scenario.version,
    cwd: process.cwd(),
    tools: ['StructuredOutput', ...scenario.leakedTools],
    plugins: scenario.builtinPlugins,
    userPlugins: scenario.userPlugins,
    mcpServers: scenario.pluginMcpServers,
    hooks: options.flags.has('include-hook-events') ? scenario.pluginHooks.map(() => 'SessionStart:startup') : [],
    permissionMode: lastValue(options, 'permission-mode') ?? 'default',
    startedAt,
  }
  if (!scenario.loggedIn) {
    respond(session, { kind: 'auth' }, input)
    return
  }
  if (reply === undefined) {
    missingReply(index)
    return
  }
  if (admission) {
    const cleanup = await claudeAdmissionArtifacts(session.sessionId, scenario.admissionFault)
    try {
      const controlled = runAdmissionHook('claude', options, scenario.admissionFault) && options.flags.has('include-hook-events')
      respond(controlled ? { ...session, hooks: [...session.hooks, 'SessionStart:startup'] } : session, reply, input)
    } finally { cleanup() }
    return
  }
  await startDescendant(scenario.descendant)
  respond(session, reply, input)
}

const isVersion = (argument: string | undefined): boolean => argument === '--version' || argument === '-v'

const isPlugin = (argument: string | undefined): boolean => argument === 'plugin' || argument === 'plugins'

const main = async (): Promise<void> => {
  const scenario = readScenario(state, ClaudeScenario)
  if (isPlugin(argv[0])) {
    record('plugin')
    await startDescendant(scenario.pluginDescendant)
    if (scenario.pluginHang) {
      hang()
      return
    }
    emulatePluginCommand(state, argv.slice(1), scenario.pluginFailures)
    return
  }
  if (argv[0] === 'auth' && argv[1] === 'status') {
    authStatus(scenario)
    return
  }
  if (argv.length === 1 && isVersion(argv[0])) {
    version(scenario)
    return
  }
  const parsed = parseOptions(argv, claudeOptions)
  if (!parsed.ok) {
    record('unknown')
    say(
      process.stderr,
      parsed.problem === 'unknown'
        ? `error: unknown option '${parsed.argument}'`
        : `error: option '${parsed.argument} <value>' argument missing`,
    )
    finish(1)
    return
  }
  if (!parsed.options.flags.has('print')) {
    record('unknown')
    say(process.stderr, scenarioMessage('claude', 'only -p, plugin, auth status and --version are emulated'))
    finish(fakeCliExitCodes.scenario)
    return
  }
  await print(scenario, parsed.options)
}

await runEntry('claude', main)
