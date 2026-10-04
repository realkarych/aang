import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { claudeAdapter } from '@aang/adapter-claude'
import { codexAdapter } from '@aang/adapter-codex'
import { type Adapter, EpochNs, type Runtime, type SessionKey } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { createEngine, observerInputTokens } from '@aang/engine'
import { openStore } from '@aang/store'
import { installFakeClaude, installFakeCodex } from '@aang/testkit'
import { type TestContext, test } from 'vitest'
import { bearer, createHome, type Home, startDaemon } from './daemon.js'
import {
  admissionOf,
  briefed,
  configure,
  heldToolAttempt,
  installLauncher,
  observerEnvironment,
  observerInputs,
  progressOf,
  settled,
  toolAttempt,
} from './observers.js'
import { claudeHook, codexHook, enqueue, openFinished, queued, sleep, waitUntil, watchedHome } from './sessions.js'

const claudeKey = (session: string): SessionKey => ({ kind: 'session', runtime: 'claude', session })

const codexKey = (session: string): SessionKey => ({ kind: 'session', runtime: 'codex', session })

const unverifiedIsolation = 'изоляция от сообщений других сессий на этой версии не проверена'

const run = async (home: Home, onTestFinished: TestContext['onTestFinished'], work: () => Promise<void>): Promise<void> => {
  const daemon = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
  await work()
  daemon.abort()
  await daemon.stopped
}

const claudeEvents = (session: string, workspace: string): string[] => [
  claudeHook('SessionStart.startup', session, workspace),
  claudeHook('PermissionRequest.Bash', session, workspace),
]

const codexEvents = (session: string, workspace: string): string[] => [
  codexHook('SessionStart.startup', session, workspace),
  codexHook('PermissionRequest', session, workspace),
]

test('the daemon admits the Codex CLI from the config and sends a Codex run to it', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [briefed] })
  await installLauncher(home)
  await configure(home, workspace, {
    cli: { codex: codex.path },
    observer: { effort: { codex: 'low' } },
  })
  const session = codexKey('thread-g6-codex')
  const observed = runId(session)

  await run(home, onTestFinished, async () => {
    await enqueue(home, 'codex', codexEvents(session.session, workspace), 'codex')
    await waitUntil(() => settled(progressOf(home, observed)))
  })

  const store = openFinished(home, onTestFinished)
  const facts = store.facts.ofSession(session).map(({ id }) => id)
  expect(progressOf(home, observed)).toEqual({
    statuses: facts.map(() => 'interpreted'),
    batches: [{ verdict: 'accepted', error: null }],
  })
  expect(observerInputs(codex, observed).map(({ batch }) => batch.facts.map(({ id }) => id).sort())).toEqual([
    [...facts].sort(),
  ])
  const [work] = codex.calls().filter(({ command, prompt }) => command === 'exec' && prompt?.includes(observed) === true)
  expect(work?.argv).toEqual(expect.arrayContaining(['-m', 'gpt-6.1-sol', 'model_reasoning_effort="low"']))
  expect(await admissionOf(home, 'codex')).toMatchObject({ admitted: true, version: '0.159.3', warning: null })
  expect(await admissionOf(home, 'claude')).toMatchObject({ admitted: false })
})

test(
  'each run goes to the observer of its root session vendor, and Claude runs with the unverified isolation mark',
  async ({ expect, onTestFinished }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const claude = installFakeClaude(join(home.root, 'fake-cli'), { replies: [briefed] })
    const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [briefed] })
    await installLauncher(home)
    await configure(home, workspace, { cli: { claude: claude.path, codex: codex.path } })
    const claudeRun = runId(claudeKey('session-g6-claude'))
    const codexRun = runId(codexKey('thread-g6-codex'))

    await run(home, onTestFinished, async () => {
      await enqueue(home, 'claude', claudeEvents('session-g6-claude', workspace))
      await enqueue(home, 'codex', codexEvents('thread-g6-codex', workspace), 'codex')
      await waitUntil(() => settled(progressOf(home, claudeRun)) && settled(progressOf(home, codexRun)))
    })

    expect([claudeRun, codexRun].map((observed) => progressOf(home, observed).batches)).toEqual([
      [{ verdict: 'accepted', error: null }],
      [{ verdict: 'accepted', error: null }],
    ])
    expect([observerInputs(claude, claudeRun), observerInputs(claude, codexRun)].map((inputs) => inputs.length)).toEqual([1, 0])
    expect([observerInputs(codex, codexRun), observerInputs(codex, claudeRun)].map((inputs) => inputs.length)).toEqual([1, 0])
    const [work] = claude.calls().filter(({ prompt }) => prompt?.includes(claudeRun) === true)
    expect(work?.argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5']))
    expect(await admissionOf(home, 'claude')).toMatchObject({
      admitted: true,
      version: '2.1.286',
      warning: unverifiedIsolation,
      builtinPlugins: ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring'],
    })
  },
)

