import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChatOutput, observerOutputJsonSchema, ObserverOutput } from '@aang/contract'
import { fakeCliExitCodes, installFakeCodex, type CodexScenario, type FakeCli } from '@aang/testkit'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  cleanEnvironment,
  createWorkspace,
  lines,
  runFake,
  startFake,
  waitFor,
  type Event,
  type Exit,
  type Workspace,
} from './fake-process.js'
import {
  briefTemplate,
  chatInput,
  factIds,
  modelVersion,
  observerPrompt,
  scenarioIds,
  scenarioInput,
  systemPrompt,
} from './observer-batch.js'
import { assistantMessage, startResponsesStub, stubUsage } from './responses-stub.js'
import { keysOf, readSample, readSampleLines } from './samples.js'

interface ProfilePart {
  readonly id: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

const markersOf = (parts: readonly ProfilePart[]): Record<string, string> =>
  parts.reduce<Record<string, string>>((markers, part) => ({ ...markers, ...part.env }), {})

const model = 'gpt-6.1-sol'

const tomlPath = (path: string): string => `"${path.replaceAll('\\', '/')}"`

const configSettings = [
  'include_environment_context=false',
  'include_permissions_instructions=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'project_doc_max_bytes=0',
  'web_search="disabled"',
  'skills.include_instructions=false',
  'analytics.enabled=false',
  'history.persistence="none"',
  'memories.generate_memories=false',
]

const disabledFeatures = [
  'hooks',
  'plugins',
  'apps',
  'multi_agent',
  'multi_agent_v2',
  'shell_tool',
  'unified_exec',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'view_image',
  'goals',
  'sleep_tool',
  'tool_suggest',
  'skill_search',
  'recommended_plugins',
]

interface ObserverFiles {
  readonly schema: string
  readonly lastMessage: string
  readonly catalog: string
  readonly bundledCatalog: string
  readonly instructions: string
}

const observerFiles = (directory: string): ObserverFiles => ({
  schema: join(directory, 'observer-schema.json'),
  lastMessage: join(directory, 'out', 'last.json'),
  catalog: join(directory, 'observer-models.json'),
  bundledCatalog: join(directory, 'bundled-models.json'),
  instructions: join(directory, 'observer-system.md'),
})

const isolationProfile = (files: ObserverFiles): ProfilePart[] => [
  { id: '--json', args: ['--json'] },
  { id: '-m', args: ['-m', model] },
  { id: '--output-schema', args: ['--output-schema', files.schema] },
  { id: '-o', args: ['-o', files.lastMessage] },
  { id: '--ephemeral', args: ['--ephemeral'] },
  { id: '--ignore-user-config', args: ['--ignore-user-config'] },
  { id: '--ignore-rules', args: ['--ignore-rules'] },
  { id: '--skip-git-repo-check', args: ['--skip-git-repo-check'] },
  { id: '-s read-only', args: ['-s', 'read-only'] },
  { id: '--thread-source aang-observer', args: ['--thread-source', 'aang-observer'] },
  { id: '-c model_catalog_json', args: ['-c', `model_catalog_json=${tomlPath(files.catalog)}`] },
  { id: '-c model_instructions_file', args: ['-c', `model_instructions_file=${tomlPath(files.instructions)}`] },
  {
    id: '-c tools.experimental_request_user_input={enabled=false}',
    args: ['-c', 'tools.experimental_request_user_input={enabled=false}'],
  },
  ...configSettings.map((setting) => ({ id: `-c ${setting}`, args: ['-c', setting] })),
  ...disabledFeatures.map((feature) => ({ id: `--disable ${feature}`, args: ['--disable', feature] })),
  {
    id: 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aang_observer',
    env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'aang_observer' },
  },
  { id: 'AANG_OBSERVER=1', env: { AANG_OBSERVER: '1' } },
]

const Catalog = z.strictObject({ models: z.array(z.looseObject({ slug: z.string() })) })

const observerCatalog = (bundled: z.infer<typeof Catalog>, slug: string) => ({
  models: bundled.models
    .filter((entry) => entry.slug === slug)
    .map((entry) => ({
      ...entry,
      tool_mode: null,
      multi_agent_version: null,
      apply_patch_tool_type: null,
      experimental_supported_tools: [],
    })),
})

