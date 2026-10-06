import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createPlayer, loadManifest, ManifestError, PlaybackError } from '@aang/testkit'
import { describe, test } from 'vitest'
import { createFixture, linesOf, sampleBytes } from './manifests.js'

const transcriptSample = 'claude-code-transcripts/session-86f93ed5-main-full.jsonl'
const transcriptTarget = { root: 'claude', path: 'projects/-tmp-aang-spike-cc-transcripts-run/86f93ed5.jsonl' }

const filesUnder = async (root: string): Promise<Record<string, string>> => {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry): Promise<[string, string]> => {
        const path = join(entry.parentPath, entry.name)
        return [relative(root, path).replaceAll('\\', '/'), await readFile(path, 'utf8')]
      }),
  )
  return Object.fromEntries(files.sort(([left], [right]) => left.localeCompare(right)))
}

describe.concurrent('the file player reproduces runtime files in a temporary profile', () => {
  test('retrying a failed append writes the original chunk and resumes without skipping source bytes', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile, manifest } = await createFixture(onTestFinished)
    const source = Buffer.from('{"n":1}\n{"n":2}\n')
    const target = { root: 'home', path: 'retry.jsonl' }
    const file = await manifest('retry-append', {
      sources: { 'lines.jsonl': source },
      steps: [
        { at: 0, kind: 'append', target, source: 'lines.jsonl', lines: 1 },
        { at: 0, kind: 'append', target, source: 'lines.jsonl', label: 'rest' },
      ],
    })
    const player = createPlayer(await loadManifest(file), { roots: profile, timeScale: 0 })
    const path = join(profile.home, target.path)
    await mkdir(path)

    await expect(player.play()).rejects.toThrow(PlaybackError)
    expect(player.position()).toBe(0)
    expect(player.finished()).toBe(false)
    await rm(path, { recursive: true })

    await player.play({ until: 'rest' })

    expect(await readFile(path)).toEqual(Buffer.from('{"n":1}\n'))
    expect(player.position()).toBe(1)
    await player.play()
    expect(await readFile(path)).toEqual(source)
    expect(player.finished()).toBe(true)
  })

  test('a transcript played line by line ends up byte-identical to its source, and playback can stop at a label and resume', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile, manifest } = await createFixture(onTestFinished)
    const transcript = sampleBytes(transcriptSample)
    const awkward = Buffer.from(
      '{"text":"первая строка ✓"}\r\n{"text":"🙂 вторая"}\r\n{"text":"без перевода строки"}',
      'utf8',
    )
    const awkwardTarget = { root: 'codex', path: 'sessions/2026/10/01/rollout-awkward.jsonl' }
    const file = await manifest('byte-identical', {
      sources: { 'transcript.jsonl': transcript, 'awkward.jsonl': awkward },
      steps: [
        { at: 0, kind: 'append', target: transcriptTarget, source: 'transcript.jsonl', lines: 1 },
        { at: 5, kind: 'append', target: transcriptTarget, source: 'transcript.jsonl', lines: 2 },
        { at: 10, kind: 'append', target: awkwardTarget, source: 'awkward.jsonl', bytes: 30 },
        { at: 15, kind: 'append', target: transcriptTarget, source: 'transcript.jsonl', lines: 40 },
        { at: 20, kind: 'append', target: awkwardTarget, source: 'awkward.jsonl', bytes: 7, label: 'split character' },
        { at: 25, kind: 'append', target: transcriptTarget, source: 'transcript.jsonl', label: 'rest' },
        { at: 30, kind: 'append', target: awkwardTarget, source: 'awkward.jsonl' },
      ],
    })
    const player = createPlayer(await loadManifest(file), { roots: profile, timeScale: 0 })
    const transcriptPath = join(profile.claude, ...transcriptTarget.path.split('/'))
    const awkwardPath = join(profile.codex, ...awkwardTarget.path.split('/'))

    const first = await player.play({ until: 'split character' })

    const lineBytes = (from: number, to: number): number => Buffer.concat(linesOf(transcript).slice(from, to)).length
    expect(first.map((step) => step.index)).toEqual([0, 1, 2, 3])
    expect(first.map((step) => step.appended)).toEqual([
      { offset: 0, bytes: lineBytes(0, 1) },
      { offset: lineBytes(0, 1), bytes: lineBytes(1, 3) },
      { offset: 0, bytes: 30 },
      { offset: lineBytes(0, 3), bytes: lineBytes(3, 43) },
    ])
    expect(player.position()).toBe(4)
    expect(readFileSync(transcriptPath)).toEqual(Buffer.concat(linesOf(transcript).slice(0, 43)))
    expect(readFileSync(awkwardPath)).toEqual(awkward.subarray(0, 30))

    const second = await player.play({ until: 'rest' })

    expect(second.map((step) => [step.index, step.label, step.appended])).toEqual([
      [4, 'split character', { offset: 30, bytes: 7 }],
    ])
    expect(readFileSync(awkwardPath)).toEqual(awkward.subarray(0, 37))
    expect(awkward.subarray(0, 37).toString('utf8')).toContain('�')

    await player.play()

    expect(player.finished()).toBe(true)
    expect(readFileSync(transcriptPath)).toEqual(transcript)
    expect(readFileSync(awkwardPath)).toEqual(awkward)
  })

  test(
    'steps keep their recorded intervals multiplied by the time scale',
    { concurrent: false },
    async ({ expect, onTestFinished }) => {
      const { profile, manifest } = await createFixture(onTestFinished)
      const source = Buffer.from('{"n":1}\n{"n":2}\n{"n":3}\n{"n":4}\n')
      const timeScale = 0.1
      const recorded = [0, 3_000, 6_000, 12_000]
      const file = await manifest('intervals', {
        sources: { 'lines.jsonl': source },
        steps: recorded.map((at) => ({
          at,
          kind: 'append',
          target: transcriptTarget,
          source: 'lines.jsonl',
          lines: 1,
        })),
      })
      const target = join(profile.claude, ...transcriptTarget.path.split('/'))
      const sizeAfter = linesOf(source).map((_, index) => Buffer.concat(linesOf(source).slice(0, index + 1)).length)
      const player = createPlayer(await loadManifest(file), { roots: profile, timeScale })
      const observed: number[] = []

      const startedAt = performance.now()
      const playing = player.play()
      while (observed.length < sizeAfter.length) {
        const size = existsSync(target) ? statSync(target).size : 0
        while (observed.length < sizeAfter.length && size >= (sizeAfter[observed.length] ?? Infinity)) {
          observed.push(performance.now() - startedAt)
        }
        await sleep(1)
      }
      await playing

      recorded.forEach((at, index) => {
        expect(observed[index]).toBeGreaterThanOrEqual(at * timeScale)
        expect(observed[index]).toBeLessThan(at * timeScale + 1_000)
      })

      const instant = await manifest('instant', {
        sources: { 'lines.jsonl': source },
        steps: [
          { at: 0, kind: 'append', target: { root: 'home', path: 'instant.jsonl' }, source: 'lines.jsonl', lines: 1 },
          { at: 60_000, kind: 'append', target: { root: 'home', path: 'instant.jsonl' }, source: 'lines.jsonl' },
        ],
      })
      const instantStartedAt = performance.now()
      await createPlayer(await loadManifest(instant), { roots: profile, timeScale: 0 }).play()
      expect(performance.now() - instantStartedAt).toBeLessThan(5_000)
      expect(readFileSync(join(profile.home, 'instant.jsonl'))).toEqual(source)
    },
  )

  test('records played at playback time carry timestamps shifted to the playback moment with their intervals kept', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile, manifest } = await createFixture(onTestFinished)
    const lines = Buffer.from(
      [
        '{"timestamp":"2026-10-01T11:49:30.942Z","message":{"text":"at 2026-10-01T11:49:30.942Z"}}',
        '{"timestamp":"2026-10-01T11:49:33.442Z","toolUseResult":{"at":"2026-10-01T11:49:34.000000Z"}}',
        '',
      ].join('\n'),
    )
    const meta = '{"agentType":"pinger","createdAt":"2026-10-01T11:49:35.000Z"}'
    const target = { root: 'claude', path: 'projects/-tmp-p/live.jsonl' }
    const file = await manifest('playback-time', {
      sources: { 'lines.jsonl': lines, 'meta.json': meta },
      steps: [
        { at: 0, kind: 'append', target, source: 'lines.jsonl', lines: 1 },
        { at: 2_500, kind: 'append', target, source: 'lines.jsonl' },
        { at: 4_058, kind: 'write', target: { root: 'claude', path: 'projects/-tmp-p/meta.json' }, source: 'meta.json' },
      ],
    })
    const before = Date.now()
    const player = createPlayer(await loadManifest(file), { roots: profile, timeScale: 0, recordTime: 'playback' })
    const after = Date.now()
    await player.play()

    const [first, second] = (await readFile(join(profile.claude, ...target.path.split('/')), 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { timestamp: string; message?: { text: string }; toolUseResult?: { at: string } })
    const start = Date.parse(first?.timestamp ?? '')
    expect(start).toBeGreaterThan(before - 1_000)
    expect(start).toBeLessThanOrEqual(after)
    expect(first?.message?.text).toBe('at 2026-10-01T11:49:30.942Z')
    expect(Date.parse(second?.timestamp ?? '') - start).toBe(2_500)
    expect(Date.parse(second?.toolUseResult?.at ?? '') - start).toBe(3_058)
    const written = JSON.parse(await readFile(join(profile.claude, 'projects', '-tmp-p', 'meta.json'), 'utf8')) as {
      agentType: string
      createdAt: string
    }
    expect(written.agentType).toBe('pinger')
    expect(Date.parse(written.createdAt) - start).toBe(4_058)
  })

  test('records played from a given moment start within the second before it with their intervals kept', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile, manifest } = await createFixture(onTestFinished)
    const lines = [
      '{"timestamp":"2026-10-01T11:49:30.942Z","started_at_ms":1790855370942}',
      '{"timestamp":"2026-10-01T11:49:33.442Z","started_at_ms":1790855373442}',
      '',
    ].join('\n')
    const target = { root: 'codex', path: 'sessions/2026/10/01/rollout-moment.jsonl' }
    const file = await manifest('moment', {
      sources: { 'lines.jsonl': lines },
      steps: [{ at: 0, kind: 'append', target, source: 'lines.jsonl' }],
    })
    const startsAt = Date.parse('2026-10-03T08:00:00.000Z')

    await createPlayer(await loadManifest(file), { roots: profile, timeScale: 0, recordTime: { startsAt } }).play()

    const played = (await readFile(join(profile.codex, ...target.path.split('/')), 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { timestamp: string; started_at_ms: number })
    expect(played).toEqual([
      { timestamp: '2026-10-03T07:59:59.942Z', started_at_ms: startsAt - 58 },
      { timestamp: '2026-10-03T08:00:02.442Z', started_at_ms: startsAt + 2_442 },
    ])
  })

  test('byte steps at playback time split a timestamp, an epoch number and a character where the source splits them, and the record comes out whole', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile, manifest } = await createFixture(onTestFinished)
    const head = '{"timestamp":"2026-10-01T11:49:30.942Z","at":"2026-10-01T11:49:31Z","started_at_ms":1790855370942,"text":"'
    const source = Buffer.from(`${head}Привет"}\n`, 'utf8')
    const epoch = head.indexOf('1790855370942')
    const digit = epoch + 6
    const letter = Buffer.byteLength(head)
    const target = { root: 'home', path: 'split.jsonl' }
    const file = await manifest('playback-split', {
      sources: { 'lines.jsonl': source },
      steps: [
        { at: 0, kind: 'append', target, source: 'lines.jsonl', bytes: 25 },
        { at: 1, kind: 'append', target, source: 'lines.jsonl', bytes: digit - 25, label: 'split epoch' },
        { at: 2, kind: 'append', target, source: 'lines.jsonl', bytes: letter + 1 - digit, label: 'split letter' },
        { at: 3, kind: 'append', target, source: 'lines.jsonl', label: 'rest' },
      ],
    })
    const before = Date.now()
    const player = createPlayer(await loadManifest(file), { roots: profile, timeScale: 0, recordTime: 'playback' })
    const after = Date.now()
    const path = join(profile.home, target.path)

    await player.play({ until: 'split epoch' })
    const split = await readFile(path)
    expect(split).toHaveLength(25)
    expect(split).not.toEqual(source.subarray(0, 25))
    await player.play({ until: 'split letter' })
    const numbered = await readFile(path)
    expect(numbered).toHaveLength(digit)
    expect(numbered.subarray(0, 25)).toEqual(split)
    expect(numbered.subarray(epoch)).not.toEqual(source.subarray(epoch, digit))
    await player.play({ until: 'rest' })
    const cut = await readFile(path)
    expect(cut).toHaveLength(letter + 1)
    expect(cut.subarray(0, digit)).toEqual(numbered)
    expect(cut.subarray(letter)).toEqual(Buffer.from('П').subarray(0, 1))
    await player.play()

    const whole = await readFile(path)
    expect(whole).toHaveLength(source.length)
    expect(whole.subarray(0, letter + 1)).toEqual(cut)
    expect(whole.subarray(letter)).toEqual(source.subarray(letter))
    const record = JSON.parse(whole.toString('utf8')) as {
      timestamp: string
      at: string
      started_at_ms: number
      text: string
    }
    expect(record.text).toBe('Привет')
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.942Z$/)
    expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const start = Date.parse(record.timestamp)
    expect(start).toBeGreaterThan(before - 1_000)
    expect(start).toBeLessThanOrEqual(after)
    expect(Date.parse(record.at) - start).toBe(58)
    expect(record.started_at_ms).toBe(start)
  })

  test('JSON files are written whole and rewritten, transcripts are moved and archived, and files are removed', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile, manifest } = await createFixture(onTestFinished)
    const transcript = Buffer.from('{"uuid":"a"}\n{"uuid":"b"}\n{"uuid":"c"}\n')
    const rollout = Buffer.from('{"type":"session_meta"}\n{"type":"turn_context"}\n')
    const metaBefore = '{"agentType":"pinger"}'
    const metaAfter = '{"agentType":"pinger","description":"ping"}'
    const meta = { root: 'claude', path: 'projects/-tmp-p/s1/subagents/agent-a.meta.json' }
    const before = { root: 'claude', path: 'projects/-tmp-p/s1.jsonl' }
    const after = { root: 'claude', path: 'projects/-tmp-q/s1.jsonl' }
    const registry = { root: 'claude', path: 'sessions/4242.json' }
    const live = { root: 'codex', path: 'sessions/2026/10/01/rollout-2026-10-01T15-07-28-thread.jsonl' }
    const file = await manifest('files', {
      sources: {
        'meta-before.json': metaBefore,
        'meta-after.json': metaAfter,
        'registry.json': '{"pid":4242,"status":"busy"}',
        'transcript.jsonl': transcript,
        'rollout.jsonl': rollout,
        'report.md': '# Report\n',
      },
      steps: [
        { at: 0, kind: 'write', target: meta, source: 'meta-before.json' },
        { at: 1, kind: 'append', target: before, source: 'transcript.jsonl', lines: 2 },
        { at: 2, kind: 'write', target: registry, source: 'registry.json' },
        { at: 3, kind: 'append', target: live, source: 'rollout.jsonl' },
        { at: 4, kind: 'write', target: meta, source: 'meta-after.json', label: 'rewrite' },
        { at: 5, kind: 'move', target: before, to: after },
        { at: 6, kind: 'append', target: after, source: 'transcript.jsonl' },
        { at: 7, kind: 'archive', target: live },
        { at: 8, kind: 'remove', target: registry },
        { at: 9, kind: 'write', target: { root: 'home', path: 'work/report.md' }, source: 'report.md' },
      ],
    })
    const player = createPlayer(await loadManifest(file), { roots: profile, timeScale: 0 })
    const path = (target: { root: string; path: string }): string =>
      join(target.root === 'claude' ? profile.claude : profile.codex, ...target.path.split('/'))

    await player.play({ until: 'rewrite' })

    expect(await readFile(path(meta), 'utf8')).toBe(metaBefore)
    const transcriptInode = (await stat(path(before), { bigint: true })).ino
    const rolloutInode = (await stat(path(live), { bigint: true })).ino

    await player.play()

    expect(await filesUnder(profile.home)).toEqual({
      '.aang/config.json': await readFile(join(profile.aangHome, 'config.json'), 'utf8'),
      '.claude/projects/-tmp-p/s1/subagents/agent-a.meta.json': metaAfter,
      '.claude/projects/-tmp-q/s1.jsonl': transcript.toString('utf8'),
      '.codex/archived_sessions/rollout-2026-10-01T15-07-28-thread.jsonl': rollout.toString('utf8'),
      'work/report.md': '# Report\n',
    })
    expect((await stat(path(after), { bigint: true })).ino).toBe(transcriptInode)
    expect(
      (
        await stat(join(profile.codex, 'archived_sessions', 'rollout-2026-10-01T15-07-28-thread.jsonl'), {
          bigint: true,
        })
      ).ino,
    ).toBe(rolloutInode)
  })

  test('a manifest that cannot be played is rejected with the reason before it plays', async ({
    expect,
    onTestFinished,
  }) => {
    const { profile, manifest } = await createFixture(onTestFinished)
    const append = { kind: 'append', target: { root: 'home', path: 'a.jsonl' }, source: 'a.jsonl' }
    const sources = { 'a.jsonl': '{"n":1}\n' }
    const invalid: [string, readonly unknown[], string][] = [
      [
        'unordered',
        [
          { ...append, at: 5 },
          { ...append, at: 1 },
        ],
        'steps must be ordered by time',
      ],
      ['escaping', [{ ...append, at: 0, target: { root: 'home', path: '../outside.jsonl' } }], 'stays inside its root'],
      ['absolute', [{ ...append, at: 0, target: { root: 'claude', path: '/etc/passwd' } }], 'stays inside its root'],
      ['unknown root', [{ ...append, at: 0, target: { root: 'aang', path: 'spool/x' } }], 'root'],
      [
        'archive outside sessions',
        [{ at: 0, kind: 'archive', target: { root: 'codex', path: 'x.jsonl' } }],
        'sessions/',
      ],
      [
        'duplicate labels',
        [
          { ...append, at: 0, label: 'x' },
          { ...append, at: 1, label: 'x' },
        ],
        'labels must be unique',
      ],
      ['lines and bytes', [{ ...append, at: 0, lines: 1, bytes: 1 }], 'lines and bytes are exclusive'],
      ['missing source', [{ ...append, at: 0, source: 'missing.jsonl' }], 'cannot read source missing.jsonl'],
      ['unknown kind', [{ at: 0, kind: 'truncate', target: { root: 'home', path: 'a.jsonl' } }], 'kind'],
    ]
    for (const [name, steps, reason] of invalid) {
      const load = loadManifest(await manifest(name, { sources, steps }))
      await expect(load, name).rejects.toThrow(ManifestError)
      await expect(load, name).rejects.toThrow(reason)
    }

    const hooks = await loadManifest(
      await manifest('hook without target', {
        sources,
        steps: [{ at: 0, kind: 'hook', runtime: 'claude', registration: 'plugin', source: 'a.jsonl' }],
      }),
    )
    expect(() => createPlayer(hooks, { roots: profile })).toThrow('has hook steps, but the player has no hook target')
    const otlp = await loadManifest(
      await manifest('otlp without endpoint', { sources, steps: [{ at: 0, kind: 'otlp', source: 'a.jsonl' }] }),
    )
    expect(() => createPlayer(otlp, { roots: profile })).toThrow('has OTLP steps, but the player has no OTLP endpoint')
    const plain = await loadManifest(await manifest('plain', { sources, steps: [{ ...append, at: 0, label: 'only' }] }))
    expect(() => createPlayer(plain, { roots: profile, timeScale: -1 })).toThrow('time scale')
    await expect(createPlayer(plain, { roots: profile }).play({ until: 'missing' })).rejects.toThrow(
      'no step labelled "missing"',
    )

    const exhausted = createPlayer(
      await loadManifest(
        await manifest('exhausted', {
          sources,
          steps: [
            { ...append, at: 0 },
            { ...append, at: 0, lines: 1, label: 'more' },
          ],
        }),
      ),
      { roots: profile, timeScale: 0 },
    )
    const failure = exhausted.play()
    await expect(failure).rejects.toThrow(PlaybackError)
    await expect(failure).rejects.toThrow('step 1 (append "more") failed: source a.jsonl has 0 of 1 lines left')
    expect(exhausted.position()).toBe(1)
  })
})
