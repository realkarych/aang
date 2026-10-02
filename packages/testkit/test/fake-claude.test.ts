import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { observerOutputJsonSchema, ObserverOutput } from '@aang/contract'
import { fakeCliExitCodes, installFakeClaude, type ClaudeScenario, type FakeCli } from '@aang/testkit'
import { describe, expect, test } from 'vitest'
import {
  cleanEnvironment,
  createWorkspace,
  runFake,
  startFake,
  waitFor,
  type Event,
  type Workspace,
} from './fake-process.js'
import { briefTemplate, factIds, modelVersion, observerPrompt, systemPrompt } from './observer-batch.js'
import { keysOf, readSample, readSampleLines } from './samples.js'

interface ProfilePart {
  readonly id: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

const markersOf = (parts: readonly ProfilePart[]): Record<string, string> =>
  parts.reduce<Record<string, string>>((markers, part) => ({ ...markers, ...part.env }), {})

const model = 'claude-opus-5-5'
const schema = JSON.stringify(observerOutputJsonSchema())

const systemPromptPart = '--system-prompt or --system-prompt-file'

const isolationProfile = (systemPromptFile: string): ProfilePart[] => [
  { id: '--output-format stream-json', args: ['--output-format', 'stream-json'] },
  { id: '--json-schema', args: ['--json-schema', schema] },
  { id: '--model', args: ['--model', model] },
  { id: '--setting-sources ""', args: ['--setting-sources', ''] },
  { id: '--strict-mcp-config', args: ['--strict-mcp-config'] },
  { id: '--mcp-config {"mcpServers":{}}', args: ['--mcp-config', '{"mcpServers":{}}'] },
  { id: '--tools ""', args: ['--tools', ''] },
  { id: '--disallowedTools mcp__*', args: ['--disallowedTools', 'mcp__*'] },
  { id: '--disable-slash-commands', args: ['--disable-slash-commands'] },
  { id: systemPromptPart, args: ['--system-prompt-file', systemPromptFile] },
  { id: '--no-session-persistence', args: ['--no-session-persistence'] },
  { id: '--permission-mode dontAsk', args: ['--permission-mode', 'dontAsk'] },
  { id: '--settings {"crossSessionInbound":"hold"}', args: ['--settings', '{"crossSessionInbound":"hold"}'] },
  { id: 'CLAUDE_CODE_ENTRYPOINT=aang-observer', env: { CLAUDE_CODE_ENTRYPOINT: 'aang-observer' } },
  { id: 'AANG_OBSERVER=1', env: { AANG_OBSERVER: '1' } },
  { id: 'CLAUDE_CODE_DISABLE_CLAUDE_MDS=1', env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } },
  { id: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1', env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } },
  { id: 'ENABLE_CLAUDEAI_MCP_SERVERS=false', env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } },
  { id: 'DISABLE_TELEMETRY=1', env: { DISABLE_TELEMETRY: '1' } },
  { id: 'DISABLE_ERROR_REPORTING=1', env: { DISABLE_ERROR_REPORTING: '1' } },
  { id: 'DISABLE_AUTOUPDATER=1', env: { DISABLE_AUTOUPDATER: '1' } },
]

interface Observer {
  readonly workspace: Workspace
  readonly fake: FakeCli<ClaudeScenario>
  readonly sessionId: string
  readonly profile: ProfilePart[]
  readonly args: (parts?: readonly ProfilePart[]) => string[]
  readonly env: (parts?: readonly ProfilePart[]) => Record<string, string>
  readonly call: (parts?: readonly ProfilePart[], prompt?: string) => ReturnType<typeof runFake>
}

const setUp = async (
  onTestFinished: (cleanup: () => Promise<void> | void) => void,
  scenario: ClaudeScenario,
): Promise<Observer> => {
  const workspace = await createWorkspace(onTestFinished)
  const fake = installFakeClaude(join(workspace.root, 'fakes'), scenario)
  const sessionId = randomUUID()
  const systemPromptFile = join(workspace.root, 'observer-system.md')
  writeFileSync(systemPromptFile, systemPrompt)
  const profile = isolationProfile(systemPromptFile)
  const args = (parts: readonly ProfilePart[] = profile): string[] => [
    '-p',
    '--verbose',
    '--session-id',
    sessionId,
    ...parts.flatMap((part) => part.args ?? []),
  ]
  const env = (parts: readonly ProfilePart[] = profile): Record<string, string> =>
    cleanEnvironment(workspace.home, markersOf(parts))
  return {
    workspace,
    fake,
    sessionId,
    profile,
    args,
    env,
    call: (parts = profile, prompt = observerPrompt()) =>
      runFake(fake, args(parts), { env: env(parts), cwd: workspace.cwd, stdin: prompt }),
  }
}

const answer = (text: string) => ({ kind: 'answer' as const, output: briefTemplate(text) })