interface Observer {
  readonly workspace: Workspace
  readonly fake: FakeCli<CodexScenario>
  readonly files: ObserverFiles
  readonly profile: ProfilePart[]
  readonly args: (parts?: readonly ProfilePart[], extra?: readonly string[]) => string[]
  readonly env: (parts?: readonly ProfilePart[], extra?: Readonly<Record<string, string>>) => Record<string, string>
  readonly call: (parts?: readonly ProfilePart[], prompt?: string) => Promise<Exit>
}

const setUp = async (
  onTestFinished: (cleanup: () => Promise<void> | void) => void,
  scenario: CodexScenario,
): Promise<Observer> => {
  const workspace = await createWorkspace(onTestFinished)
  const fake = installFakeCodex(join(workspace.root, 'fakes'), scenario)
  const directory = join(workspace.root, 'observer')
  mkdirSync(join(directory, 'out'), { recursive: true })
  const files = observerFiles(directory)
  const bundled = await runFake(fake, ['debug', 'models', '--bundled'], {
    env: cleanEnvironment(workspace.home, {}),
    cwd: workspace.cwd,
  })
  const catalog = Catalog.parse(JSON.parse(bundled.stdout))
  writeFileSync(
    files.bundledCatalog,
    JSON.stringify({ models: catalog.models.filter((entry) => entry.slug === model) }),
  )
  writeFileSync(files.catalog, JSON.stringify(observerCatalog(catalog, model)))
  writeFileSync(files.schema, JSON.stringify(observerOutputJsonSchema()))
  writeFileSync(files.instructions, systemPrompt)
  const profile = isolationProfile(files)
  const args = (parts: readonly ProfilePart[] = profile, extra: readonly string[] = []): string[] => [
    'exec',
    '-C',
    workspace.cwd,
    ...parts.flatMap((part) => part.args ?? []),
    ...extra,
    '-',
  ]
  const env = (parts: readonly ProfilePart[] = profile, extra: Readonly<Record<string, string>> = {}) =>
    cleanEnvironment(workspace.home, { ...markersOf(parts), ...extra })
  return {
    workspace,
    fake,
    files,
    profile,
    args,
    env,
    call: (parts = profile, prompt = observerPrompt()) =>
      runFake(fake, args(parts), { env: env(parts), cwd: workspace.cwd, stdin: prompt }),
  }
}

const answer = (text: string, toolAttempts: string[] = []) => ({
  kind: 'answer' as const,
  output: briefTemplate(text),
  toolAttempts,
})

const ofType = (events: readonly Event[], type: string): Event | undefined =>
  events.find((event) => event.type === type)

const agentText = (events: readonly Event[]): string => {
  const item = ofType(events, 'item.completed')?.item
  return typeof item === 'object' && item !== null && 'text' in item ? String(item.text) : ''
}

const routerLines = (stderr: string): string[] =>
  lines(stderr)
    .filter((line) => line.includes('codex_core::tools::router'))
    .map((line) => line.replace(/^\S+ /, '<TS> '))

