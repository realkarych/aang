import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import {
  answerEvents,
  defaultClaudeUsage,
  errorResultEvent,
  initEvent,
  rateLimitEvent,
  textResultEvent,
  type ClaudeSession,
} from './claude-events.js'
import { claudeOptions, claudeViolations } from './claude-profile.js'
import { emit, finish, hang, parseJson, readStdin, readText, say } from './io.js'
import { lastValue, parseOptions, type ParsedOptions } from './options.js'
import { invocation, runEntry } from './invocation.js'
import { isolationMessage, scenarioMessage } from './profile.js'
import { ClaudeScenario, fakeCliExitCodes } from './scenario.js'
import { readScenario } from './state.js'
import { extractInput, renderTemplate } from './template.js'

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

const systemPrompt = (options: ParsedOptions): string | null => {
  const file = lastValue(options, 'system-prompt-file')
  return lastValue(options, 'system-prompt') ?? (file === undefined ? undefined : readText(file)) ?? null
}

const limitMessage = (resetsAt: number | undefined): string =>
  resetsAt === undefined
    ? "You've hit your limit"
    : `You've hit your limit · resets ${new Date(resetsAt * 1000).toISOString()}`

const respond = (session: ClaudeSession, reply: Reply, prompt: string): void => {
  switch (reply.kind) {
    case 'answer': {
      const output = renderTemplate(reply.output, extractInput(prompt))
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
    case 'invalid_json':
      emit(initEvent(session))
      emit(textResultEvent(session, reply.text, defaultClaudeUsage))
      finish(0)
  }
}

const print = async (scenario: Scenario, options: ParsedOptions): Promise<void> => {
  const prompt = options.positionals[0] ?? (await readStdin())
  const violations = claudeViolations({ options, env: process.env })
  const streamWithoutVerbose = lastValue(options, 'output-format') === 'stream-json' && !options.flags.has('verbose')
  const reachesModel = violations.length === 0 && !streamWithoutVerbose && scenario.loggedIn
  const { index, reply } = reachesModel ? nextReply(scenario.replies) : { index: null, reply: undefined }
  record('print', {
    prompt,
    systemPrompt: systemPrompt(options),
    schema: parseJson(lastValue(options, 'json-schema')) ?? null,
    reply: index,
    violations,
  })
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
    permissionMode: lastValue(options, 'permission-mode') ?? 'default',
    startedAt,
  }
  if (!scenario.loggedIn) {
    respond(session, { kind: 'auth' }, prompt)
    return
  }
  if (reply === undefined) {
    missingReply(index)
    return
  }
  respond(session, reply, prompt)
}

const isVersion = (argument: string | undefined): boolean => argument === '--version' || argument === '-v'

const main = async (): Promise<void> => {
  const scenario = readScenario(state, ClaudeScenario)
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
    say(process.stderr, scenarioMessage('claude', 'only -p, auth status and --version are emulated'))
    finish(fakeCliExitCodes.scenario)
    return
  }
  await print(scenario, parsed.options)
}

await runEntry('claude', main)