const adapters = new Map<Runtime, Adapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
])

const attachCodexSession = async (crossVendor: boolean, { onTestFinished }: TestContext) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const claude = installFakeClaude(join(home.root, 'fake-cli'), { replies: [briefed] })
  await installLauncher(home)
  const root = claudeKey('session-g6-root')
  const attached = codexKey('thread-g6-attached')
  const observed = runId(root)

  await run(home, onTestFinished, async () => {
    await enqueue(home, 'start', [claudeHook('SessionStart.startup', root.session, workspace)])
    await enqueue(home, 'attached', [codexHook('SessionStart.startup', attached.session, workspace)], 'codex')
    await waitUntil(async () => (await queued(home)).length === 0)
  })
  const unobserved = openStore({ home: home.paths.home })
  const before = unobserved.interpretations.ofRun(observed).map(({ status }) => status)
  await createEngine({ store: unobserved, adapters, watch: { all: true, roots: [] } }).bind({
    kind: 'attach',
    session: objectId(attached),
    run: observed,
  })
  unobserved.close()

  await configure(home, workspace, { cli: { claude: claude.path }, observer: { crossVendor } })
  await run(home, onTestFinished, async () => {
    await enqueue(home, 'permission', [claudeHook('PermissionRequest.Bash', root.session, workspace)])
    await enqueue(home, 'attached-permission', [codexHook('PermissionRequest', attached.session, workspace)], 'codex')
    await waitUntil(
      () =>
        settled(progressOf(home, observed)) &&
        progressOf(home, observed).batches.some(({ verdict }) => verdict === 'accepted'),
    )
  })

  const store = openFinished(home, onTestFinished)
  const statuses = new Map(store.interpretations.ofRun(observed).map(({ fact, status }) => [fact, status]))
  const sent = new Set(observerInputs(claude, observed).flatMap(({ batch }) => batch.facts.map(({ id }) => id)))
  const factsOf = (key: SessionKey) =>
    store.facts.ofSession(key).map(({ id }) => ({ sent: sent.has(id), status: statuses.get(id) ?? null }))
  return {
    before,
    root: factsOf(root),
    attached: factsOf(attached),
    gaps: store.gaps.open('cross_vendor_excluded').map(({ run: gapRun, session, details }) => ({ run: gapRun, session, details })),
    session: objectId(attached),
    observed,
  }
}

test(
  'facts of a Codex session in a Claude run are not sent to the Claude observer without crossVendor and stay visible as a gap',
  async (context) => {
    const outcome = await attachCodexSession(false, context)

    context.expect(outcome).toEqual({
      before: ['pending'],
      root: [
        { sent: true, status: 'interpreted' },
        { sent: true, status: 'interpreted' },
      ],
      attached: [
        { sent: false, status: 'not_interpreted' },
        { sent: false, status: 'not_interpreted' },
      ],
      gaps: [
        {
          run: outcome.observed,
          session: outcome.session,
          details: 'facts of this session are not sent to the claude observer without observer.crossVendor',
        },
      ],
      session: outcome.session,
      observed: outcome.observed,
    })
  },
)

test(
  'with crossVendor the Claude observer receives the facts of the attached Codex session',
  async (context) => {
    const outcome = await attachCodexSession(true, context)

    context.expect({ attached: outcome.attached, gaps: outcome.gaps }).toEqual({
      attached: [
        { sent: true, status: 'interpreted' },
        { sent: true, status: 'interpreted' },
      ],
      gaps: [],
    })
  },
)