describe('fake codex answers like codex exec --json in the observer profile (F.4)', () => {
  test('debug models --bundled prints a catalog whose entries have the fields and tools of the recorded one', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, {})
    const recorded = readSample('codex-observer-model-catalog.json')

    const exit = await runFake(observer.fake, ['debug', 'models', '--bundled'], {
      env: observer.env(),
      cwd: observer.workspace.cwd,
    })

    const entry = Catalog.parse(JSON.parse(exit.stdout)).models.find((candidate) => candidate.slug === model)
    expect(exit.code).toBe(0)
    expect(keysOf(entry)).toEqual(recorded.resulting_entry_keys)
    expect(entry).toMatchObject(recorded.bundled_values_before_patch as object)
  })

  test('a successful exec streams the events of the real CLI, writes -o and cites the input', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Тесты зелёные')] })
    const recorded = readSampleLines('codex-events-4-tools-off.jsonl')

    const exit = await observer.call()

    expect({ code: exit.code, stderr: exit.stderr }).toEqual({ code: 0, stderr: '' })
    expect(exit.events.map((event) => event.type)).toEqual(recorded.map((event) => event.type))
    expect(keysOf(ofType(exit.events, 'turn.completed')?.usage)).toEqual(keysOf(recorded.at(-1)?.usage))
    const text = agentText(exit.events)
    expect(readFileSync(observer.files.lastMessage, 'utf8')).toBe(text)
    expect(ObserverOutput.parse(JSON.parse(text))).toEqual({
      base_version: modelVersion,
      ops: [{ op: 'brief.update', text: 'Тесты зелёные', evidence: factIds, rationale: 'Сводка по фактам порции' }],
      needs: [],
    })
  })

  test('every call is recorded with argv, working directory, environment, prompt, instructions and schema', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Готово')] })
    const prompt = observerPrompt()

    await observer.call(observer.profile, prompt)

    expect(observer.fake.calls().filter((call) => call.command === 'exec')).toEqual([
      {
        sequence: 2,
        runtime: 'codex',
        command: 'exec',
        argv: observer.args(),
        cwd: observer.workspace.cwd,
        env: expect.objectContaining({
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'aang_observer',
          AANG_OBSERVER: '1',
        }) as unknown,
        pid: expect.any(Number) as unknown,
        prompt,
        systemPrompt,
        schema: observerOutputJsonSchema(),
        purpose: 'observer',
        reply: 0,
        violations: [],
      },
    ])
  })

  test.for(isolationProfile(observerFiles('observer')).map((part) => part.id))(
    'without %s the call fails before reaching the model',
    async (id, { expect, onTestFinished }) => {
      const observer = await setUp(onTestFinished, { replies: [answer('Не должно появиться')] })

      const exit = await observer.call(observer.profile.filter((part) => part.id !== id))

      expect({ code: exit.code, stdout: exit.stdout }).toEqual({ code: fakeCliExitCodes.isolation, stdout: '' })
      expect(exit.stderr).toContain(id)
      expect(observer.fake.calls().at(-1)).toMatchObject({ violations: [id], reply: null })
      expect(existsSync(observer.files.lastMessage)).toBe(false)
    },
  )

  test('a weakened profile is a violation too', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('Не должно появиться')] })
    const emptyInstructions = join(observer.workspace.root, 'observer', 'empty-system.md')
    writeFileSync(emptyInstructions, '')
    const weakened: readonly (ProfilePart & { readonly replaces?: string })[] = [
      { id: '-s read-only', args: ['-s', 'workspace-write'] },
      { id: '--thread-source aang-observer', args: ['--thread-source', 'user'] },
      { id: '-c web_search="disabled"', args: ['-c', 'web_search="live"'] },
      { id: '-m matches the catalog slug', replaces: '-m', args: ['-m', 'gpt-5.5'] },
      {
        id: 'catalog entry without tools',
        replaces: '-c model_catalog_json',
        args: ['-c', `model_catalog_json=${tomlPath(observer.files.bundledCatalog)}`],
      },
      {
        id: '-c model_catalog_json',
        args: ['-c', `model_catalog_json="${observer.files.catalog.replaceAll('/', '\\')}"`],
      },
      {
        id: '-c model_instructions_file',
        args: ['-c', `model_instructions_file=${tomlPath(emptyInstructions)}`],
      },
      {
        id: 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE=aang_observer',
        env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_exec' },
      },
    ]

    for (const part of weakened) {
      const exit = await observer.call(
        observer.profile.map((candidate) => (candidate.id === (part.replaces ?? part.id) ? part : candidate)),
      )

      expect
        .soft([part.id, exit.code, observer.fake.calls().at(-1)?.violations])
        .toEqual([part.id, fakeCliExitCodes.isolation, [part.id]])
    }
  })

  test('an unreadable instructions file fails like the real CLI without taking a reply', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('После исправления')] })
    const missingFile = join(observer.workspace.root, 'observer', 'missing-system.md')

    const missing = await observer.call(
      observer.profile.map((part) =>
        part.id === '-c model_instructions_file'
          ? { ...part, args: ['-c', `model_instructions_file=${tomlPath(missingFile)}`] }
          : part,
      ),
    )
    const lastMessageAfterFailure = existsSync(observer.files.lastMessage)
    const fixed = await observer.call()

    expect([missing.code, missing.stdout]).toEqual([1, ''])
    expect(missing.stderr).toMatch(/^Error: failed to read model instructions file .*missing-system\.md: /)
    expect(lastMessageAfterFailure).toBe(false)
    expect(fixed.code).toBe(0)
    expect(
      observer.fake
        .calls()
        .filter((call) => call.command === 'exec')
        .map((call) => [call.systemPrompt, call.reply, call.violations]),
    ).toEqual([
      [null, null, []],
      [systemPrompt, 0, []],
    ])
  })

  test('replies follow the call order and the last one repeats', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {
      replies: [{ kind: 'auth' }, answer('Первый'), answer('Второй')],
    })

    const exits = []
    for (let call = 0; call < 4; call += 1) {
      exits.push(await observer.call())
    }

    expect(exits.map((exit) => exit.code)).toEqual([1, 0, 0, 0])
    expect(exits.slice(1).map((exit) => ObserverOutput.parse(JSON.parse(agentText(exit.events))).ops[0])).toEqual(
      ['Первый', 'Второй', 'Второй'].map((text) => expect.objectContaining({ text }) as unknown),
    )
  })
})