const resultOf = (events: readonly Event[]): Event | undefined => events.find((event) => event.type === 'result')

const briefOf = (events: readonly Event[]): string | undefined => {
  const output = ObserverOutput.parse(resultOf(events)?.structured_output)
  const [operation] = output.ops
  return operation?.op === 'brief.update' ? operation.text : undefined
}

describe('fake claude answers like claude -p in the observer profile (F.1)', () => {
  test('a successful call streams init and result in the format of the real CLI and cites the input', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Тесты зелёные')] })

    const exit = await observer.call()

    expect({ code: exit.code, stderr: exit.stderr }).toEqual({ code: 0, stderr: '' })
    expect(exit.events.map((event) => [event.type, event.subtype])).toEqual([
      ['system', 'init'],
      ['system', 'thinking_tokens'],
      ['system', 'thinking_tokens'],
      ['assistant', undefined],
      ['assistant', undefined],
      ['user', undefined],
      ['rate_limit_event', undefined],
      ['result', 'success'],
    ])
    expect(exit.events[0]).toMatchObject({
      cwd: observer.workspace.cwd,
      session_id: observer.sessionId,
      tools: ['StructuredOutput'],
      mcp_servers: [],
      skills: [],
      model,
      permissionMode: 'dontAsk',
      claude_code_version: '2.1.286',
    })
    const result = resultOf(exit.events)
    expect(result).toMatchObject({ is_error: false, terminal_reason: 'completed', session_id: observer.sessionId })
    const output = ObserverOutput.parse(result?.structured_output)
    expect(output).toEqual({
      base_version: modelVersion,
      ops: [
        {
          op: 'brief.update',
          text: 'Тесты зелёные',
          evidence: factIds,
          rationale: 'Сводка по фактам порции',
        },
      ],
      needs: [],
    })
    expect(JSON.parse(String(result?.result))).toEqual(output)
    expect(result?.usage).toMatchObject({ input_tokens: 2, output_tokens: 872 })
  })

  test('init, stream events and result carry the fields of the recorded observer stream', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Готово')] })
    const stream = readSampleLines('claude-stream-b-full-isolation.jsonl')
    const recordedResult = readSample('claude-result-b-full-isolation.json')

    const { events } = await observer.call()

    expect(events.map((event) => [event.type, event.subtype])).toEqual([
      ['system', 'init'],
      ...stream.map((event) => [event.type, event.subtype]),
      ['result', 'success'],
    ])
    expect(events.map(keysOf)).toEqual([
      keysOf(readSample('claude-init-b-full-isolation.json')),
      ...stream.map(keysOf),
      keysOf(recordedResult),
    ])
    expect(keysOf(resultOf(events)?.usage)).toEqual(keysOf(recordedResult.usage))
    expect(events.slice(3, 5).map((event) => keysOf(event.message))).toEqual(
      stream.slice(2, 4).map((event) => keysOf(event.message)),
    )
  })

  test('every call is recorded with argv, working directory, environment, prompt, system prompt and schema', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Готово')] })
    const prompt = observerPrompt()

    await observer.call(observer.profile, prompt)

    expect(observer.fake.calls()).toEqual([
      {
        sequence: 1,
        runtime: 'claude',
        command: 'print',
        argv: observer.args(),
        cwd: observer.workspace.cwd,
        env: expect.objectContaining({ CLAUDE_CODE_ENTRYPOINT: 'aang-observer', AANG_OBSERVER: '1' }) as unknown,
        pid: expect.any(Number) as unknown,
        prompt,
        systemPrompt,
        schema: JSON.parse(schema) as unknown,
        reply: 0,
        violations: [],
      },
    ])
  })

  test.for(isolationProfile('observer-system.md').map((part) => part.id))(
    'without %s the call fails before reaching the model',
    async (id, { onTestFinished }) => {
      const observer = await setUp(onTestFinished, { replies: [answer('Не должно появиться')] })

      const exit = await observer.call(observer.profile.filter((part) => part.id !== id))

      expect(exit.code).toBe(fakeCliExitCodes.isolation)
      expect(exit.stdout).toBe('')
      expect(exit.stderr).toContain(id)
      expect(observer.fake.calls().map((call) => [call.violations, call.reply])).toEqual([[[id], null]])
    },
  )

  test.for([
    { id: '--setting-sources ""', args: ['--setting-sources', 'project'] },
    { id: '--mcp-config {"mcpServers":{}}', args: ['--mcp-config', '{"mcpServers":{"github":{"command":"gh"}}}'] },
    { id: '--tools ""', args: ['--tools', 'Bash'] },
    { id: '--permission-mode dontAsk', args: ['--permission-mode', 'default'] },
    { id: '--settings {"crossSessionInbound":"hold"}', args: ['--settings', '{"crossSessionInbound":"accept"}'] },
    { id: systemPromptPart, args: ['--system-prompt', ''] },
    { id: 'CLAUDE_CODE_ENTRYPOINT=aang-observer', env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } },
  ])('a weakened $id is a violation too', async (weakened, { onTestFinished }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Не должно появиться')] })

    const exit = await observer.call(observer.profile.map((part) => (part.id === weakened.id ? { ...weakened } : part)))

    expect(exit.code).toBe(fakeCliExitCodes.isolation)
    expect(observer.fake.calls().map((call) => call.violations)).toEqual([[weakened.id]])
  })

  test('an inline --system-prompt replaces the default prompt like the file does', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Готово')] })

    const exit = await observer.call(
      observer.profile.map((part) =>
        part.id === systemPromptPart ? { ...part, args: ['--system-prompt', systemPrompt] } : part,
      ),
    )

    expect([exit.code, briefOf(exit.events)]).toEqual([0, 'Готово'])
    expect(observer.fake.calls().map((call) => [call.systemPrompt, call.violations])).toEqual([[systemPrompt, []]])
  })

  test('an unreadable system prompt file fails like the real CLI without taking a reply', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('После исправления')] })
    const withPromptFile = (path: string) =>
      observer.profile.map((part) =>
        part.id === systemPromptPart ? { ...part, args: ['--system-prompt-file', path] } : part,
      )
    const missingFile = join(observer.workspace.root, 'missing-system.md')

    const missing = await observer.call(withPromptFile(missingFile))
    const directory = await observer.call(withPromptFile(observer.workspace.home))
    const fixed = await observer.call()

    expect([missing.code, missing.stdout, missing.stderr.trim()]).toEqual([
      1,
      '',
      `Error: System prompt file not found: ${missingFile}`,
    ])
    expect([directory.code, directory.stdout]).toEqual([1, ''])
    expect(directory.stderr).toMatch(/^Error reading system prompt file: /)
    expect([fixed.code, briefOf(fixed.events)]).toEqual([0, 'После исправления'])
    expect(observer.fake.calls().map((call) => [call.systemPrompt, call.reply])).toEqual([
      [null, null],
      [null, null],
      [systemPrompt, 0],
    ])
  })

  test('a CLI version that leaks tools lists them in init', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {
      leakedTools: ['Bash', 'mcp__github__create_issue'],
      replies: [answer('Готово')],
    })

    const exit = await observer.call()

    expect(exit.code).toBe(0)
    expect(exit.events[0]).toMatchObject({ tools: ['StructuredOutput', 'Bash', 'mcp__github__create_issue'] })
  })

  test('replies follow the call order and the last one repeats', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {
      replies: [{ kind: 'limit' }, answer('Первый'), answer('Второй')],
    })

    const exits = []
    for (let call = 0; call < 4; call += 1) {
      exits.push(await observer.call())
    }

    expect(exits.map((exit) => [exit.code, resultOf(exit.events)?.is_error])).toEqual([
      [1, true],
      [0, false],
      [0, false],
      [0, false],
    ])
    expect(exits.slice(1).map((exit) => briefOf(exit.events))).toEqual(['Первый', 'Второй', 'Второй'])
    expect(observer.fake.calls().map((call) => call.reply)).toEqual([0, 1, 2, 3])
  })

  test('a new scenario starts from its first reply and keeps the call journal', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Первый')] })

    const before = await observer.call()
    observer.fake.setScenario({ replies: [{ kind: 'auth' }, answer('Второй')] })
    const refused = await observer.call()
    const answered = await observer.call()

    expect([before.code, briefOf(before.events)]).toEqual([0, 'Первый'])
    expect([refused.code, resultOf(refused.events)?.result]).toEqual([1, 'Not logged in · Please run /login'])
    expect([answered.code, briefOf(answered.events)]).toEqual([0, 'Второй'])
    expect(observer.fake.calls().map((call) => [call.sequence, call.reply])).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
    ])
  })

  test('parallel calls take distinct replies', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Первый'), answer('Второй')] })

    const exits = await Promise.all([observer.call(), observer.call()])

    expect(exits.map((exit) => briefOf(exit.events)).sort()).toEqual(['Второй', 'Первый'])
    expect(
      observer.fake
        .calls()
        .map((call) => call.reply)
        .sort(),
    ).toEqual([0, 1])
  })
})

