import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClaudeReply } from '@aang/testkit'
import { describe, expect, onTestFinished, test } from 'vitest'
import { Annotations, FixedProfile, Measurement, Report } from '../dist/index.js'
import {
  claudeRecording,
  codexRecording,
  createWorkspace,
  isAlive,
  type Recorded,
  readRecorded,
  repositoryFixtures,
  type Workspace,
} from './fixtures.js'

const workspace = async (): Promise<Workspace> => {
  const created = await createWorkspace()
  onTestFinished(created.dispose)
  return created
}

const loadProfile = (name: string, windowMs: number, cli: string | null, runs: readonly object[]) => ({
  format: 'aang-freshness-profile/1',
  name,
  window_ms: windowMs,
  observer: { claude: { cli, target_p95_ms: 30_000 } },
  runs,
})

const needsReply: ClaudeReply = {
  kind: 'answer',
  output: {
    base_version: { $input: '/model/version' },
    ops: [],
    needs: [{ kind: 'raw_record', seq: { $input: '/batch/facts/0/seq' } }],
  },
}

const mainStageCitingEvent = { stage: { title: '^Main work$', evidence: 'event' } }

const eventOf = (report: Report, label: string): Report['events'][number] => {
  const found = report.events.find((event) => event.label === label)
  if (found === undefined) {
    throw new Error(`the report has no event ${label}`)
  }
  return found
}

const measuredEvent = (measurement: Measurement, label: string): Measurement['events'][number] => {
  const found = measurement.events.find((event) => event.label === label)
  if (found === undefined) {
    throw new Error(`the measurement has no event ${label}`)
  }
  return found
}

const repeatedBefore =
  (label: string, gapMs: number) =>
  ({ manifest, steps }: Recorded): Recorded => {
    const position = steps.findIndex((step) => step.label === label)
    const repeated = steps[position]
    if (repeated === undefined) {
      throw new Error(`the recording has no step ${label}`)
    }
    const later = (at: string): string => new Date(Date.parse(at) + gapMs).toISOString()
    return {
      manifest: {
        ...manifest,
        control_events: manifest.control_events.map((event) =>
          event.step < position ? event : { ...event, step: event.step + 1, observed_at: later(event.observed_at) },
        ),
      },
      steps: [
        ...steps.slice(0, position),
        { ...repeated, label: undefined },
        ...steps.slice(position).map((step) => ({ ...step, at: step.at + gapMs })),
      ],
    }
  }

const failingAfter =
  (delayMs: number) =>
  ({ manifest, steps }: Recorded): Recorded => ({
    manifest,
    steps: [...steps, { at: (steps.at(-1)?.at ?? 0) + delayMs, kind: 'remove', target: { root: 'home', path: 'never-written.txt' } }],
  })

const writtenPaths = async (space: Workspace, recording: string): Promise<string[]> => {
  const home = join(space.measurement, 'home')
  const roots: Readonly<Record<string, string>> = { home, claude: join(home, '.claude'), codex: join(home, '.codex') }
  const { steps } = await readRecorded(repositoryFixtures, recording)
  return steps.flatMap((step) => {
    const target = step.target as { root: string; path: string } | undefined
    const root = target === undefined ? undefined : roots[target.root]
    return (step.kind === 'append' || step.kind === 'write') && target !== undefined && root !== undefined
      ? [join(root, ...target.path.split('/'))]
      : []
  })
}

const recordedTimes = async (recording: string, label: string): Promise<{ origin: number; times: number[] }> => {
  const { manifest, steps } = await readRecorded(repositoryFixtures, recording)
  const source = steps.find((step) => step.label === label)?.source
  if (typeof source !== 'string') {
    throw new Error(`the recording has no step ${label} with a source`)
  }
  const content = await readFile(join(repositoryFixtures, ...recording.split('/'), ...source.split('/')), 'utf8')
  const times = content.split('\n').flatMap((line) => {
    const parsed = line === '' ? null : (JSON.parse(line) as { timestamp?: unknown })
    return typeof parsed?.timestamp === 'string' ? [Date.parse(parsed.timestamp)] : []
  })
  return { origin: Date.parse(manifest.recorded_at) + (steps[0]?.at ?? 0), times }
}