describe('fake codex answers observer and chat calls from scenario scripts (T.6)', () => {
  test('scripts answer chat and observer calls from separate reply queues', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {
      replies: [{ kind: 'script', script: 'claimed-done' }],
      chatReplies: [{ kind: 'script', script: 'chat-collapse-reviewers' }],
    })

    const collapsed = await observer.call(observer.profile, observerPrompt(chatInput))
    const observed = await observer.call(observer.profile, observerPrompt(scenarioInput))

    expect([collapsed.code, observed.code]).toEqual([0, 0])
    expect(ChatOutput.parse(JSON.parse(agentText(collapsed.events))).view_rule).toMatchObject({
      selector: { kind: 'agent_type', agent_type: 'code-reviewer' },
    })
    expect(ObserverOutput.parse(JSON.parse(agentText(observed.events))).ops).toContainEqual(
      expect.objectContaining({ op: 'stage.state', execution: { state: 'done' }, evidence: [scenarioIds.claim] }),
    )
    expect(
      observer.fake
        .calls()
        .filter((call) => call.command === 'exec')
        .map((call) => [call.purpose, call.reply]),
    ).toEqual([
      ['chat', 0],
      ['observer', 0],
    ])
  })
})

describe('fake codex injects observer failures (F.4)', () => {
  test('tool attempts are logged as unsupported by the tool router while the turn completes', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, { replies: [answer('С попытками', ['exec', 'spawn_agent'])] })

    const exit = await observer.call()

    expect(exit.code).toBe(0)
    expect(routerLines(exit.stderr)).toEqual([
      '<TS> ERROR codex_core::tools::router: error=unsupported call: exec',
      '<TS> ERROR codex_core::tools::router: error=unsupported call: spawn_agent',
    ])
    expect(exit.events.map((event) => event.type)).toContain('turn.completed')
  })

  test('an authorization failure ends with turn.failed like the recorded run without auth', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, { replies: [{ kind: 'auth' }] })
    const recorded = readSampleLines('codex-events-3-no-auth.jsonl')

    const exit = await observer.call()

    expect(exit.code).toBe(1)
    expect([exit.events[0]?.type, exit.events[1]?.type, exit.events.at(-1)?.type]).toEqual([
      recorded[0]?.type,
      recorded[1]?.type,
      recorded.at(-1)?.type,
    ])
    expect(ofType(exit.events, 'turn.failed')).toMatchObject({
      error: { message: expect.stringContaining('401 Unauthorized') as unknown },
    })
    expect(existsSync(observer.files.lastMessage)).toBe(false)
  })

  test('a logged-out CLI fails login status and every call until it is logged in again', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { loggedIn: false, replies: [answer('После входа')] })
    const loginStatus = () =>
      runFake(observer.fake, ['login', 'status'], { env: observer.env(), cwd: observer.workspace.cwd })

    const loggedOut = await loginStatus()
    const refused = await observer.call()
    observer.fake.setScenario({ replies: [answer('После входа')] })
    const loggedIn = await loginStatus()
    const answered = await observer.call()

    expect([loggedOut.code, loggedOut.stderr.trim()]).toEqual([1, 'Not logged in'])
    expect([refused.code, refused.events.at(-1)?.type]).toEqual([1, 'turn.failed'])
    expect([loggedIn.code, loggedIn.stderr.trim()]).toEqual([0, 'Logged in using ChatGPT'])
    expect(answered.code).toBe(0)
    expect(
      observer.fake
        .calls()
        .filter((call) => call.command !== 'debug_models')
        .map((call) => [call.command, call.reply]),
    ).toEqual([
      ['login_status', null],
      ['exec', null],
      ['login_status', null],
      ['exec', 0],
    ])
  })

  test('a usage limit fails the turn and names the reset time when it is known', async ({ onTestFinished }) => {
    const resetsAt = 1_790_900_000
    const observer = await setUp(onTestFinished, { replies: [{ kind: 'limit', resetsAt }, { kind: 'limit' }] })

    const withReset = await observer.call()
    const withoutReset = await observer.call()

    expect([withReset.code, withoutReset.code]).toEqual([1, 1])
    expect(ofType(withReset.events, 'turn.failed')).toMatchObject({
      error: { message: expect.stringContaining(new Date(resetsAt * 1000).toISOString()) as unknown },
    })
    expect(ofType(withoutReset.events, 'turn.failed')).toMatchObject({
      error: { message: expect.stringContaining("You've hit your usage limit") as unknown },
    })
  })

  test('invalid JSON output completes the turn with a last message that is not JSON', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {
      replies: [{ kind: 'invalid_json', text: '{"base_version": 7, "ops": [' }],
    })

    const exit = await observer.call()

    expect(exit.code).toBe(0)
    expect(exit.events.at(-1)?.type).toBe('turn.completed')
    expect(readFileSync(observer.files.lastMessage, 'utf8')).toBe('{"base_version": 7, "ops": [')
  })

  test('a timeout keeps the CLI running after the turn starts until it is killed', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { replies: [{ kind: 'timeout' }] })
    const running = startFake(observer.fake, observer.args(), {
      env: observer.env(),
      cwd: observer.workspace.cwd,
      stdin: observerPrompt(),
    })

    await waitFor(() => running.events().length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    expect(running.alive()).toBe(true)
    expect(running.events().map((event) => event.type)).toEqual(['thread.started', 'turn.started'])
    await running.kill()
  })
})

