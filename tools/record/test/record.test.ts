import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlayer, createProfile, loadManifest, leaseSpool } from '@aang/testkit'
import { afterEach, expect, test } from 'vitest'
import { recordSession, verifyRecording, type RecordContext, type RecordOptions } from '../dist/index.js'

const temporary: string[] = []
const runtimeScript = fileURLToPath(new URL('./runtime.ts', import.meta.url))
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
  ]
  for (const vector of vectors) {
    await writeFile(join(directory, 'unchecked.json'), JSON.stringify(vector))
    await expect(verifyRecording(directory), JSON.stringify(vector)).rejects.toThrow(/private/)
  }
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
