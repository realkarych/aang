import {
  AttentionItemId,
  type AttentionItem,
  ChangeSeq,
  ChangesResponse,
  type Fact,
  type JsonValue,
  ModelVersion,
  type ObserverOp,
  type RunId,
  RunSnapshot,
  type Stage,
  TempId,
  type ViewPosition,
} from '@aang/contract'
import { createViewState, InvalidPositionError } from '@aang/engine'
import { describe, expect, test } from 'vitest'
import { at } from './model.js'
import { createStage, existing, temporary } from './observer-fixtures.js'
import {
  actionOf,
  expectFeedReproduces,
  hook,
  openScene,
  type Scene,
  type Source,
  testRun,
  toolResult,
  toolUse,
} from './read-scene.js'
import { claudeTranscript } from './samples.js'

const time = (second: number): string => new Date(Date.UTC(2026, 9, 1, 12, 0, second)).toISOString()

const read = (source: Source, call: string, second: number): string[] => [
  toolUse(source, call, time(second), 'Read', { file_path: '/project/README.md' }),
  toolResult(source, call, time(second + 1), 'readme'),
]

const question = 'Which database should the parser use?'
const askInput: JsonValue = {
  questions: [{ question, header: 'Database', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
}
const command: JsonValue = { command: 'touch probe-perm.txt', description: 'Create empty probe file' }

const existingItem = (id: AttentionItemId) => ({ kind: 'existing', id }) as const

const factsOfCall = (scene: Scene, source: Source, call: string): Fact[] =>
  scene.factsOf(source).filter(({ entity_key: key }) => key.kind === 'action' && key.call === call)

const startOf = (scene: Scene, source: Source, call: string): Fact => {
  const start = factsOfCall(scene, source, call).find(({ kind }) => kind === 'action_start')
  if (start === undefined) {
    throw new Error(`the action ${call} has no start`)
  }
  return start
}

const snapshotOf = (scene: Scene, run: RunId): RunSnapshot => {
  const snapshot = scene.reads.snapshot(run)
  if (snapshot === null) {
    throw new Error(`the run ${run} must exist`)
  }
  expect(RunSnapshot.safeParse(snapshot).error).toBeUndefined()
  return snapshot
}

const positionOf = (snapshot: RunSnapshot): ViewPosition => ({
  version: snapshot.summary.version,
  change_seq: snapshot.change_seq,
})

const changesSince = (scene: Scene, run: RunId, from: ViewPosition): ChangesResponse => {
  const changes = scene.reads.changes(run, from)
  if (changes === null) {
    throw new Error(`the run ${run} must exist`)
  }
  expect(ChangesResponse.safeParse(changes).error).toBeUndefined()
  return changes
}

const itemWith = (snapshot: RunSnapshot, matches: (item: AttentionItem) => boolean): AttentionItem => {
  const item = snapshot.attention.items.find(matches)
  if (item === undefined) {
    throw new Error('the snapshot must have the attention item')
  }
  return item
}

const stageTitled = (snapshot: RunSnapshot, title: string): Stage => {
  const stage = snapshot.model.stages.find((own) => own.title === title)
  if (stage === undefined) {
    throw new Error(`the snapshot must have the stage ${title}`)
  }
  return stage
}

const stageOp = (evidence: Fact['id'][], id: string, title: string): ObserverOp => ({
  ...createStage(evidence, id),
  title,
})

const startRun = async (scene: Scene) => {
  const source = scene.source('session-a')
  const run = scene.runOf('session-a')
  await scene.transcript(source, [
    ...claudeTranscript(source).slice(0, 20),
    ...read(source, 'read-1', 0),
    ...read(source, 'read-2', 2),
    ...read(source, 'read-3', 4),
    ...read(source, 'read-4', 6),
  ])
  return { source, run }
}

const ask = (source: Source) =>
  hook(source, 'ask.evt', 'PreToolUse.Bash.json', {
    tool_use_id: 'ask',
    tool_name: 'AskUserQuestion',
    tool_input: askInput,
  })

describe('since the last view and the order of attention', () => {
  test('a view mark keeps one state of the run, new events do not move it and only a consistent pair replaces it', async ({
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    let now = 100
    const views = createViewState({ store: scene.store, now: () => at(now) })
    const { source, run } = await startRun(scene)
    const seen = snapshotOf(scene, run)
    expect(seen.view.mark).toBeNull()

    const mark = views.markViewed(run, positionOf(seen))

    expect(mark).toEqual({ run, ...positionOf(seen), marked_at: at(100) })
    expect(scene.store.changes.head()).toBe(seen.change_seq)
    expect(snapshotOf(scene, run).view.mark).toEqual(mark)

    await scene.transcript(source, testRun(source, 'check-1', time(10), time(11), false))
    scene.observe(
      run,
      'call-1',
      factsOfCall(scene, source, 'read-1'),
      [stageOp([startOf(scene, source, 'read-1').id], 'build', 'Build the parser')],
      { at: 20 },
    )
    await scene.hooks(ask(source))
    const current = snapshotOf(scene, run)
    expect(current.summary.version).toBeGreaterThan(seen.summary.version)
    expect(current.change_seq).toBeGreaterThan(seen.change_seq)
    expect(current.view.mark).toEqual(mark)
    expect(expectFeedReproduces(scene.reads, run, seen).view.mark).toEqual(mark)

    now = 200
    const later = { version: current.summary.version, change_seq: seen.change_seq }
    const earlier = { version: seen.summary.version, change_seq: current.change_seq }
    const ahead = { version: current.summary.version, change_seq: ChangeSeq.parse(current.change_seq + 1) }
    const beyond = { version: ModelVersion.parse(current.summary.version + 1), change_seq: current.change_seq }
    for (const position of [later, earlier, ahead, beyond]) {
      expect(() => views.markViewed(run, position)).toThrow(InvalidPositionError)
    }
    expect(snapshotOf(scene, run).view.mark).toEqual(mark)
    expect(views.markViewed(scene.runOf('missing'), positionOf(current))).toBeNull()

    const next = views.markViewed(run, positionOf(current))

    expect(next).toEqual({ run, ...positionOf(current), marked_at: at(200) })
    expect(snapshotOf(scene, run).view.mark).toEqual(next)
    expect(views.markViewed(run, positionOf(seen))).toEqual({ run, ...positionOf(seen), marked_at: at(200) })
  })

  test('a rule question that appears while the observer is unavailable is in the changes since the mark and is not announced again after the observer recovers', async ({
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    let now = 100
    const views = createViewState({ store: scene.store, now: () => at(now) })
    const { source, run } = await startRun(scene)
    const first = views.markViewed(run, positionOf(snapshotOf(scene, run)))
    if (first === null) {
      throw new Error('the run must exist')
    }

    await scene.hooks(ask(source))
    await scene.transcript(source, testRun(source, 'check-1', time(10), time(11), false))

    const unseen = changesSince(scene, run, first)
    expect(unseen.attention.opened.map(({ kind, author, text }) => [kind, author, text]).sort()).toEqual([
      ['failed_check', 'rule', expect.any(String)],
      ['question', 'rule', question],
    ])
    expect(unseen.activity.flatMap(({ tools }) => tools.map(({ tool }) => tool)).sort()).toEqual([
      'AskUserQuestion',
      'Bash',
    ])
    const asked = itemWith(snapshotOf(scene, run), ({ kind }) => kind === 'question')

    now = 200
    const second = views.markViewed(run, positionOf(snapshotOf(scene, run)))
    if (second === null) {
      throw new Error('the run must exist')
    }
    const grounds = { evidence: [startOf(scene, source, 'read-1').id], rationale: 'The observer is back' }
    expect(
      scene.observe(
        run,
        'call-recovered',
        factsOfCall(scene, source, 'read-1'),
        [
          stageOp(grounds.evidence, 'design', 'Design the parser'),
          { ...grounds, op: 'attention.priority', item: existingItem(asked.id), priority: 'high' },
        ],
        { at: 30 },
      ).status,
    ).toBe('accepted')

    const recovered = changesSince(scene, run, second)
    expect(recovered.stages.map(({ before, after }) => [before, after.title])).toEqual([[null, 'Design the parser']])
    expect(recovered.attention).toEqual({ opened: [], closed: [] })
    expect(recovered.activity).toEqual([])
    expect(itemWith(snapshotOf(scene, run), ({ id }) => id === asked.id).priority?.value).toBe('high')
  })

  test('the zone puts a waiting request first, then items more stages depend on, then older items; a recommendation keeps the order and a viewed item goes down', async ({
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    let now = 500
    const views = createViewState({ store: scene.store, now: () => at(now) })
    const { source, run } = await startRun(scene)
    const plan = { evidence: [startOf(scene, source, 'read-1').id], rationale: 'The plan of the run' }
    expect(
      scene.observe(
        run,
        'call-plan',
        factsOfCall(scene, source, 'read-1'),
        [
          stageOp(plan.evidence, 'write', 'Write the parser'),
          stageOp(plan.evidence, 'test', 'Test the parser'),
          stageOp(plan.evidence, 'release', 'Release the parser'),
          stageOp(plan.evidence, 'docs', 'Document the parser'),
          { ...plan, op: 'stage.depends', stage: temporary('test'), depends_on: temporary('write'), via: null },
          { ...plan, op: 'stage.depends', stage: temporary('release'), depends_on: temporary('test'), via: null },
          { ...plan, op: 'question.add', temp_id: TempId.parse('format'), text: 'Which output format?', stage: null },
        ],
        { at: 10 },
      ).status,
    ).toBe('accepted')
    const planned = snapshotOf(scene, run)
    const later = { evidence: [startOf(scene, source, 'read-2').id], rationale: 'Asked later' }
    expect(
      scene.observe(
        run,
        'call-later',
        factsOfCall(scene, source, 'read-2'),
        [
          {
            ...later,
            op: 'attention.add',
            temp_id: TempId.parse('grammar'),
            kind: 'blocker',
            text: 'The grammar is missing',
            stage: existing(stageTitled(planned, 'Write the parser').id),
          },
          {
            ...later,
            op: 'attention.add',
            temp_id: TempId.parse('review'),
            kind: 'review_request',
            text: 'Review the documentation',
            stage: existing(stageTitled(planned, 'Document the parser').id),
          },
          { ...later, op: 'question.add', temp_id: TempId.parse('license'), text: 'Which license?', stage: null },
        ],
        { at: 20 },
      ).status,
    ).toBe('accepted')
    await scene.transcript(source, testRun(source, 'check-1', time(30), time(31), false))
    await scene.hooks(hook(source, 'permission.evt', 'PermissionRequest.Bash.json', { tool_input: command }))

    const ordered = snapshotOf(scene, run)
    const titled = (text: string) => itemWith(ordered, (item) => item.text === text).id
    const permission = itemWith(ordered, ({ kind }) => kind === 'permission').id
    const failed = itemWith(ordered, ({ kind }) => kind === 'failed_check').id
    const stages = (...titles: readonly string[]) => titles.map((title) => stageTitled(ordered, title).id).sort()
    const place = (item: AttentionItemId, dependent: readonly string[] = [], waiting = false, viewed = false) => ({
      item,
      waiting_for_human: waiting,
      dependent_stages: dependent,
      viewed,
    })
    const zone = [
      place(permission, [], true),
      place(titled('The grammar is missing'), stages('Write the parser', 'Test the parser', 'Release the parser')),
      place(titled('Review the documentation'), stages('Document the parser')),
      place(titled('Which output format?')),
      place(titled('Which license?')),
      place(failed),
    ]
    expect(ordered.view.zone).toEqual(zone)
    expect(ordered.summary.attention).toMatchObject({ open: 6, waiting_for_human: 1 })

    const recommendation = { evidence: [startOf(scene, source, 'read-3').id], rationale: 'Urgent for the release' }
    expect(
      scene.observe(
        run,
        'call-priority',
        factsOfCall(scene, source, 'read-3'),
        [
          { ...recommendation, op: 'attention.priority', item: existingItem(failed), priority: 'high' },
          { ...recommendation, op: 'attention.priority', item: existingItem(permission), priority: 'low' },
        ],
        { at: 40 },
      ).status,
    ).toBe('accepted')
    const recommended = snapshotOf(scene, run)
    expect(itemWith(recommended, ({ id }) => id === failed).priority?.value).toBe('high')
    expect(recommended.view.zone).toEqual(zone)

    const replan = { evidence: [startOf(scene, source, 'read-4').id], rationale: 'The release became shipping' }
    expect(
      scene.observe(
        run,
        'call-replan',
        factsOfCall(scene, source, 'read-4'),
        [
          stageOp(replan.evidence, 'ship', 'Ship the parser'),
          stageOp(replan.evidence, 'manual', 'Write the manual'),
          {
            ...replan,
            op: 'stage.replace',
            stage: existing(stageTitled(planned, 'Release the parser').id),
            by: [temporary('ship')],
          },
          {
            ...replan,
            op: 'stage.replace',
            stage: existing(stageTitled(planned, 'Document the parser').id),
            by: [temporary('manual')],
          },
          {
            ...replan,
            op: 'actions.assign',
            actions: [actionOf(source, 'check-1')],
            stage: existing(stageTitled(planned, 'Test the parser').id),
          },
        ],
        { at: 50 },
      ).status,
    ).toBe('accepted')
    const replanned = expectFeedReproduces(scene.reads, run, recommended)
    const sameAge = [titled('Review the documentation'), titled('Which license?')].sort()
    const narrowed = [
      place(permission, [], true),
      place(titled('The grammar is missing'), stages('Write the parser', 'Test the parser')),
      place(failed, stages('Test the parser')),
      place(titled('Which output format?')),
      ...sameAge.map((item) => place(item)),
    ]
    expect(replanned.view.zone).toEqual(narrowed)

    const viewed = views.viewItem(run, permission)

    expect(viewed).toEqual({
      item: permission,
      viewed_at: at(500),
      dismissed_at: null,
      change_seq: scene.store.changes.head(),
    })
    const lowered = expectFeedReproduces(scene.reads, run, replanned)
    expect(lowered.view.zone).toEqual([...narrowed.slice(1), place(permission, [], true, true)])
    expect(lowered.attention.views).toEqual([viewed])
    now = 600
    expect(views.viewItem(run, permission)).toEqual(viewed)
    expect(scene.store.changes.head()).toBe(lowered.change_seq)
  })

  test('a dismissed item leaves the zone, stays in the history and changes nothing in the model', async ({
    onTestFinished,
  }) => {
    const scene = await openScene(onTestFinished)
    let now = 100
    const views = createViewState({ store: scene.store, now: () => at(now) })
    const { source, run } = await startRun(scene)
    await scene.hooks(ask(source))
    await scene.transcript(source, testRun(source, 'check-1', time(10), time(11), false))
    const open = snapshotOf(scene, run)
    const asked = itemWith(open, ({ kind }) => kind === 'question')
    const failed = itemWith(open, ({ kind }) => kind === 'failed_check')
    expect(open.view.zone.map(({ item }) => item)).toEqual([asked.id, failed.id])
    expect(open.summary.attention).toMatchObject({ open: 2, waiting_for_human: 1, by_kind: { question: 1 } })
    const journal = scene.store.model.changes(run, ModelVersion.parse(0))

    const dismissed = views.dismissItem(run, asked.id)

    expect(dismissed).toEqual({
      item: asked.id,
      viewed_at: null,
      dismissed_at: at(100),
      change_seq: scene.store.changes.head(),
    })
    const after = expectFeedReproduces(scene.reads, run, open)
    expect(after.view.zone.map(({ item }) => item)).toEqual([failed.id])
    expect(after.attention.items).toEqual(open.attention.items)
    expect(itemWith(after, ({ id }) => id === asked.id)).toMatchObject({ resolution: 'open', runtime_wait: 'active' })
    expect(after.attention.views).toEqual([dismissed])
    expect(after.summary.attention).toMatchObject({ open: 1, waiting_for_human: 0, by_kind: { question: 0 } })
    expect(after.summary.version).toBe(open.summary.version)
    expect(scene.store.model.changes(run, ModelVersion.parse(0))).toEqual(journal)

    now = 200
    const viewed = views.viewItem(run, asked.id)
    expect(viewed).toEqual({
      item: asked.id,
      viewed_at: at(200),
      dismissed_at: at(100),
      change_seq: scene.store.changes.head(),
    })
    expect(views.dismissItem(run, asked.id)).toEqual(viewed)
    const history = expectFeedReproduces(scene.reads, run, after)
    expect(history.view.zone.map(({ item }) => item)).toEqual([failed.id])
    expect(history.attention.views).toEqual([viewed])

    const other = scene.source('session-b')
    await scene.transcript(other, claudeTranscript(other).slice(0, 20))
    const head = scene.store.changes.head()
    expect(views.dismissItem(run, AttentionItemId.parse('attention:missing'))).toBeNull()
    expect(scene.reads.snapshot(scene.runOf(other.session))).not.toBeNull()
    expect(views.viewItem(scene.runOf(other.session), failed.id)).toBeNull()
    expect(views.dismissItem(scene.runOf('missing'), failed.id)).toBeNull()
    expect(scene.store.changes.head()).toBe(head)
  })
})