describe('fake codex sends a real Responses API request to the self-check stub (F.4)', () => {
  const mockProvider = (baseUrl: string): string[] => [
    '-c',
    'model_provider="mock"',
    '-c',
    `model_providers.mock={name="mock", base_url="${baseUrl}", wire_api="responses", requires_openai_auth=false}`,
  ]

  const runAgainst = async (observer: Observer, baseUrl: string): Promise<Exit> => {
    const codexHome = join(observer.workspace.root, 'codex-home')
    mkdirSync(codexHome, { recursive: true })
    return runFake(observer.fake, observer.args(observer.profile, mockProvider(baseUrl)), {
      env: observer.env(observer.profile, { CODEX_HOME: codexHome }),
      cwd: observer.workspace.cwd,
      stdin: observerPrompt(),
    })
  }

  test('the request carries the observer prompt, instructions and schema and no tools', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {})
    const finalText = JSON.stringify({ base_version: modelVersion, ops: [], needs: [] })
    const stub = await startResponsesStub(onTestFinished, [[assistantMessage(finalText)]])
    const recorded = readSample('codex-mock-request-tools-off.json')

    const exit = await runAgainst(observer, stub.baseUrl)

    expect(exit.code).toBe(0)
    expect(stub.requests).toHaveLength(1)
    const [request] = stub.requests
    expect(request?.path).toBe('/v1/responses')
    expect(request?.headers).toMatchObject({ originator: 'aang_observer' })
    expect(keysOf(request?.body)).toEqual(keysOf(recorded.body))
    expect(request?.body).not.toHaveProperty('tools')
    expect(request?.body).toMatchObject({
      model,
      text: { format: { type: 'json_schema', strict: true, schema: observerOutputJsonSchema() } },
      input: [
        { type: 'additional_tools', role: 'developer', tools: [] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: systemPrompt }] },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: expect.stringContaining('"model"') as unknown }],
        },
      ],
    })
    expect(JSON.parse(String(request?.headers['x-codex-turn-metadata']))).toMatchObject({
      thread_source: 'aang-observer',
      model,
    })
    expect(agentText(exit.events)).toBe(finalText)
    expect(readFileSync(observer.files.lastMessage, 'utf8')).toBe(finalText)
    expect(ofType(exit.events, 'turn.completed')?.usage).toEqual({
      input_tokens: stubUsage.input_tokens,
      cached_input_tokens: stubUsage.input_tokens_details.cached_tokens,
      cache_write_input_tokens: 0,
      output_tokens: stubUsage.output_tokens,
      reasoning_output_tokens: stubUsage.output_tokens_details.reasoning_tokens,
    })
    expect(observer.fake.calls().at(-1)?.reply).toBeNull()
  })

  test('tool calls from the stub are answered as unsupported, exactly like the recorded attack run', async ({
    onTestFinished,
  }) => {
    const observer = await setUp(onTestFinished, {})
    const attack = readSampleLines('codex-mock-tool-attempts.jsonl').filter(
      (row) => row.phase === 'final_published' && row.run === 'p_attack',
    )
    const steps = attack.filter((row) => typeof row.step === 'number')
    const outcome = attack.find((row) => row.step === undefined)
    const finalText = JSON.stringify({ base_version: modelVersion, ops: [], needs: [] })
    const rounds = steps.map((row) =>
      (row.mock_reply as Record<string, unknown>[]).map((item) =>
        item.type === 'message' ? assistantMessage(finalText) : { ...item, call_id: `call_${String(row.step)}` },
      ),
    )
    const stub = await startResponsesStub(onTestFinished, rounds)

    const exit = await runAgainst(observer, stub.baseUrl)

    expect(exit.code).toBe(outcome?.exit_code)
    expect(exit.events.map((event) => event.type)).toEqual(outcome?.json_stream_types)
    expect(routerLines(exit.stderr)).toEqual(outcome?.stderr)
    expect(stub.requests).toHaveLength(steps.length)
    expect(
      stub.requests.slice(1).map((request) => {
        const input = request.body.input as Record<string, unknown>[]
        return [input.at(-1)?.output]
      }),
    ).toEqual(steps.slice(1).map((row) => row.codex_output_for_previous_call))
    expect(agentText(exit.events)).toBe(finalText)
  })

  test('the turn completes only after response.completed, as in the real CLI', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {})
    const finalText = JSON.stringify({ base_version: modelVersion, ops: [], needs: [] })
    const closedEarly = await startResponsesStub(onTestFinished, [[assistantMessage(finalText)]], {
      completes: false,
    })
    const completed = await startResponsesStub(onTestFinished, [[assistantMessage(finalText)]])

    const failed = await runAgainst(observer, closedEarly.baseUrl)
    const lastMessageAfterFailure = existsSync(observer.files.lastMessage)
    const succeeded = await runAgainst(observer, completed.baseUrl)

    expect(failed.code).toBe(1)
    expect(failed.events.map((event) => event.type)).toEqual(['thread.started', 'turn.started', 'error', 'turn.failed'])
    expect(ofType(failed.events, 'turn.failed')).toEqual({
      type: 'turn.failed',
      error: { message: 'stream disconnected before completion: stream closed before response.completed' },
    })
    expect(lastMessageAfterFailure).toBe(false)
    expect(succeeded.code).toBe(0)
    expect(succeeded.events.map((event) => event.type)).toContain('turn.completed')
    expect(readFileSync(observer.files.lastMessage, 'utf8')).toBe(finalText)
  })

  test('a CLI version that leaks tools shows them in the request to the stub', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { leakedTools: ['functions/exec', 'collaboration/spawn_agent'] })
    const stub = await startResponsesStub(onTestFinished, [[assistantMessage('{}')]])

    await runAgainst(observer, stub.baseUrl)

    const [additionalTools] = stub.requests[0]?.body.input as Record<string, unknown>[]
    expect(additionalTools).toMatchObject({
      type: 'additional_tools',
      tools: [
        { name: 'exec', namespace: 'functions' },
        { name: 'spawn_agent', namespace: 'collaboration' },
      ],
    })
  })
})

describe('fake codex behaves like the real CLI outside the model call (F.4)', () => {
  test('--version prints the scenario version', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, { version: '0.159.4' })

    const exit = await runFake(observer.fake, ['--version'], { env: observer.env(), cwd: observer.workspace.cwd })

    expect([exit.code, exit.stdout.trim()]).toEqual([0, 'codex-cli 0.159.4'])
  })

  test('an unexpected argument fails with the error of the real CLI', async ({ onTestFinished }) => {
    const observer = await setUp(onTestFinished, {})

    const exit = await runFake(observer.fake, ['exec', '--bogus'], { env: observer.env(), cwd: observer.workspace.cwd })

    expect(exit.code).toBe(2)
    expect(lines(exit.stderr)[0]).toBe("error: unexpected argument '--bogus' found")
  })
})