test(
  'a binding wakes the observer, which interprets the facts of the moved session in the target run without another intake',
  async ({ expect, onTestFinished }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const claude = installFakeClaude(join(home.root, 'fake-cli'), { replies: [briefed] })
    await installLauncher(home)
    await configure(home, workspace, { cli: { claude: claude.path } })
    const root = claudeKey('session-g8-bind-root')
    const moved = claudeKey('session-g8-bind-moved')
    const target = runId(root)
    const source = runId(moved)
    const factsOf = (key: SessionKey): string[] => {
      const database = new DatabaseSync(join(home.paths.home, 'aang.db'), { readOnly: true })
      try {
        return database
          .prepare("SELECT id FROM facts WHERE json_extract(entity_key, '$.session') = ? ORDER BY id")
          .all(key.session)
          .map((row) => String(row['id']))
      } finally {
        database.close()
      }
    }

    const daemon = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
    await enqueue(home, 'root', claudeEvents(root.session, workspace))
    await enqueue(home, 'moved', claudeEvents(moved.session, workspace))
    await waitUntil(() => settled(progressOf(home, target)) && settled(progressOf(home, source)))
    const interpretedBefore = observerInputs(claude, target).length
    const response = await fetch(`${daemon.base}/api/bindings`, {
      method: 'POST',
      headers: { ...bearer(home.token), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'attach', session: objectId(moved), run: target }),
    })
    expect(response.status).toBe(200)
    const expected = [...factsOf(root), ...factsOf(moved)].length
    await waitUntil(() => {
      const progress = progressOf(home, target)
      return progress.statuses.length === expected && settled(progress)
    })
    daemon.abort()
    await daemon.stopped

    expect(progressOf(home, target).statuses).toEqual(Array.from({ length: expected }, () => 'interpreted'))
    const sent = observerInputs(claude, target)
      .slice(interpretedBefore)
      .flatMap(({ batch }) => batch.facts.map(({ id }) => id))
    expect(sent.sort()).toEqual(factsOf(moved))
  },
)

test('observer.backend sends a Claude run to the Codex observer, which gets none of its facts without crossVendor', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [briefed] })
  await installLauncher(home)
  await configure(home, workspace, { cli: { codex: codex.path }, observer: { backend: 'codex' } })
  const session = claudeKey('session-g6-overridden')
  const observed = runId(session)

  await run(home, onTestFinished, async () => {
    await enqueue(home, 'claude', claudeEvents(session.session, workspace))
    await waitUntil(() => settled(progressOf(home, observed)))
  })

  const store = openFinished(home, onTestFinished)
  expect(progressOf(home, observed)).toEqual({ statuses: ['not_interpreted', 'not_interpreted'], batches: [] })
  expect(observerInputs(codex, observed)).toEqual([])
  expect(store.gaps.open('cross_vendor_excluded')).toMatchObject([
    {
      run: observed,
      session: objectId(session),
      details: 'facts of this session are not sent to the codex observer without observer.crossVendor',
    },
  ])
})

test('the scheduler finds skills in the configured Claude directory and keeps observer inputs within observer.inputLimitTokens', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [briefed, briefed] })
  await installLauncher(home)
  const claudeHome = join(home.root, 'claude-home')
  const skill = join(claudeHome, 'skills', 'g6-review', 'SKILL.md')
  await mkdir(dirname(skill), { recursive: true })
  await writeFile(skill, '---\nname: g6-review\ndescription: Reviews the change before it ships\n---\nSteps\n')
  const inputLimit = 1_150
  await configure(home, workspace, {
    runtimes: { claude: { configDir: claudeHome } },
    cli: { codex: codex.path },
    observer: { backend: 'codex', crossVendor: true, inputLimitTokens: inputLimit },
  })
  const session = claudeKey('session-g6-context')
  const observed = runId(session)

  await run(home, onTestFinished, async () => {
    await enqueue(home, 'skill', [
      claudeHook('SessionStart.startup', session.session, workspace),
      claudeHook('PreToolUse.Bash', session.session, workspace, {
        tool_name: 'Skill',
        tool_input: { skill: 'g6-review' },
        tool_use_id: 'toolu_g6_skill',
      }),
    ])
    await waitUntil(() => settled(progressOf(home, observed)))
    await enqueue(home, 'permission', [
      claudeHook('PermissionRequest.Bash', session.session, workspace, {
        tool_input: { command: `echo ${'x'.repeat(3_900)}`, description: 'Print a long line' },
      }),
    ])
    await waitUntil(() => {
      const progress = progressOf(home, observed)
      return settled(progress) && progress.batches.length === 2
    })
  })

  const inputs = observerInputs(codex, observed)
  expect(inputs.map((input) => observerInputTokens(input) <= inputLimit)).toEqual([true, true])
  const [, second] = inputs
  expect(second?.context?.entries).toContainEqual({
    kind: 'skill',
    ref: skill,
    text: 'Reviews the change before it ships',
    truncated: null,
  })
  expect(second?.batch.facts.map(({ kind, truncated }) => ({ kind, truncated: truncated.length > 0 }))).toEqual([
    { kind: 'permission_request', truncated: true },
  ])
})