describe('fake claude injects observer failures (F.1)', () => {
  test('an authorization failure reports success subtype with is_error and no structured output', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, { replies: [{ kind: 'auth' }] })

    const exit = await observer.call()

    expect(exit.code).toBe(1)
    expect(exit.events.map((event) => event.type)).toEqual(['system', 'result'])
    expect(resultOf(exit.events)).toMatchObject({
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      terminal_reason: 'api_error',
    })
    expect(keysOf(resultOf(exit.events))).toEqual(keysOf(readSample('claude-result-c-bare-no-auth.json')))
  })

  test('a logged-out CLI fails auth status and every call until it is logged in again', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { loggedIn: false, replies: [answer('После входа')] })
    const authStatus = () =>
      runFake(observer.fake, ['auth', 'status'], { env: observer.env(), cwd: observer.workspace.cwd })

    const loggedOut = await authStatus()
    const refused = await observer.call()
    observer.fake.setScenario({ loggedIn: true, replies: [answer('После входа')] })
    const loggedIn = await authStatus()
    const answered = await observer.call()

    expect([loggedOut.code, loggedOut.events]).toEqual([1, [expect.objectContaining({ loggedIn: false })]])
    expect([refused.code, resultOf(refused.events)?.result]).toEqual([1, 'Not logged in · Please run /login'])
    expect([loggedIn.code, loggedIn.events]).toEqual([0, [expect.objectContaining({ loggedIn: true })]])
    expect([answered.code, briefOf(answered.events)]).toEqual([0, 'После входа'])
    expect(observer.fake.calls().map((call) => [call.command, call.reply])).toEqual([
      ['auth_status', null],
      ['print', null],
      ['auth_status', null],
      ['print', 0],
    ])
  })

  test('a subscription limit reports the reset time in a rejected rate limit event', async ({ onTestFinished }) => {
    const resetsAt = 1_790_900_000
    const observer = await setUp(onTestFinished, { replies: [{ kind: 'limit', resetsAt }, { kind: 'limit' }] })

    const withReset = await observer.call()
    const withoutReset = await observer.call()

    expect(withReset.code).toBe(1)
    expect(withReset.events.map((event) => event.type)).toEqual(['system', 'rate_limit_event', 'result'])
    expect(withReset.events[1]).toMatchObject({ rate_limit_info: { status: 'rejected', resetsAt } })
    expect(resultOf(withReset.events)).toMatchObject({ is_error: true, api_error_status: 429 })
    expect(withoutReset.events[1]).toMatchObject({ rate_limit_info: { status: 'rejected' } })
    expect(withoutReset.events[1]?.rate_limit_info).not.toHaveProperty('resetsAt')
  })

  test('invalid JSON output comes as a successful result without structured output', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {
      replies: [{ kind: 'invalid_json', text: '{"base_version": 7, "ops": [' }],
    })

    const exit = await observer.call()

    expect(exit.code).toBe(0)
    const result = resultOf(exit.events)
    expect(result).toMatchObject({ subtype: 'success', is_error: false, result: '{"base_version": 7, "ops": [' })
    expect(result).not.toHaveProperty('structured_output')
  })

  test('a timeout keeps the CLI running after init until it is killed', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { replies: [{ kind: 'timeout' }] })
    const running = startFake(observer.fake, observer.args(), {
      env: observer.env(),
      cwd: observer.workspace.cwd,
      stdin: observerPrompt(),
    })

    await waitFor(() => running.events().length > 0)
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    expect(running.alive()).toBe(true)
    expect(running.events().map((event) => event.subtype)).toEqual(['init'])
    const exit = await running.kill()
    expect(resultOf(exit.events)).toBeUndefined()
  })
})