describe('the load profile', () => {
  test('is fixed before the measurement, and neither the profile nor the marked recordings can change after it', async () => {
    const space = await workspace()
    const tools = claudeRecording('tools')
    await space.mark(tools, { 'edit-finished': { stage: { title: '^Main work$' } } })
    await space.writeProfile(loadProfile('fixation', 10_000, null, [{ recording: tools }]))

    expect(await space.freshness('fix', space.profile, space.measurement, '--fixtures', space.fixtures)).toEqual({
      code: 0,
      stdout: `profile fixation fixed in ${space.measurement}\n`,
      stderr: '',
    })
    const fixed = FixedProfile.parse(await space.read('profile.json'))
    expect(fixed).toMatchObject({
      profile: { name: 'fixation', time_scale: 1, window_ms: 10_000, runs: [{ recording: tools, start_ms: 0 }] },
      recordings: [{ recording: tools, start_ms: 0, runtime: 'claude', control_events: 2 }],
    })
    expect(fixed.recordings[0]?.digest).toMatch(/^[0-9a-f]{64}$/)

    const refixed = await space.freshness('fix', space.profile, space.measurement, '--fixtures', space.fixtures)
    expect(refixed.code).toBe(1)
    expect(refixed.stderr).toBe(`${join(space.measurement, 'profile.json')} already exists\n`)

    await space.mark(tools, { 'edit-finished': { stage: { title: '^Other work$' } } })
    expect(await space.freshness('run', space.measurement, '--fixtures', space.fixtures)).toEqual({
      code: 1,
      stdout: '',
      stderr: `${tools} has changed since the profile was fixed\n`,
    })
    expect(existsSync(join(space.measurement, 'aang'))).toBe(false)

    const unmeasured = await space.freshness('report', space.measurement)
    expect(unmeasured.code).toBe(1)
    expect(unmeasured.stderr).toContain('measurement.json')

    const profile = JSON.parse(await readFile(join(space.measurement, 'profile.json'), 'utf8')) as { fixed_at: string }
    await writeFile(join(space.measurement, 'profile.json'), JSON.stringify({ ...profile, fixed_at: 'yesterday' }))
    const edited = await space.freshness('run', space.measurement, '--fixtures', space.fixtures)
    expect(edited.code).toBe(1)
    expect(edited.stderr).toContain('fixed_at')
  })

  test('is refused when a control event cannot be measured, its predicate is invalid, a recording repeats or a runtime has no observer', async () => {
    const space = await workspace()
    const refusal = async (runs: readonly object[], fixtures = repositoryFixtures): Promise<string> => {
      await space.writeProfile(loadProfile('refused', 10_000, null, runs))
      const outcome = await space.freshness('fix', space.profile, join(space.root, 'refused'), '--fixtures', fixtures)
      expect(outcome.code).toBe(1)
      expect(existsSync(join(space.root, 'refused'))).toBe(false)
      return outcome.stderr
    }

    expect(await refusal([{ recording: claudeRecording('source-loss') }])).toBe(
      `${claudeRecording('source-loss')}: control event transcript-removed is a remove step; freshness is measured on hook, append and write steps\n`,
    )
    expect(await refusal([{ recording: claudeRecording('tools') }, { recording: claudeRecording('tools'), start_ms: 5 }])).toContain(
      'a recording is played once per profile',
    )
    expect(await refusal([{ recording: codexRecording('tools') }])).toBe('the profile has no observer settings for codex\n')

    const tools = claudeRecording('tools')
    const manifest = join(space.fixtures, ...tools.split('/'), 'manifest.json')
    const editManifest = async (events: (marked: readonly object[]) => readonly object[]): Promise<void> => {
      const recorded = JSON.parse(await readFile(manifest, 'utf8')) as { control_events: object[] }
      await writeFile(manifest, JSON.stringify({ ...recorded, control_events: events(recorded.control_events) }))
    }
    await space.mark(tools, { 'edit-finished': { stage: { title: '(' } } })
    expect(await refusal([{ recording: tools }], space.fixtures)).toContain('invalid regular expression')
    await space.mark(tools, {})
    await editManifest((marked) => marked.map((event) => ({ ...event, step: 0 })))
    expect(await refusal([{ recording: tools }], space.fixtures)).toBe(`${tools}: control event edit-finished does not name step 0\n`)
    await editManifest(() => [])
    expect(await refusal([{ recording: tools }], space.fixtures)).toBe(`${space.profile}: the recordings of the profile have no control events\n`)

    for (const args of [['run'], ['measure', space.root]]) {
      const rejected = await space.freshness(...args)
      expect(rejected.code).toBe(2)
      expect(rejected.stderr).toContain('Usage:')
    }
  })
})