test('an isolation violation that a call on the old Codex version reports after the new version was found leaves the new version to admission', { timeout: 90_000 }, async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const released = join(home.root, 'released')
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [heldToolAttempt(released)] })
  await installLauncher(home)
  await configure(home, workspace, { cli: { codex: codex.path } })
  const running = runId(codexKey('thread-g6-running'))
  const updated = runId(codexKey('thread-g6-updated'))

  await run(home, onTestFinished, async () => {
    await enqueue(home, 'running', codexEvents('thread-g6-running', workspace), 'codex')
    await waitUntil(() => observerInputs(codex, running).length === 1)
    codex.setScenario({ version: '0.159.4', replies: [briefed] })
    await enqueue(home, 'updated', codexEvents('thread-g6-updated', workspace), 'codex')
    await waitUntil(() => progressOf(home, updated).batches.length === 1)
    await writeFile(released, '')
    await waitUntil(
      () =>
        [running, updated].every((observed) => {
          const progress = progressOf(home, observed)
          return settled(progress) && progress.batches.length === 2
        }),
      60_000,
    )
  })

  expect([running, updated].map((observed) => progressOf(home, observed))).toEqual([
    {
      statuses: ['interpreted', 'interpreted'],
      batches: [
        { verdict: 'failed', error: 'isolation' },
        { verdict: 'accepted', error: null },
      ],
    },
    {
      statuses: ['interpreted', 'interpreted'],
      batches: [
        { verdict: 'failed', error: 'version_not_admitted' },
        { verdict: 'accepted', error: null },
      ],
    },
  ])
  expect(await admissionOf(home, 'codex')).toMatchObject({ admitted: true, version: '0.159.4', isolationViolated: false })
})

test(
  'an isolation violation keeps the Codex backend off on the same version across a restart, and a new CLI version gets the queue',
  { timeout: 120_000 },
  async ({ expect, onTestFinished }) => {
    const { home, workspace } = await watchedHome(onTestFinished)
    const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [toolAttempt] })
    await installLauncher(home)
    await configure(home, workspace, { cli: { codex: codex.path } })
    const violated = runId(codexKey('thread-g6-violated'))
    const later = runId(codexKey('thread-g6-later'))

    await run(home, onTestFinished, async () => {
      await enqueue(home, 'violated', codexEvents('thread-g6-violated', workspace), 'codex')
      await waitUntil(() => progressOf(home, violated).batches.length === 1)
    })
    const stored = await admissionOf(home, 'codex')
    expect(stored).toMatchObject({ admitted: false, version: '0.159.3', isolationViolated: true })

    codex.setScenario({ replies: [briefed, briefed] })
    const restarted = codex.calls().length
    const since = () => codex.calls().slice(restarted)
    const refused = async () => {
      const admission = await admissionOf(home, 'codex')
      return admission?.['checkedAt'] !== stored?.['checkedAt'] && admission?.['reason'] !== 'admission_pending'
    }
    await run(home, onTestFinished, async () => {
      await enqueue(home, 'later', codexEvents('thread-g6-later', workspace), 'codex')
      await waitUntil(
        async () =>
          (await refused()) &&
          (await queued(home)).length === 0 &&
          since().filter(({ command }) => command === 'version').length >= 2,
        40_000,
      )
      expect(since().map(({ command }) => command)).toEqual(since().map(() => 'version'))
      expect([violated, later].map((observed) => progressOf(home, observed).statuses)).toEqual([
        ['pending', 'pending'],
        ['pending', 'pending'],
      ])
      expect(await admissionOf(home, 'codex')).toMatchObject({ admitted: false, version: '0.159.3', isolationViolated: true })

      codex.setScenario({ version: '0.159.4', replies: [briefed, briefed] })
      await waitUntil(() => settled(progressOf(home, violated)) && settled(progressOf(home, later)), 60_000)
    })

    expect([violated, later].map((observed) => progressOf(home, observed))).toEqual([
      {
        statuses: ['interpreted', 'interpreted'],
        batches: [
          { verdict: 'failed', error: 'isolation' },
          { verdict: 'accepted', error: null },
        ],
      },
      { statuses: ['interpreted', 'interpreted'], batches: [{ verdict: 'accepted', error: null }] },
    ])
    expect(await admissionOf(home, 'codex')).toMatchObject({ admitted: true, version: '0.159.4', isolationViolated: false })
  },
)