describe('fake claude behaves like the real CLI outside the model call (F.1)', () => {
  test('--version prints the scenario version', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { version: '2.1.290' })

    const exit = await runFake(observer.fake, ['--version'], { env: observer.env(), cwd: observer.workspace.cwd })

    expect([exit.code, exit.stdout.trim()]).toEqual([0, '2.1.290 (Claude Code)'])
  })

  test('stream-json without --verbose fails with the error of the real CLI', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Не должно появиться')] })

    const exit = await runFake(
      observer.fake,
      observer.args().filter((argument) => argument !== '--verbose'),
      { env: observer.env(), cwd: observer.workspace.cwd, stdin: observerPrompt() },
    )

    expect([exit.code, exit.stdout, exit.stderr.trim()]).toEqual([
      1,
      '',
      'Error: When using --print, --output-format=stream-json requires --verbose',
    ])
  })

  test('an unknown option fails with the error of the real CLI', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {})

    const exit = await runFake(observer.fake, ['-p', '--bogus'], { env: observer.env(), cwd: observer.workspace.cwd })

    expect([exit.code, exit.stderr.trim()]).toEqual([1, "error: unknown option '--bogus'"])
  })

  test('a template pointer that the input does not resolve is a scenario error', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {
      replies: [{ kind: 'answer', output: { base_version: { $input: '/model/missing' } } }],
    })

    const exit = await observer.call()

    expect(exit.code).toBe(fakeCliExitCodes.scenario)
    expect(exit.stdout).toBe('')
    expect(exit.stderr).toContain('/model/missing')
  })
})