describe('the measurement', () => {
  test(
    'of parallel recordings times every expected map change, separates the needs time, flags violations and markup that held before the event, and takes the annotator verdicts with markup defects',
    { timeout: 180_000 },
    async () => {
      const space = await workspace()
      const approval = claudeRecording('approval')
      const tools = claudeRecording('tools')
      const interrupt = claudeRecording('interrupt')
      await space.mark(approval, {
        'approval-requested': mainStageCitingEvent,
        'approved-finished': { attention: { kind: ['permission'], author: ['rule'] } },
      })
      await space.mark(tools, {
        'edit-finished': {
          all: [
            { link: { kind: ['assignment'], evidence: 'event' } },
            { stage: { title: '^Main work$', lifecycle: ['active'], output: 'result\\.txt$' } },
          ],
        },
        'turn-finished': {
          any: [
            { stage: { title: '^Main work$', output: 'release\\.tar$' } },
            { criterion: { text: 'deployed', status: ['confirmed'] } },
            { card: { text: 'released' } },
            { brief: '^Deploy' },
          ],
        },
      })
      await space.mark(interrupt, { interrupted: mainStageCitingEvent })
      const cli = space.fakeClaude({ replies: [needsReply, { kind: 'script', script: 'report' }] })
      await space.writeProfile(
        loadProfile('parallel', 30_000, cli.path, [
          { recording: approval },
          { recording: tools, start_ms: 1_500 },
          { recording: interrupt, start_ms: 2_500 },
        ]),
      )
      expect(await space.freshness('fix', space.profile, space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0 })

      const measured = await space.freshness('run', space.measurement, '--fixtures', space.fixtures)
      expect(measured).toEqual({
        code: 0,
        stdout: [
          'claude: p95 beyond the window (target 30000 ms), 1 violations, 2 awaiting the annotator',
          `report written to ${join(space.measurement, 'report.md')}`,
          '',
        ].join('\n'),
        stderr: '',
      })
      const report = Report.parse(await space.read('report.json'))
      expect(report.recordings.map(({ recording }) => recording)).toEqual([approval, tools, interrupt])

      const requested = eventOf(report, 'approval-requested')
      expect(requested).toMatchObject({ method: 'predicate', status: 'met', author: 'observer', full_latency_ms: null })
      expect(requested.needs_ms).toBeGreaterThan(0)
      expect(requested.latency_ms).toBeGreaterThanOrEqual(requested.needs_ms ?? 0)
      expect(eventOf(report, 'approved-finished')).toMatchObject({ status: 'held_before', latency_ms: null, author: null })
      expect(eventOf(report, 'denial-requested')).toMatchObject({ method: 'annotation', status: 'unassessed', latency_ms: null })
      const edited = eventOf(report, 'edit-finished')
      expect(edited).toMatchObject({ status: 'met', author: 'observer', needs_ms: 0, full_latency_ms: null })
      expect(edited.latency_ms).toBeLessThanOrEqual(30_000)
      expect(eventOf(report, 'turn-finished')).toMatchObject({ status: 'missed', latency_ms: null })
      expect(eventOf(report, 'command-running')).toMatchObject({ method: 'annotation', status: 'unassessed' })
      const interrupted = eventOf(report, 'interrupted')
      expect(interrupted).toMatchObject({ status: 'met', author: 'observer' })
      expect(interrupted.full_latency_ms).toBeGreaterThanOrEqual(interrupted.latency_ms ?? Infinity)

      const [claude] = report.backends
      expect(report.backends).toHaveLength(1)
      expect(claude).toMatchObject({
        runtime: 'claude',
        cli_version: '2.1.286',
        model: 'claude-opus-5-5',
        effort: null,
        events: 7,
        assessed: 4,
        met: 3,
        violations: 1,
        unassessed: 2,
        held_before: 1,
        within_target: 0.75,
        p95: { kind: 'violation' },
        target_met: false,
        full_latency: { events: 1, p95_ms: interrupted.full_latency_ms },
        needs: { events: 1, ms: requested.needs_ms },
        calls: { rejected: 0, failed: 0, with_needs: 1 },
        states: [{ state: 'ok', share: 1 }],
      })
      expect(claude?.needs.share).toBeGreaterThan(0)

      const measurement = Measurement.parse(await space.read('measurement.json'))
      const annotations = Annotations.parse(await space.read('annotations.json'))
      expect(annotations.events.map(({ recording, label, verdict }) => [recording, label, verdict])).toEqual([
        [approval, 'denial-requested', null],
        [interrupt, 'command-running', null],
      ])
      const [denial, running] = annotations.events
      const opened = denial?.candidates.find(({ changes }) => changes.some((change) => change.startsWith('attention.open: attention permission')))
      if (denial === undefined || running === undefined || opened === undefined) {
        throw new Error('the annotation sheet has no candidate that opens the second permission request')
      }
      const annotate = async (verdicts: readonly unknown[]): Promise<void> => {
        await writeFile(
          join(space.measurement, 'annotations.json'),
          JSON.stringify({ ...annotations, events: annotations.events.map((event, index) => ({ ...event, verdict: verdicts[index] })) }),
        )
      }
      await annotate([{ met: true, run: opened.run, version: opened.version }, { met: false }])
      const reported = await space.freshness('report', space.measurement)
      expect(reported.code).toBe(0)
      expect(reported.stdout).toContain('claude: p95 beyond the window (target 30000 ms), 2 violations, 0 awaiting the annotator\n')
      const annotated = Report.parse(await space.read('report.json'))
      expect(eventOf(annotated, 'denial-requested')).toMatchObject({
        method: 'annotation',
        status: 'met',
        author: 'rule',
        version: opened.version,
        latency_ms: opened.at - (measuredEvent(measurement, 'denial-requested').observed_at ?? Infinity),
        needs_ms: 0,
      })
      expect(eventOf(annotated, 'command-running')).toMatchObject({ status: 'missed', latency_ms: null })
      expect(annotated.backends[0]).toMatchObject({ assessed: 6, met: 4, violations: 2, unassessed: 0, p95: { kind: 'violation' } })
      const summary = await readFile(join(space.measurement, 'report.md'), 'utf8')
      expect(summary).toContain(`| ${approval} | denial-requested | разметчик | выполнено |`)
      expect(summary).toContain(`| ${tools} | turn-finished | предикат | не выполнено, нарушение |`)
      expect(summary).toContain(`| ${approval} | approved-finished | предикат | выполнено до события, разметка некорректна |`)

      await annotate([{ held_before: true }, { mismatch: true }])
      expect((await space.freshness('report', space.measurement)).code).toBe(0)
      const defective = Report.parse(await space.read('report.json'))
      expect(eventOf(defective, 'denial-requested')).toMatchObject({ status: 'held_before', latency_ms: null, version: null })
      expect(eventOf(defective, 'command-running')).toMatchObject({ status: 'mismatched', latency_ms: null })
      expect(defective.backends[0]).toMatchObject({
        assessed: 4,
        met: 3,
        violations: 1,
        unassessed: 0,
        held_before: (annotated.backends[0]?.held_before ?? 0) + 1,
        mismatched: 1,
      })
      expect(await readFile(join(space.measurement, 'report.md'), 'utf8')).toContain(
        `| ${interrupt} | command-running | разметчик | описание не соответствует записи, разметка некорректна |`,
      )

      await annotate([{ met: true, run: opened.run, version: 999 }, null])
      const foreign = await space.freshness('report', space.measurement)
      expect(foreign.code).toBe(1)
      expect(foreign.stderr).toBe(
        `the annotation of ${approval} denial-requested names version 999 of ${opened.run}, which is not among its candidates\n`,
      )
      await writeFile(
        join(space.measurement, 'annotations.json'),
        JSON.stringify({ ...annotations, events: [...annotations.events, { ...running, label: 'command-repeated' }] }),
      )
      const unknown = await space.freshness('report', space.measurement)
      expect(unknown.code).toBe(1)
      expect(unknown.stderr).toBe(`the annotation of ${interrupt} command-repeated matches no annotated event of the measurement\n`)

      const repeated = await space.freshness('run', space.measurement, '--fixtures', space.fixtures)
      expect(repeated.code).toBe(1)
      expect(repeated.stderr).toBe(`a measurement has already run in ${space.measurement}; fix the profile into a new directory\n`)

      const fixed = FixedProfile.parse(await space.read('profile.json'))
      await writeFile(join(space.measurement, 'profile.json'), JSON.stringify({ ...fixed, profile: { ...fixed.profile, window_ms: 60_000 } }))
      const refixed = await space.freshness('report', space.measurement)
      expect(refixed.code).toBe(1)
      expect(refixed.stderr).toBe(`${join(space.measurement, 'measurement.json')} was measured with another profile\n`)
    },
  )

  test(
    'counts the needs time of an answer for the version the rules make in its transaction, and finds the cards of the answer',
    { timeout: 120_000 },
    async () => {
      const space = await workspace()
      const approval = claudeRecording('approval')
      await space.mark(approval, { 'denial-requested': { card: { text: 'second one was denied' } } })
      const cli = space.fakeClaude({
        replies: [{ kind: 'script', script: 'report' }, needsReply, { kind: 'script', script: 'revision' }],
        chatReplies: [{ kind: 'answer', output: { needs: [], answer: 'The run waits for an approval.', citations: [], insufficient_data: false, view_rule: null } }],
      })
      await space.writeProfile({
        ...loadProfile('needs', 25_000, cli.path, [{ recording: approval, chat: [{ after_ms: 2_000, question: 'What does the run wait for?' }] }]),
        time_scale: 2,
      })
      expect(await space.freshness('fix', space.profile, space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0 })
      expect(await space.freshness('run', space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0, stderr: '' })

      const measurement = Measurement.parse(await space.read('measurement.json'))
      const needsCall = measurement.calls.find(({ needs_latency_ms: needs }) => needs !== null)
      const carded = eventOf(Report.parse(await space.read('report.json')), 'denial-requested')
      expect(carded).toMatchObject({ method: 'predicate', status: 'met', author: 'observer', observer_call: needsCall?.id })
      expect(carded.needs_ms).toBe(needsCall?.needs_latency_ms)
      expect(needsCall?.needs_latency_ms).toBeGreaterThan(0)

      const annotations = Annotations.parse(await space.read('annotations.json'))
      const requested = annotations.events.find(({ label }) => label === 'approval-requested')
      const ruled = requested?.candidates.find(({ author, observer_call: call }) => author === 'rule' && call === needsCall?.id)
      if (requested === undefined || ruled === undefined || needsCall === undefined) {
        throw new Error('the annotation sheet has no rule version made in the transaction of the answer with needs')
      }
      expect(requested.candidates).toContainEqual(
        expect.objectContaining({ run: ruled.run, version: ruled.version - 1, at: ruled.at, author: 'observer', observer_call: needsCall.id }),
      )
      await writeFile(
        join(space.measurement, 'annotations.json'),
        JSON.stringify({
          ...annotations,
          events: annotations.events.map((event) =>
            event === requested ? { ...event, verdict: { met: true, run: ruled.run, version: ruled.version } } : { ...event, verdict: { met: false } },
          ),
        }),
      )
      expect(await space.freshness('report', space.measurement)).toMatchObject({ code: 0 })
      const report = Report.parse(await space.read('report.json'))
      expect(eventOf(report, 'approval-requested')).toMatchObject({
        method: 'annotation',
        status: 'met',
        author: 'rule',
        version: ruled.version,
        observer_call: needsCall.id,
        needs_ms: needsCall.needs_latency_ms,
      })
      expect(report.backends[0]?.needs).toMatchObject({
        events: 2,
        ms: 2 * (needsCall.needs_latency_ms ?? 0),
      })
      expect(report.backends[0]?.needs.share).toBeGreaterThan(0)

      const [asked] = measurement.questions
      expect(measurement.questions).toHaveLength(1)
      expect(asked).toMatchObject({ recording: approval, runtime: 'claude', question: 'What does the run wait for?', status: 'answered', insufficient_data: false, error: null })
      expect(asked?.run).toBe(carded.run)
      expect(asked?.scheduled_at).toBe(measurement.started_at + 2_000)
      expect(asked?.answered_at).toBeGreaterThanOrEqual(asked?.asked_at ?? Infinity)
      expect(measurement.spent.filter(({ kind }) => kind === 'chat')).toEqual([
        expect.objectContaining({ run: carded.run, backend: 'claude', verdict: 'accepted' }),
      ])
      const [spending] = report.spending
      expect(report.spending).toHaveLength(1)
      expect(spending).toMatchObject({
        runtime: 'claude',
        runs: 1,
        observer: { calls: measurement.calls.length },
        chat: { calls: 1 },
        questions: { asked: 1, answered: 1, failed: 0, not_asked: 0, insufficient_data: 0 },
      })
      expect(spending?.observer.tokens).toBeGreaterThan(0)
      expect(spending?.observer.cost_usd).toBeGreaterThan(0)
      expect(spending?.chat.tokens).toBeGreaterThan(0)
      expect(spending?.active_ms).toBe(spending?.run_ms)
      expect(spending?.per_active_hour.observer?.tokens).toBeCloseTo(((spending?.observer.tokens ?? 0) * 3_600_000) / (spending?.active_ms ?? 1))
      expect(report.active_hours.hours).toBeGreaterThan(0)
      const summary = await readFile(join(space.measurement, 'report.md'), 'utf8')
      expect(summary).toContain('## Расход')
      expect(summary).toMatch(/\| claude \| 1 \| 1 \| 0 \| 0 \| 0 \| \d+,\d \| \d+,\d \|/)
    },
  )

  test(
    'of a Codex run at another time scale places the event times on the playback timeline and finds the brief and the criteria',
    { timeout: 120_000 },
    async () => {
      const space = await workspace()
      const question = codexRecording('question')
      const timeScale = 2
      await space.mark(question, {
        'question-asked': {
          all: [{ brief: '^Working towards: ' }, { criterion: { text: '^The goal of the run is reached$', status: ['not_checked', 'reported_done'] } }],
        },
      })
      const cli = space.fakeCodex({ replies: [{ kind: 'script', script: 'claimed-done' }] })
      await space.writeProfile({
        format: 'aang-freshness-profile/1',
        name: 'codex',
        time_scale: timeScale,
        window_ms: 20_000,
        observer: { codex: { cli: cli.path, target_p95_ms: 40_000 } },
        runs: [{ recording: question }],
      })
      expect(await space.freshness('fix', space.profile, space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0 })
      expect(await space.freshness('run', space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0, stderr: '' })

      const report = Report.parse(await space.read('report.json'))
      const asked = eventOf(report, 'question-asked')
      expect(asked).toMatchObject({ method: 'predicate', status: 'met', author: 'observer' })
      expect(report).toMatchObject({ time_scale: timeScale })
      expect(report.backends).toEqual([
        expect.objectContaining({
          runtime: 'codex',
          cli_version: '0.159.3',
          model: 'gpt-6.1-sol',
          target_p95_ms: 40_000,
          events: 2,
          met: 1,
          violations: 0,
          unassessed: 1,
          p95: { kind: 'latency', ms: asked.latency_ms },
          target_met: true,
        }),
      ])

      const measurement = Measurement.parse(await space.read('measurement.json'))
      const timed = measuredEvent(measurement, 'question-asked')
      const started = measurement.recordings[0]?.started_at ?? Infinity
      const { origin, times } = await recordedTimes(question, 'question-asked')
      const sourceAt = timed.source_at ?? Infinity
      expect(times.some((time) => Math.abs(started + (time - origin) * timeScale - sourceAt) <= 1)).toBe(true)
      expect(asked.full_latency_ms).toBe((asked.latency_ms ?? 0) + (timed.observed_at ?? 0) - sourceAt)
    },
  )

  test(
    'takes the records of a repeated delivery from its own step, and a repeat without a record of its own is unmatched',
    { timeout: 120_000 },
    async () => {
      const space = await workspace()
      const tools = claudeRecording('tools')
      const workflow = claudeRecording('workflow')
      const gapMs = 3_000
      await space.mark(tools, { 'edit-finished': mainStageCitingEvent })
      await space.edit(tools, repeatedBefore('edit-finished', gapMs))
      await space.mark(workflow, { 'workflow-completed': { stage: { evidence: 'event' } } })
      await space.edit(workflow, repeatedBefore('workflow-completed', gapMs))
      const cli = space.fakeClaude({ replies: [{ kind: 'script', script: 'report' }] })
      await space.writeProfile(loadProfile('repeated', 5_000, cli.path, [{ recording: tools }, { recording: workflow }]))
      expect(await space.freshness('fix', space.profile, space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0 })
      expect(await space.freshness('run', space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0, stderr: '' })

      const measurement = Measurement.parse(await space.read('measurement.json'))
      const edited = measuredEvent(measurement, 'edit-finished')
      expect(edited.observed_at).not.toBeNull()
      expect(edited.played_at - (edited.observed_at ?? 0)).toBeLessThan(gapMs)
      expect(edited.evaluation.kind).not.toBe('unmatched')
      expect(measuredEvent(measurement, 'workflow-completed')).toMatchObject({ observed_at: null, runs: [], evaluation: { kind: 'unmatched' } })
      expect(eventOf(Report.parse(await space.read('report.json')), 'workflow-completed')).toMatchObject({ status: 'unmatched' })
    },
  )

  test('stops the other recordings and the observer processes when a recording fails to play', { timeout: 120_000 }, async () => {
    const space = await workspace()
    const approval = claudeRecording('approval')
    const tools = claudeRecording('tools')
    await space.mark(approval, { 'approval-requested': mainStageCitingEvent })
    await space.edit(approval, failingAfter(12_000))
    await space.mark(tools, {})
    const pidFile = join(space.root, 'observer.pid')
    const cli = space.fakeClaude({ replies: [{ kind: 'timeout' }], descendant: { pidFile } })
    await space.writeProfile(loadProfile('failing', 5_000, cli.path, [{ recording: approval }, { recording: tools, start_ms: 60_000 }]))
    expect(await space.freshness('fix', space.profile, space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0 })

    const outcome = await space.freshness('run', space.measurement, '--fixtures', space.fixtures)
    expect(outcome.code).toBe(1)
    expect(outcome.stderr).toMatch(/step \d+ \(remove\) failed/)
    expect(cli.calls().filter(({ reply }) => reply !== null)).not.toEqual([])
    expect(cli.calls().filter(({ pid }) => isAlive(pid))).toEqual([])
    expect(isAlive(Number(await readFile(pidFile, 'utf8')))).toBe(false)
    expect((await writtenPaths(space, tools)).filter((path) => existsSync(path))).toEqual([])
    expect(existsSync(join(space.measurement, 'measurement.json'))).toBe(false)
  })

  test('does not start without an admitted observer', { timeout: 120_000 }, async () => {
    const space = await workspace()
    const tools = claudeRecording('tools')
    await space.mark(tools, { 'edit-finished': mainStageCitingEvent })
    const cli = space.fakeClaude({ admissionFault: 'tool_execution' })
    await space.writeProfile(loadProfile('unadmitted', 5_000, cli.path, [{ recording: tools }]))
    expect(await space.freshness('fix', space.profile, space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0 })

    const outcome = await space.freshness('run', space.measurement, '--fixtures', space.fixtures)
    expect(outcome.code).toBe(1)
    expect(outcome.stderr).toContain('the claude observer is not admitted: disabled, failed')
    expect(existsSync(join(space.measurement, 'measurement.json'))).toBe(false)
  })

  test(
    'under an exhausted subscription keeps the rule-made changes on time, reports the observer as unavailable and its expectations as violations',
    { timeout: 120_000 },
    async () => {
      const space = await workspace()
      const approval = claudeRecording('approval')
      const workflow = claudeRecording('workflow')
      const plan = claudeRecording('plan')
      await space.mark(approval, { 'approval-requested': { attention: { kind: ['permission'], resolution: ['open'] } } })
      await space.mark(workflow, { 'workflow-completed': { stage: { evidence: 'event' } } })
      await space.mark(plan, { 'tasks-listed': { stage: { evidence: 'event' } } })
      const cli = space.fakeClaude({ replies: [{ kind: 'limit' }] })
      await space.writeProfile(
        loadProfile('limit', 8_000, cli.path, [
          { recording: approval },
          { recording: workflow, start_ms: 300 },
          { recording: plan, start_ms: 600 },
        ]),
      )
      expect(await space.freshness('fix', space.profile, space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0 })
      expect(await space.freshness('run', space.measurement, '--fixtures', space.fixtures)).toMatchObject({ code: 0, stderr: '' })

      const report = Report.parse(await space.read('report.json'))
      const requested = eventOf(report, 'approval-requested')
      expect(requested).toMatchObject({ status: 'met', author: 'rule', needs_ms: 0 })
      expect(requested.latency_ms).toBeLessThan(8_000)
      expect(eventOf(report, 'workflow-completed')).toMatchObject({ status: 'missed' })
      expect(eventOf(report, 'tasks-listed')).toMatchObject({ status: 'unmatched' })
      const measurement = Measurement.parse(await space.read('measurement.json'))
      expect(measurement.events.find(({ label }) => label === 'workflow-completed')?.observed_at).not.toBeNull()
      expect(measurement.events.find(({ label }) => label === 'tasks-listed')).toMatchObject({ observed_at: null, runs: [] })
      expect(measurement.calls.filter(({ outcome }) => outcome === 'failed').map(({ error }) => error)).toContain('limit')

      const [claude] = report.backends
      expect(claude?.calls.accepted).toBe(0)
      expect(claude?.calls.failed).toBeGreaterThan(0)
      expect(claude?.violations).toBeGreaterThanOrEqual(2)
      expect(claude?.states.find(({ state }) => state === 'unavailable:limit')?.share).toBeGreaterThan(0.5)
      expect(await readFile(join(space.measurement, 'report.md'), 'utf8')).toContain('| claude | unavailable:limit |')
    },
  )
})