test('a Codex CLI that appears after the start is admitted, gets the queued facts and is no longer polled', { timeout: 90_000 }, async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [briefed] })
  await installLauncher(home)
  const path = codex.path
  const installed = dirname(path)
  const absent = `${installed}-absent`
  await rename(installed, absent)
  await configure(home, workspace, { cli: { codex: path } })
  const session = codexKey('thread-g6-installed')
  const observed = runId(session)

  await run(home, onTestFinished, async () => {
    await enqueue(home, 'codex', codexEvents(session.session, workspace), 'codex')
    await waitUntil(async () => {
      const admission = await admissionOf(home, 'codex')
      return (await queued(home)).length === 0 && admission !== null && admission['reason'] !== 'admission_pending'
    })
    expect(progressOf(home, observed).statuses).toEqual(['pending', 'pending'])
    expect(await admissionOf(home, 'codex')).toMatchObject({ admitted: false, version: null })

    await rename(absent, installed)
    await waitUntil(() => settled(progressOf(home, observed)), 60_000)
    const calls = codex.calls().length
    await sleep(11_000)
    expect(codex.calls()).toHaveLength(calls)
  })

  expect(progressOf(home, observed)).toEqual({
    statuses: ['interpreted', 'interpreted'],
    batches: [{ verdict: 'accepted', error: null }],
  })
  expect(await admissionOf(home, 'codex')).toMatchObject({ admitted: true, version: '0.159.3' })
})

test('stopping the daemon cancels a running observer call and leaves its batch pending', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [{ kind: 'timeout' }] })
  await installLauncher(home)
  await configure(home, workspace, {
    cli: { codex: codex.path },
    observer: { timeoutMs: { codex: 600_000 } },
  })
  const session = codexKey('thread-g6-stopped')
  const observed = runId(session)

  await run(home, onTestFinished, async () => {
    await enqueue(home, 'codex', codexEvents(session.session, workspace), 'codex')
    await waitUntil(() => observerInputs(codex, observed).length === 1)
  })

  expect(progressOf(home, observed)).toEqual({
    statuses: ['pending', 'pending'],
    batches: [{ verdict: 'failed', error: null }],
  })
})

test('stopping the daemon during admission does not wait for the CLI and starts no observer', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [briefed] })
  const hold = { gate: join(home.root, 'gate'), started: join(home.root, 'started') }
  await installLauncher(home)
  await configure(home, workspace, { cli: { codex: codex.held(hold) } })
  const session = codexKey('thread-g6-held')
  const observed = runId(session)

  await run(home, onTestFinished, async () => {
    await enqueue(home, 'codex', codexEvents(session.session, workspace), 'codex')
    await waitUntil(async () => existsSync(hold.started) && (await queued(home)).length === 0)
  })

  expect(progressOf(home, observed)).toEqual({ statuses: ['pending', 'pending'], batches: [] })
  expect(codex.calls()).toEqual([])
  expect(await admissionOf(home, 'codex')).toMatchObject({ admitted: false })
})

test('a stored observer state that cannot be read stops the daemon with an error', async ({ expect, onTestFinished }) => {
  const home = await createHome(onTestFinished)
  const store = openStore({ home: home.paths.home })
  store.transaction((transaction) => {
    transaction.settings.save('observer_recovery_codex', { kind: 'resting' }, EpochNs.parse(1n))
  })
  store.close()

  const stopped = startDaemon(home, onTestFinished).then((daemon) => daemon.stopped)
  await expect(stopped).rejects.toMatchObject({ name: 'ZodError' })
  await expect(stopped).rejects.toThrow('No matching discriminator')
})
