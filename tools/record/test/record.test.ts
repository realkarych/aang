import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexAdapter } from '@aang/adapter-codex'
import { CollectedRecord, type ParseResult } from '@aang/contract'
import { createPlayer, createProfile, loadManifest, leaseSpool } from '@aang/testkit'
import { afterEach, expect, test, vi } from 'vitest'
import { recordSession, verifyRecording, type RecordContext, type RecordOptions } from '../dist/index.js'

const temporary: string[] = []
const runtimeScript = fileURLToPath(new URL('./runtime.ts', import.meta.url))
const hookScript = fileURLToPath(new URL('./hook-event.ts', import.meta.url))
const longSession = fileURLToPath(new URL('./long-session.ts', import.meta.url))
const samples = new URL('../../../docs/research/samples/', import.meta.url)
const binary = resolve('packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook')
const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

const options = async (runtime: 'claude' | 'codex' = 'claude'): Promise<RecordOptions> => {
  const directory = await mkdtemp(join(tmpdir(), 'aang-record-test-'))
  temporary.push(directory)
  return {
    runtime,
    engineVersion: '0.0.1',
    surface: runtime === 'claude' ? 'claude_cli' : 'codex_exec',
    scenario: 'tools',
    expectedFacts: ['An action finishes with usage 7 input and 3 output tokens'],
    fixturesRoot: join(directory, 'sessions'),
    hookBinary: binary,
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test.each(['claude', 'codex'] as const)('records %s files and hook timestamps, anonymizes and replays the session', async (runtime) => {
  const config = await options(runtime)
  let context: RecordContext | undefined
  const directory = await recordSession(config, async (session) => {
    context = session
    await session.run(process.execPath, [runtimeScript, runtime, 'first'])
    await session.checkpoint('started', { root: 'home', path: 'project/result.json' }, 'An active stage produces result.json')
    await session.run(process.execPath, [runtimeScript, runtime, 'second'])
    await session.checkpoint('finished', { root: 'home', path: 'project/result.json' }, 'The stage is done and has an artifact')
  })
  expect(directory).toBe(join(config.fixturesRoot, runtime, '0.0.1', config.surface, os, 'tools'))
  await expect(stat(context?.home ?? '')).rejects.toMatchObject({ code: 'ENOENT' })
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    os: string
    engine_version: string
    expected_facts: string[]
    control_events: { label: string; observed_at: string; step: number; expected_map_change: { description: string } }[]
    artifacts: { source: string; observed_at: string; mtime_ns: string }[]
  }
  expect(manifest.os).toBe(os)
  expect(manifest.engine_version).toBe('0.0.1')
  expect(manifest.expected_facts).toEqual(config.expectedFacts)
  expect(manifest.control_events.map((event) => event.label)).toEqual(['started', 'finished'])
  expect(manifest.control_events[1]?.expected_map_change.description).toContain('stage is done')
  expect(manifest.artifacts.length).toBeGreaterThanOrEqual(runtime === 'claude' ? 6 : 4)
  for (const artifact of manifest.artifacts) {
    expect(Number(artifact.mtime_ns)).toBeGreaterThan(0)
    expect(Date.parse(artifact.observed_at)).not.toBeNaN()
  }
  await verifyRecording(directory)
  const playback = await loadManifest(join(directory, 'playback.json'))
  expect(playback.steps.filter((step) => step.kind === 'hook')).toHaveLength(runtime === 'claude' ? 2 : 0)
  for (const event of manifest.control_events) {
    expect(playback.steps[event.step]?.label).toBe(event.label)
  }
  const serialized = [await readFile(join(directory, 'manifest.json'), 'utf8'), await readFile(join(directory, 'playback.json'), 'utf8'), ...await Promise.all(manifest.artifacts.map((artifact) => readFile(join(directory, artifact.source), 'utf8')))].join('\n')
  expect(serialized).not.toMatch(/someone\.personal|real-person|another-person|Имя Фамилия|acct-private|acct-nested|acct-otel|71c972de|installation-private|user-private|never-copy-authorization|%USERPROFILE%/i)
  expect(serialized).not.toContain(context?.home)
  expect(serialized).toContain('session-public-1')
  expect(serialized).toContain('event-public-2')
  const profile = await createProfile()
  try {
    await leaseSpool(profile.spool)
    const player = createPlayer(playback, { roots: profile, hook: { binary, spool: profile.spool }, timeScale: 0 })
    await player.play({ until: 'finished' })
    expect(JSON.parse(await readFile(join(profile.home, 'project/result.json'), 'utf8'))).toMatchObject({ state: 'running' })
    await player.play()
    expect(JSON.parse(await readFile(join(profile.home, 'project/result.json'), 'utf8'))).toMatchObject({ state: 'done' })
    const transcript = runtime === 'claude'
      ? join(profile.claude, 'projects/record-project/session.jsonl')
      : join(profile.codex, 'sessions/2026/10/02/rollout.jsonl')
    const lines = (await readFile(transcript, 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({ uuid: 'event-public-2', message: { usage: { input_tokens: 7, output_tokens: 3 } } })
  } finally {
    await profile.dispose()
  }
})

test('failed CLI aborts publication and removes its temporary project', async () => {
  const config = await options()
  let project = ''
  await expect(recordSession(config, async (session) => {
    project = session.project
    await session.run(process.execPath, [runtimeScript, 'claude', 'fail'])
  })).rejects.toThrow(/7/)
  await expect(stat(project)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(config.fixturesRoot, 'claude', '0.0.1', 'claude_cli', os, 'tools'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('verifier rejects private data added to a recording, including unreferenced files', async () => {
  const config = await options()
  const directory = await recordSession(config, async (session) => {
    await session.run(process.execPath, [runtimeScript, 'claude', 'first'])
  })
  await writeFile(join(directory, 'leak.json'), JSON.stringify({ path: 'C:\\Users\\Private Name\\work', account_id: 'leaked-account' }))
  await expect(verifyRecording(directory)).rejects.toThrow(/anonym|private|redact/i)
  expect(await readdir(directory)).toContain('manifest.json')
})

test('captures existing format samples and preserves session identities and nested JSON text', async () => {
  const config = await options()
  const sample = await readFile(resolve('docs/research/samples/claude-code-transcripts/rec-user-prompt.json'), 'utf8')
  const directory = await recordSession(config, async (session) => {
    await writeFile(join(session.project, 'sample.json'), sample)
    await writeFile(join(session.project, 'extra.json'), JSON.stringify({
      account_id: 7,
      short: { account_id: '7', organization_id: 'x' },
      rootHome: '/root/.codex/sessions',
      usage: { input_tokens: 7 },
      description: 'JSON in text: {"organization_id":"plain-org-12"}',
      escaped: `Escaped JSON: ${JSON.stringify(JSON.stringify({ path: 'D:\\Users\\Private Person\\one', accountId: 'embedded-account' }))}`,
      data: JSON.stringify({ path: '/home/nested-user/a' }, null, 2),
      source: 'acct-forward-reference',
    }))
    await session.checkpoint('sample', { root: 'home', path: 'project/sample.json' }, 'A user request is visible')
    await writeFile(join(session.project, 'identity.json'), JSON.stringify({ creator_account_id: 'acct-forward-reference' }))
  })
  const playback = await loadManifest(join(directory, 'playback.json'))
  const text = [...playback.sources.values()].join('\n')
  expect(text).not.toMatch(/plain-org-12|embedded-account|nested-user|Private Person|acct-forward-reference/)
  expect(text).toContain('86f93ed5-1acd-4c6e-8c60-f1c98335c2ef')
  const artifact = playback.steps.find((step) => 'target' in step && step.target.path === 'project/extra.json')
  expect(artifact).toBeDefined()
  const extra = JSON.parse(playback.sources.get(artifact && 'source' in artifact ? artifact.source : '')?.toString() ?? 'null') as { account_id: unknown; usage: { input_tokens: number } }
  expect(extra.account_id).not.toBe(7)
  expect(extra.usage.input_tokens).toBe(7)
})

test('captures removal and truncation, refuses replacement of an existing recording', async () => {
  const config = await options('codex')
  const directory = await recordSession(config, async (session) => {
    const file = join(session.project, 'events.jsonl')
    await writeFile(file, '{"type":"old","content":"long previous content"}\n')
    await session.checkpoint('first', { root: 'home', path: 'project/events.jsonl' }, 'Old result')
    await writeFile(file, '{"type":"new"}\n')
    await session.checkpoint('replaced', { root: 'home', path: 'project/events.jsonl' }, 'New result')
    await writeFile(file, '')
    await session.checkpoint('cleared', { root: 'home', path: 'project/events.jsonl' }, 'Source is empty')
    await rm(file)
    await session.checkpoint('removed', { root: 'home', path: 'project/events.jsonl' }, 'Source is lost')
  })
  const playback = await loadManifest(join(directory, 'playback.json'))
  expect(playback.steps.map((step) => step.kind)).toEqual(['append', 'write', 'write', 'remove'])
  const profile = await createProfile()
  try {
    const player = createPlayer(playback, { roots: profile, timeScale: 0 })
    await player.play({ until: 'cleared' })
    expect(await readFile(join(profile.home, 'project/events.jsonl'), 'utf8')).toBe('{"type":"new"}\n')
    await player.play({ until: 'removed' })
    expect(await readFile(join(profile.home, 'project/events.jsonl'), 'utf8')).toBe('')
    await player.play()
    await expect(stat(join(profile.home, 'project/events.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await profile.dispose()
  }
  await expect(recordSession(config, () => Promise.resolve())).rejects.toThrow(/already exists/)
  await verifyRecording(directory)
})

test('kept TOML definition files of a temporary profile are checked before publication and replayed at their paths', async () => {
  const config = await options('codex')
  const canonicalHome = os === 'windows' ? 'C:/Users/USER' : os === 'macos' ? '/Users/USER' : '/home/USER'
  const declaration = '[agents.reviewer]\ndescription = "Reviews the notes"\nconfig_file = "agents/reviewer.toml"\n'
  let staged = ''
  const directory = await recordSession({ ...config, check: async (recording) => { staged = await readFile(join(recording, 'playback.json'), 'utf8') } }, async (session) => {
    await writeFile(join(session.codex, 'config.toml'), declaration)
    await mkdir(join(session.codex, 'agents'))
    await writeFile(join(session.codex, 'agents', 'reviewer.toml'), `developer_instructions = "Read ${join(session.home, 'notes.md').replaceAll('\\', '/')}"\n`)
    await writeFile(join(session.codex, 'hooks.toml'), 'kept = false\n')
    await expect(session.keep({ root: 'codex', path: 'hooks.json' })).rejects.toThrow(/TOML/)
    await expect(session.keep({ root: 'codex', path: '../config.toml' })).rejects.toThrow(/TOML/)
    await expect(session.keep({ root: 'codex', path: 'missing.toml' })).rejects.toMatchObject({ code: 'ENOENT' })
    await session.keep({ root: 'codex', path: 'config.toml' })
    await session.keep({ root: 'codex', path: 'agents/reviewer.toml' })
    await session.run(process.execPath, [runtimeScript, 'codex', 'first'])
    await appendFile(join(session.codex, 'config.toml'), '\n[features]\nhooks = true\n')
    await session.run(process.execPath, [runtimeScript, 'codex', 'second'])
  })
  await verifyRecording(directory)
  const playback = await loadManifest(join(directory, 'playback.json'))
  const kept = playback.steps.flatMap((step) => step.kind === 'write' && step.target.root === 'codex' ? [step.target.path] : [])
  expect(kept).toEqual(['config.toml', 'agents/reviewer.toml', 'config.toml'])
  expect(staged).toBe(await readFile(join(directory, 'playback.json'), 'utf8'))
  const profile = await createProfile()
  try {
    await createPlayer(playback, { roots: profile, timeScale: 0 }).play()
    expect(await readFile(join(profile.codex, 'config.toml'), 'utf8')).toBe(`${declaration}\n[features]\nhooks = true\n`)
    expect(await readFile(join(profile.codex, 'agents', 'reviewer.toml'), 'utf8')).toBe(`developer_instructions = "Read ${canonicalHome}/notes.md"\n`)
    await expect(stat(join(profile.codex, 'hooks.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await profile.dispose()
  }
  await expect(recordSession({ ...config, scenario: 'rejected', check: () => Promise.reject(new Error('The role is missing')) }, async (session) => {
    await session.run(process.execPath, [runtimeScript, 'codex', 'first'])
  })).rejects.toThrow('The role is missing')
  await expect(stat(join(config.fixturesRoot, 'codex', '0.0.1', 'codex_exec', os, 'rejected'))).rejects.toMatchObject({ code: 'ENOENT' })
  const owner = join(dirname(config.fixturesRoot), 'owner-codex')
  await mkdir(owner)
  await writeFile(join(owner, 'config.toml'), 'model = "owner"\n')
  vi.stubEnv('CODEX_HOME', owner)
  await expect(recordSession({ ...config, scenario: 'regular', codexHome: 'regular' }, async (session) => {
    await expect(session.keep({ root: 'codex', path: 'config.toml' })).rejects.toThrow(/temporary profile/)
  })).rejects.toThrow(/no captured events/)
})

test.each([
  ['surface mismatch', { surface: 'codex_exec' }],
  ['path traversal', { scenario: '../escape' }],
  ['missing expectations', { expectedFacts: [] }],
  ['Windows reserved directory', { scenario: 'CON' }],
] as const)('rejects %s before running the scenario', async (_name, override) => {
  const config = await options()
  const calls: string[] = []
  await expect(recordSession({ ...config, ...override }, () => { calls.push('run'); return Promise.resolve() })).rejects.toThrow()
  expect(calls).toEqual([])
})

test('incomplete sources and checkpoints without a captured event cannot be published', async () => {
  const config = await options()
  await expect(recordSession(config, async (session) => {
    await writeFile(join(session.project, 'unfinished.jsonl'), '{"type":')
  })).rejects.toThrow(/Incomplete JSONL/)
  await expect(recordSession(config, async (session) => {
    await session.checkpoint('missing', { root: 'home', path: 'project/missing.json' }, 'Changed')
  })).rejects.toThrow(/Checkpoint/)
})

test('a hook control event uses its receipt time and replays before the selected event', async () => {
  const config = await options()
  const directory = await recordSession(config, async (session) => {
    await session.run(process.execPath, [runtimeScript, 'claude', 'first'])
    await session.checkpoint('tool-finished', { hook: { event: 'PostToolUse', toolUseId: 'tool-first' } }, 'The action has completed')
  })
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    recorded_at: string
    control_events: { step: number; observed_at: string }[]
    artifacts: { source: string; mtime_ns: string }[]
  }
  const playback = await loadManifest(join(directory, 'playback.json'))
  const event = manifest.control_events[0]
  const step = playback.steps[event?.step ?? -1]
  expect(step?.kind).toBe('hook')
  const artifact = manifest.artifacts.find((item) => item.source === (step && 'source' in step ? step.source : undefined))
  expect(Date.parse(event?.observed_at ?? '')).toBe(Number(BigInt(artifact?.mtime_ns ?? '0') / 1_000_000n))
})

test('a long session with a large transcript and many hooks is captured while it runs, line by line', async () => {
  const config = await options()
  const written = 6_000
  const appended = 60
  const delivered = 600
  const directory = await recordSession(config, async (session) => {
    await session.run(process.execPath, [longSession, String(written), String(delivered), String(appended)], { timeoutMs: 120_000 })
  })
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { recorded_at: string }
  const playback = await loadManifest(join(directory, 'playback.json'))
  const started = Date.parse(manifest.recorded_at)
  const transcript = playback.steps.filter((step) => 'target' in step && step.target.path.endsWith('long.jsonl'))
  const lines = transcript.map((step) =>
    ('source' in step ? (playback.sources.get(step.source)?.toString('utf8') ?? '') : '').trim().split('\n').map((text) => JSON.parse(text) as { index: number; written_at: number }),
  )
  expect(transcript.every((step) => step.kind === 'append')).toBe(true)
  expect(lines.flat().map(({ index }) => index)).toEqual(Array.from({ length: written + appended }, (_, index) => index))
  expect(Math.max(...transcript.map((step, position) => started + step.at - Math.max(...(lines[position] ?? []).map(({ written_at: at }) => at))))).toBeLessThan(1_000)
  expect(playback.steps.filter((step) => step.kind === 'hook')).toHaveLength(delivered)
  const rewritten = playback.steps.filter((step) => 'target' in step && step.target.path.endsWith('rewritten.jsonl'))
  expect(rewritten.map((step) => [step.kind, 'source' in step ? (playback.sources.get(step.source)?.toString('utf8') ?? '').match(/event-\w+/g) : null])).toEqual([
    ['append', ['event-first', 'event-second', 'event-third']],
    ['write', ['event-shorter']],
    ['write', ['event-replaced']],
  ])
}, 180_000)

test('a hook control event selects a notification by its type', async () => {
  const config = await options()
  const directory = await recordSession(config, async (session) => {
    for (const type of ['elicitation_dialog', 'agent_needs_input', 'elicitation_dialog']) {
      await session.run(process.execPath, [hookScript, JSON.stringify({ hook_event_name: 'Notification', session_id: 'session-public-1', notification_type: type, message: `Needs input: ${type}` })])
    }
    await session.checkpoint('needs-input', { hook: { event: 'Notification', sessionId: 'session-public-1', notificationType: 'agent_needs_input' } }, 'The session needs input')
    await session.checkpoint('form', { hook: { event: 'Notification', notificationType: 'elicitation_dialog' }, occurrence: 'first' }, 'The form needs input')
    await expect(session.checkpoint('link', { hook: { event: 'Notification', notificationType: 'elicitation_url_dialog' } }, 'Never happens')).rejects.toThrow(/Checkpoint/)
  })
  const playback = await loadManifest(join(directory, 'playback.json'))
  const labelled = (label: string): { readonly index: number; readonly payload: unknown } => {
    const index = playback.steps.findIndex((item) => item.label === label)
    const step = playback.steps[index]
    return { index, payload: JSON.parse(playback.sources.get(step && 'source' in step ? step.source : '')?.toString() ?? 'null') }
  }
  expect(labelled('needs-input').payload).toMatchObject({ notification_type: 'agent_needs_input' })
  expect(labelled('form').payload).toMatchObject({ notification_type: 'elicitation_dialog' })
  expect(labelled('form').index).toBeLessThan(labelled('needs-input').index)
})

test('scenario failure stops an unfinished command and its descendants before cleanup', async () => {
  const config = await options('codex')
  const treeScript = fileURLToPath(new URL('./process-tree.ts', import.meta.url))
  let pids: number[] = []
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  try {
    await expect(recordSession(config, async (session) => {
      void session.run(process.execPath, [treeScript]).catch(() => undefined)
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const text = await readFile(join(session.project, 'pids.json'), 'utf8').catch(() => '')
        if (text) { pids = JSON.parse(text) as number[]; break }
        await new Promise((done) => setTimeout(done, 25))
      }
      expect(pids).toHaveLength(2)
      throw new Error('Scenario aborted')
    })).rejects.toThrow('Scenario aborted')
    expect(pids.map(alive)).toEqual([false, false])
  } finally {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch { continue }
    }
  }
})

test('verification detects every private input class independently of the recorder', async () => {
  const config = await options('codex')
  const directory = await recordSession(config, async (session) => {
    await writeFile(join(session.project, 'result.json'), '{"state":"done"}')
  })
  const vectors = [
    { path: '/Users/real-owner/project' },
    { path: '/home/real-owner/project' },
    { path: '/root/.codex/sessions' },
    { path: 'C:\\Users\\Имя Фамилия\\project' },
    { path: '%USERPROFILE%\\project' },
    { value: 'me.person@example.org' },
    { organizationUuid: 'c6c0d15b-e7f2-4012-bb9e-04fd09eebc9b' },
    { creator_account_id: 'acct-personal' },
    { installationId: 'installation-personal' },
    { creator_user_id: 'user-personal' },
    { nested: JSON.stringify({ accountId: 'nested-personal' }) },
    { attributes: [{ key: 'user.account_id', value: { stringValue: 'attribute-personal' } }] },
    { text: 'Raw JSON: {"organization_id":"organization-personal"}' },
    { access_token: 'synthetic-review-token-do-not-use' },
    { output: 'curl -H "Authorization: Bearer syntheticBearer0123456789"' },
    { attributes: [{ key: 'user.account_id', value: { stringValue: '123456' } }] },
    { attributes: [{ key: 'organization.id', value: { stringValue: 'abc' } }] },
    { text: String.raw`Raw JSON: {"cwd":"\/Users\/PrivatePerson\/work"}` },
    { text: String.raw`Raw JSON: {"cwd":"\u002fhome\u002fPrivatePerson\u002fwork"}` },
    { text: String.raw`Raw JSON: {"cwd":"C:\u005cUsers\u005cPrivatePerson\u005cwork"}` },
    { attributes: [{ key: 'host.name', value: { stringValue: 'Private-Laptop.local' } }] },
    { hostname: 'private-laptop' },
    { machine_id: '0123456789abcdef0123456789abcdef' },
    { pidDomain: 'linux:0123456789abcdef0123456789abcdef:pid:[4026531836]' },
    { pidDomain: 'win32:PRIVATE-DESKTOP' },
    { pidDomain: 'win32:bob' },
    { origin: JSON.stringify({ hostname: 'Private-Owner-Mac' }) },
    { status: 'Connected', source: JSON.stringify({ hostname: 'private-owner-mac' }) },
  ]
  for (const vector of vectors) {
    await writeFile(join(directory, 'unchecked.json'), JSON.stringify(vector))
    await expect(verifyRecording(directory), JSON.stringify(vector)).rejects.toThrow(/private/)
  }
})

test('JSON with duplicate keys is neither published nor accepted by verification', async () => {
  const config = await options('codex')
  const duplicates = [
    '{"cwd":"/Users/PrivateReviewPerson/work","cwd":"/fixture/project"}',
    '{"email":"private.review@example.org","email":"EMAIL_1"}',
    '{"account_id":"private-review-account-123","account_id":"ACCOUNT_1"}',
    JSON.stringify({ text: '{"cwd":"/Users/PrivateReviewPerson/work","\\u0063wd":"/fixture/project"}' }),
  ]
  for (const text of duplicates) {
    await expect(recordSession(config, async (session) => {
      await writeFile(join(session.project, 'duplicate.json'), text)
    }), text).rejects.toThrow(/duplicate keys/)
  }
  await expect(stat(join(config.fixturesRoot, 'codex'))).rejects.toMatchObject({ code: 'ENOENT' })
  const directory = await recordSession(config, async (session) => {
    await writeFile(join(session.project, 'result.json'), '{"items":[{"id":1,"state":"done"},{"id":2,"state":"done"}],"nested":"{\\"id\\":1}","text":"\\"id\\":1,\\"id\\":2"}')
  })
  for (const text of duplicates) {
    await writeFile(join(directory, 'unchecked.json'), text)
    await expect(verifyRecording(directory), text).rejects.toThrow(/duplicate keys/)
  }
})

test('masks credentials, short identities and escaped home paths while keeping exact values and agent paths', async () => {
  const config = await options('codex')
  const sample = await readFile(resolve('docs/research/samples/codex-sdk/rollout-session-meta.sdk-subagent.json'), 'utf8')
  const token = 'synthetic-review-token-do-not-use'
  const sessions = ['123456789012345678', '123456789012345679']
  let mtime = ''
  const directory = await recordSession(config, async (session) => {
    const file = join(session.project, 'private.json')
    await writeFile(join(session.project, 'agent.json'), sample)
    await writeFile(join(session.project, 'references.json'), JSON.stringify({ refs: ['abc', 'xy'], usage: { input_tokens: 123 } }))
    await writeFile(file, JSON.stringify({
      access_token: token,
      Authorization: `Bearer ${token}`,
      output: 'ANTHROPIC_API_KEY=sk-ant-synthetic-0001\ncurl -H "Authorization: Bearer syntheticBearer0123456789"',
      attributes: [
        { key: 'user.account_id', value: { stringValue: '123456' } },
        { key: 'organization.id', value: { stringValue: 'abc' } },
        { key: 'installation.id', value: { intValue: '987654' } },
      ],
      account_id: 123456,
      owner: { user_id: 'xy' },
      refs: ['123456', 'abc', 'xy'],
      usage: { input_tokens: 123456 },
      sessions,
      escaped: [
        String.raw`Raw JSON: {"cwd":"\/Users\/PrivatePerson\/work"}`,
        String.raw`Raw JSON: {"cwd":"\u002fhome\u002fPrivatePerson\u002fwork"}`,
        String.raw`Raw JSON: {"cwd":"C:\\Users\\Private Person\\work","alt":"C:\u005cUsers\u005cPrivatePerson\u005cwork"}`,
        String.raw`Raw JSON: {"cwd":"\/Users\/\u0418\u043c\u044f\/work"}`,
      ],
      config: '/root/.codex/config.toml',
    }))
    mtime = String((await stat(file, { bigint: true })).mtimeNs)
    await session.checkpoint('private', { root: 'home', path: 'project/private.json' }, 'Private values are captured')
  })
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as { artifacts: { source: string; mtime_ns: string }[] }
  const playback = await loadManifest(join(directory, 'playback.json'))
  const source = (path: string): string => {
    const step = playback.steps.find((item) => 'target' in item && item.target.path === path)
    return step && 'source' in step ? step.source : ''
  }
  const content = (path: string): string => playback.sources.get(source(path))?.toString() ?? ''
  expect(manifest.artifacts.find((artifact) => artifact.source === source('project/private.json'))?.mtime_ns).toBe(mtime)
  expect(content('project/private.json')).not.toMatch(/synthetic-review-token|sk-ant-synthetic|syntheticBearer|Private ?Person|u0418|987654|"(?:abc|xy)"/)
  const value = JSON.parse(content('project/private.json')) as {
    access_token: string
    Authorization: string
    output: string
    attributes: { key: string; value: { stringValue: string } }[]
    account_id: string
    owner: { user_id: string }
    refs: string[]
    usage: { input_tokens: number }
    sessions: string[]
    escaped: string[]
    config: string
  }
  expect(value.access_token).toMatch(/^SECRET_\d+$/)
  expect(value.Authorization).toBe(`Bearer ${value.access_token}`)
  expect(value.output).toMatch(/^ANTHROPIC_API_KEY=SECRET_\d+\ncurl -H "Authorization: Bearer SECRET_\d+"$/)
  expect(value.account_id).toMatch(/^ACCOUNT_\d+$/)
  expect(value.attributes[0]?.value.stringValue).toBe(value.account_id)
  expect(value.attributes[1]?.value.stringValue).toMatch(/^ORGANIZATION_\d+$/)
  expect(value.attributes[2]).toEqual({ key: 'installation.id', value: { stringValue: expect.stringMatching(/^INSTALLATION_\d+$/) as unknown } })
  expect(value.owner.user_id).toMatch(/^USER_\d+$/)
  expect(value.refs).toEqual([value.account_id, value.attributes[1]?.value.stringValue, value.owner.user_id])
  expect(JSON.parse(content('project/references.json'))).toEqual({ refs: value.refs.slice(1), usage: { input_tokens: 123 } })
  expect(value.usage.input_tokens).toBe(123456)
  expect(value.sessions).toEqual(sessions)
  expect(value.escaped).toEqual([
    String.raw`Raw JSON: {"cwd":"\/Users\/USER\/work"}`,
    String.raw`Raw JSON: {"cwd":"\u002fhome\u002fUSER\u002fwork"}`,
    String.raw`Raw JSON: {"cwd":"C:\\Users\\USER\\work","alt":"C:\u005cUsers\u005cUSER\u005cwork"}`,
    String.raw`Raw JSON: {"cwd":"\/Users\/USER\/work"}`,
  ])
  expect(value.config).toBe('/home/USER/.codex/config.toml')
  const agent = JSON.parse(content('project/agent.json')) as { payload: { source: { subagent: { thread_spawn: { agent_path: string } } } } }
  expect(agent.payload.source.subagent.thread_spawn.agent_path).toBe('/root/pong')
})

const recordedSource = (playback: Awaited<ReturnType<typeof loadManifest>>, root: string, path: string): string => {
  const step = playback.steps.find((item) => 'target' in item && item.target.root === root && item.target.path === path)
  return playback.sources.get(step && 'source' in step ? step.source : '')?.toString() ?? ''
}

const machineId = (): Promise<string> => readFile('/etc/machine-id', 'utf8').then((text) => text.trim(), () => '')

const prefixedJson = String.raw`JSON in text: {"text":"Connected to \u0050rivate-Owner-Mac"}`
const jsonBlock = ['```json', '{', String.raw`  "text": "Connected to \u0050rivate-Owner-Mac"`, '}', '```'].join('\n')

test.each([
  { name: 'Private-Laptop.local', spellings: ['PRIVATE-Laptop.local', 'pRiVaTe-LaPtOp.local', 'private-LAPTOP'] },
  { name: 'bob.local', spellings: ['bob', 'BOB.local', 'Bob'] },
  { name: '7-private.local', spellings: ['7-private', '7-PRIVATE.local'] },
  { name: 'bob', spellings: ['bob', 'BOB'] },
])('replaces the host name $name and the machine id of the recording machine in machine name fields in any letter case', async ({ name, spellings }) => {
  vi.stubEnv('COMPUTERNAME', name)
  const machine = await machineId()
  const identities = machine ? { machine_id: machine, registry: { pidDomain: `linux:${machine}:pid:[4026531836]` } } : {}
  const directory = await recordSession(await options('codex'), async (session) => {
    await writeFile(join(session.project, 'host.json'), JSON.stringify({
      resource: { attributes: [{ key: 'host.name', value: { stringValue: name } }] },
      params: { serverName: spellings[0], status: 'disabled' },
      pidDomain: `win32:${String(spellings.at(-1)).toUpperCase()}`,
      origin: JSON.stringify({ hostname: spellings.at(-1) }),
      ...identities,
      word: 'Bobsled',
      local: 'http://localhost:4318/v1/logs',
    }))
  })
  await verifyRecording(directory)
  const value = JSON.parse(recordedSource(await loadManifest(join(directory, 'playback.json')), 'home', 'project/host.json')) as { params: { serverName: string } }
  const host = value.params.serverName
  expect(host).toMatch(/^HOST_\d+$/)
  expect(value).toEqual({
    resource: { attributes: [{ key: 'host.name', value: { stringValue: host } }] },
    params: { serverName: host, status: 'disabled' },
    pidDomain: `win32:${host}`,
    origin: JSON.stringify({ hostname: host }),
    ...machine ? { machine_id: 'MACHINE_1', registry: { pidDomain: 'linux:MACHINE_1:pid:[4026531836]' } } : {},
    word: 'Bobsled',
    local: 'http://localhost:4318/v1/logs',
  })
})

test('verification rejects a host name or machine id of this machine anywhere in any file, including escaped JSON strings, but not inside longer words', async () => {
  vi.stubEnv('COMPUTERNAME', 'Private-Owner-Mac.local')
  const directory = await recordSession(await options('codex'), async (session) => {
    await writeFile(join(session.project, 'result.json'), String.raw`{"text":"Private-Owner-Machine and private-owner-macs","escaped":"\u0050rivate-Owner-Machine","nested":"{\"text\":\"\\u0050rivate-Owner-Macs\"}"}`)
  })
  await verifyRecording(directory)
  const machine = await machineId()
  const mentions = [
    'ssh Private-Owner-Mac', 'PRIVATE-OWNER-MAC.local:22', String.raw`{"text":"line\nprivate-owner-mac"}`, 'user_Private-Owner-Mac', 'Private-Owner-Mac-2',
    String.raw`{"text":"Connected to \u0050rivate-Owner-Mac"}`,
    String.raw`{"\u0050RIVATE-owner-mac.local":"online"}`,
    String.raw`{"payload":"{\"text\":\"Connected to \\u0050rivate-Owner-Mac\"}"}`,
    String.raw`{"payload":"{\"inner\":\"{\\\"text\\\":\\\"Private-Owner-\\\\u004dac\\\"}\"}"}`,
    String.raw`plain line` + '\n' + String.raw`["ssh \u0070rivate-owner-mac"]`,
    JSON.stringify({ description: prefixedJson }),
    JSON.stringify({ text: jsonBlock }),
    JSON.stringify({ payload: JSON.stringify({ text: jsonBlock }) }),
    ...machine ? [`id ${machine}`, String.raw`{"id":"\u00${machine.charCodeAt(0).toString(16)}${machine.slice(1)}"}`] : [],
  ]
  for (const mention of mentions) {
    await writeFile(join(directory, 'unchecked.txt'), mention)
    await expect(verifyRecording(directory), mention).rejects.toThrow(/^Recording file unchecked\.txt contains the (?:host name|machine id) "/)
  }
})

interface OtlpAttribute { readonly key: string; readonly value: { readonly stringValue: string } }
interface OtlpLogs {
  readonly resourceLogs: readonly {
    readonly resource: { readonly attributes: readonly OtlpAttribute[] }
    readonly scopeLogs: readonly { readonly logRecords: readonly { readonly attributes: readonly OtlpAttribute[] }[] }[]
  }[]
}

const identified = (logs: OtlpLogs, host: string, account: string): OtlpLogs => ({
  resourceLogs: logs.resourceLogs.map((resourceLogs) => ({
    ...resourceLogs,
    resource: {
      ...resourceLogs.resource,
      attributes: [
        ...resourceLogs.resource.attributes.filter(({ key }) => key !== 'host.name'),
        { key: 'host.name', value: { stringValue: host } },
        { key: 'user.account_id', value: { stringValue: account } },
      ],
    },
  })),
})

const decisionLogs = async (): Promise<OtlpLogs> =>
  JSON.parse(await readFile(new URL('codex-otel/logs.envelope.tool_decision.approved-user.app-server.json', samples), 'utf8')) as OtlpLogs

const sendOtlp = async (session: RecordContext, logs: OtlpLogs): Promise<void> => {
  const response = await fetch(session.otlp, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(logs) })
  await response.arrayBuffer()
}

test('the host name in OTLP resource attributes is replaced while the Codex adapter reads the same facts', async () => {
  vi.stubEnv('COMPUTERNAME', 'Private-Owner-Mac')
  const { resourceLogs } = await decisionLogs()
  const sent = identified({ resourceLogs }, 'Private-Owner-Mac', 'acct-private-4477')
  const directory = await recordSession(await options('codex'), async (session) => {
    await sendOtlp(session, sent)
  })
  await verifyRecording(directory)
  const playback = await loadManifest(join(directory, 'playback.json'))
  const step = playback.steps.find((item) => item.kind === 'otlp')
  const recorded = playback.sources.get(step && 'source' in step ? step.source : '')?.toString() ?? ''
  const received = JSON.parse(recorded) as OtlpLogs
  const resource = Object.fromEntries(received.resourceLogs[0]?.resource.attributes.map(({ key, value }) => [key, value.stringValue]) ?? [])
  expect(resource['host.name']).toMatch(/^HOST_\d+$/)
  expect(resource['user.account_id']).toMatch(/^ACCOUNT_\d+$/)
  expect(received).toEqual(identified({ resourceLogs }, String(resource['host.name']), String(resource['user.account_id'])))
  const conversation = resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes.find(({ key }) => key === 'conversation.id')?.value.stringValue
  const stream = codexAdapter.streamKey([JSON.stringify({ hook_event_name: 'SessionStart', session_id: conversation })])
  const parse = (payload: string): ParseResult => codexAdapter.parse(CollectedRecord.parse({
    channel: 'otel', runtime: 'codex', stream, hook: null, observed_at: 1_790_856_592_228_739_000n, payload, position: { kind: 'otel' },
  }))
  expect(parse(recorded)).toMatchObject({ parse_state: 'parsed', facts: [{ kind: 'permission_decision', payload: { decision: 'approved', source: 'user' } }] })
  expect(parse(recorded)).toEqual(parse(JSON.stringify(sent)))
})

const runtimeFile = { claude: 'projects/sample/session.jsonl', codex: 'sessions/2026/10/01/rollout-2026-10-01T12-00-00-sample.jsonl' } as const

const sampleRecord = async (sample: string, line = 0): Promise<string> => {
  const text = await readFile(new URL(sample, samples), 'utf8')
  return JSON.stringify(JSON.parse(sample.endsWith('.jsonl') ? text.trim().split('\n')[line] ?? '' : text))
}

type Write = (session: RecordContext) => Promise<unknown>

const runtimeLine = (root: 'claude' | 'codex', sample: string, line = 0, mention?: readonly [string, string]): Write => async (session) => {
  const record = await sampleRecord(sample, line)
  const file = join(root === 'claude' ? session.claude : session.codex, runtimeFile[root])
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${mention === undefined ? record : record.replaceAll(...mention)}\n`)
}

const hookEvent = (payload: string | Readonly<Record<string, unknown>>, mention?: readonly [string, string]): Write => async (session) => {
  const record = typeof payload === 'string' ? await sampleRecord(payload) : JSON.stringify({ session_id: 'session-public-1', ...payload })
  await session.run(process.execPath, [hookScript, mention === undefined ? record : record.replaceAll(...mention)])
}

const projectFile = (content: string | Readonly<Record<string, unknown>>): Write => (session) =>
  writeFile(join(session.project, 'result.json'), typeof content === 'string' ? content : JSON.stringify(content))

const commandMarkers = 'claude-code-transcripts/rec-compact-local-command-users.jsonl'
const bashFailure = 'claude-code-hooks/PostToolUseFailure.Bash.json'

test.each([
  { name: 'command-name', runtime: 'claude', source: 'a Claude command marker', write: runtimeLine('claude', commandMarkers, 1) },
  { name: 'local-command-stdout', runtime: 'claude', source: 'a Claude command output marker', write: runtimeLine('claude', commandMarkers, 2) },
  { name: 'code', runtime: 'claude', source: 'the exit code prefix of a hook error', write: hookEvent(bashFailure) },
  { name: '1', runtime: 'claude', source: 'the exit code of a hook error', write: hookEvent(bashFailure) },
  { name: 'user', runtime: 'claude', source: 'a Claude record type', write: runtimeLine('claude', 'claude-code-transcripts/rec-user-prompt.json') },
  { name: 'Agent', runtime: 'claude', source: 'a Claude tool name', write: runtimeLine('claude', 'claude-code-transcripts/rec-assistant-tool-use-agent.json') },
  { name: 'end_turn', runtime: 'claude', source: 'a Claude stop reason', write: runtimeLine('claude', 'claude-code-transcripts/rec-assistant-text-end-turn.json') },
  { name: 'interrupted', runtime: 'codex', source: 'a Codex interruption reason', write: runtimeLine('codex', 'codex-cli/rollout/event_msg.turn_aborted.mock-tui.json') },
  { name: 'collaboration', runtime: 'codex', source: 'a Codex tool namespace', write: runtimeLine('codex', 'codex-cli/rollout/response_item.function_call.spawn_agent.mock.json') },
  {
    name: 'Private-Owner-Mac', runtime: 'claude', source: 'Claude message text',
    write: runtimeLine('claude', 'claude-code-transcripts/rec-assistant-text-end-turn.json', 0, ['"text":"OK"', '"text":"Connected to Private-Owner-Mac"']),
  },
  {
    name: 'Private-Owner-Mac', runtime: 'claude', source: 'escaped Claude message text',
    write: runtimeLine('claude', 'claude-code-transcripts/rec-assistant-text-end-turn.json', 0, ['"text":"OK"', String.raw`"text":"Connected to \u0050rivate-Owner-Mac"`]),
  },
  {
    name: 'Private-Owner-Mac', runtime: 'claude', source: 'an escaped permission denial reason in the spool',
    write: hookEvent({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_use_id: 'toolu_denied', reason: 'SSH to Private-Owner-Mac was denied by the user' }, ['Private', String.raw`\u0050rivate`]),
  },
  {
    name: 'Private-Owner-Mac', runtime: 'claude', source: 'escaped JSON after a text prefix in Claude message text',
    write: runtimeLine('claude', 'claude-code-transcripts/rec-assistant-text-end-turn.json', 0, ['"text":"OK"', `"text":${JSON.stringify(prefixedJson)}`]),
  },
  {
    name: 'Private-Owner-Mac', runtime: 'claude', source: 'an escaped multiline JSON block in Claude message text',
    write: runtimeLine('claude', 'claude-code-transcripts/rec-assistant-text-end-turn.json', 0, ['"text":"OK"', `"text":${JSON.stringify(jsonBlock)}`]),
  },
  { name: 'Private-Owner-Mac', runtime: 'codex', source: 'escaped JSON after a text prefix in a project value', write: projectFile({ description: prefixedJson }) },
  { name: 'Private-Owner-Mac', runtime: 'codex', source: 'an escaped project value', write: projectFile(String.raw`{"text":"Connected to \u0050rivate-Owner-Mac"}`) },
  {
    name: 'Private-Owner-Mac', runtime: 'codex', source: 'an escaped value of nested serialized JSON',
    write: projectFile(String.raw`{"payload":"{\"text\":\"Connected to \\u0050rivate-Owner-Mac\"}"}`),
  },
  {
    name: 'Private-Owner-Mac', runtime: 'claude', source: 'a permission denial reason',
    write: hookEvent({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_use_id: 'toolu_denied', reason: 'SSH to Private-Owner-Mac was denied by the user' }),
  },
  {
    name: 'Private-Owner-Mac', runtime: 'claude', source: 'an MCP tool result',
    write: hookEvent({ hook_event_name: 'PostToolUse', tool_name: 'mcp__inspect__host', tool_use_id: 'toolu_mcp', tool_response: { status: 'Connected to Private-Owner-Mac' } }),
  },
  {
    name: 'Private-Owner-Mac', runtime: 'codex', source: 'project values and addresses',
    write: projectFile({ status: 'Connected to Private-Owner-Mac', source: 'ssh://Private-Owner-Mac/project', type: 'private-owner-mac' }),
  },
  { name: 'host', runtime: 'codex', source: 'an OTLP attribute name', write: async (session: RecordContext) => sendOtlp(session, identified(await decisionLogs(), 'host', 'acct-private-4477')) },
  { name: 'plugin', runtime: 'claude', source: 'a spool header', write: (session: RecordContext) => session.run(process.execPath, [runtimeScript, 'claude', 'first']) },
  { name: 'data', runtime: 'codex', source: 'the recording layout', write: projectFile({ state: 'done' }) },
  { name: 'home', runtime: 'codex', source: 'a playback target root', write: projectFile({ state: 'done' }) },
] as const)('the host name $name in $source aborts the recording and publishes nothing', async ({ name, runtime, write }) => {
  vi.stubEnv('COMPUTERNAME', name)
  const config = await options(runtime)
  let project = ''
  await expect(recordSession(config, async (session) => {
    project = session.project
    await write(session)
  })).rejects.toThrow(`contains the host name "${name}" of this machine, which anonymization replaces only in machine name fields and never in free text or other values`)
  await expect(stat(project)).rejects.toMatchObject({ code: 'ENOENT' })
  const destination = join(config.fixturesRoot, runtime, '0.0.1', config.surface, os, 'tools')
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(dirname(destination))).toEqual([])
})

test('rejects a missing, directory or non-executable hook binary before running the scenario', async () => {
  const config = await options()
  const plain = join(dirname(config.fixturesRoot), 'aang-hook')
  await writeFile(plain, '', { mode: 0o644 })
  const calls: string[] = []
  for (const hookBinary of ['packages/hook/bin/missing-aang-hook', 'packages/hook/bin', ...(process.platform === 'win32' ? [] : [plain])]) {
    await expect(recordSession({ ...config, hookBinary }, () => { calls.push(hookBinary); return Promise.resolve() }), hookBinary).rejects.toThrow(/Hook binary/)
  }
  expect(calls).toEqual([])
})

test('source root symlinks cannot collect files outside the recording profile', async () => {
  const config = await options()
  const outside = join(config.fixturesRoot, 'outside')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'foreign.json'), '{"should_not_be_recorded":true}')
  await expect(recordSession(config, async (session) => {
    await symlink(outside, join(session.claude, 'projects'), 'junction')
  })).rejects.toThrow(/symbolic links/)
})

test('a caught command failure still prevents publishing a partial session', async () => {
  const config = await options()
  await expect(recordSession(config, async (session) => {
    await session.run(process.execPath, [runtimeScript, 'claude', 'fail']).catch(() => undefined)
  })).rejects.toThrow(/7/)
  await expect(stat(join(config.fixturesRoot, 'claude', '0.0.1', 'claude_cli', os, 'tools'))).rejects.toMatchObject({ code: 'ENOENT' })
})
