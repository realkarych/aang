import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { findings } from '../findings.js'
import type { Scenario } from '../scenario.js'
import {
  actionCalls,
  bash,
  claudeRun,
  claudeSession,
  claudeTurn,
  codexFlags,
  codexPrompt,
  codexRun,
  codexThread,
  codexTurn,
  echo,
  finished,
  gapsOf,
  installHooks,
  sessionFields,
  shell,
  trustCodexHooks,
  viewOf,
  waitView,
} from '../drivers.js'
import type { Lab, SessionView } from '../lab.js'
import { waitFor } from '../lab.js'
import { claudeToolUses, claudeTranscript, claudeTranscripts, codexCalls, codexRollout, codexRollouts } from '../sources.js'
import { storedCursors } from '../store.js'
import { probeWatch } from '../watch-probe.js'

const cursorOffset = async (lab: Lab, path: string): Promise<number | null> => {
  const { database } = await lab.status()
  return storedCursors(database.path).find((cursor) => cursor.path === path)?.offset ?? null
}

const onlySession = async (lab: Lab): Promise<string> =>
  waitFor('one session in the API', async () => {
    const runs = await Promise.all((await lab.runs()).map((summary) => lab.snapshot(summary.id)))
    return runs.flatMap((run) => run.objects.sessions)[0]?.key.session ?? null
  })

const openLoss = (view: SessionView): boolean =>
  view.run.objects.gaps.some((gap) => gap.kind === 'source_lost' && gap.closed_at === null && gap.session === view.session.id)

const lossState = (view: SessionView): Record<string, unknown> => ({
  freshness: view.session.freshness,
  open_source_lost: openLoss(view),
})

const rawTotal = async (lab: Lab): Promise<number> =>
  (await lab.records()).counts.reduce((total, { records }) => total + records, 0)

const restart = async (lab: Lab): Promise<void> => {
  await lab.killDaemon()
  await lab.startDaemon()
  await lab.settle()
}

const runningAction = (lab: Lab): Promise<number> =>
  waitFor('the daemon to show the running action', async () => {
    for (const summary of await lab.runs()) {
      const run = await lab.snapshot(summary.id)
      if (run.objects.actions.some((action) => action.execution.state === 'running')) return run.objects.actions.length
    }
    return null
  })

const claudeTranscriptDeleted: Scenario = {
  name: 'claude-transcript-deleted',
  area: 'sources',
  summary:
    'The transcript of an ended Claude session is deleted: the session is marked as source lost, keeps what was observed, and stays so after a restart',
  runtimes: ['claude'],
  scripts: () => ({ claude: { lost: [[bash(echo('lost'))], [{ text: 'done' }]] } }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const session = await claudeRun(lab, 'lost')
    await lab.settle()
    const before = await viewOf(lab, session)
    const [transcript] = await claudeTranscripts(lab.profile.claude, session)
    if (transcript === undefined) throw new Error('no transcript')
    await rm(transcript)
    journal.step('transcript deleted')
    const lost = await waitView(lab, session, 'the session to be marked as source lost', openLoss)
    journal.equal('the session is marked as source lost', lossState(lost), { freshness: 'lost', open_source_lost: true })
    journal.equal('the observed actions stay', actionCalls(lost), actionCalls(before))
    await restart(lab)
    const after = await viewOf(lab, session)
    journal.equal('after a restart the session is still source lost', lossState(after), {
      freshness: 'lost',
      open_source_lost: true,
    })
    journal.equal('after a restart the observed actions stay', actionCalls(after), actionCalls(before))
    journal.observe('gaps', gapsOf(after))
  },
}

const claudeTranscriptMoved: Scenario = {
  name: 'claude-transcript-moved',
  area: 'sources',
  summary:
    'The transcript of an ended Claude session moves to another project directory while the daemon runs and again while it is stopped: the session keeps one stream without duplicates or an open loss',
  runtimes: ['claude'],
  scripts: () => ({ claude: { moved: [[bash(echo('moved'))], [{ text: 'done' }]] } }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const session = await claudeRun(lab, 'moved')
    await lab.settle()
    const before = await viewOf(lab, session)
    const records = await rawTotal(lab)
    const [original] = await claudeTranscripts(lab.profile.claude, session)
    if (original === undefined) throw new Error('no transcript')
    const first = join(`${dirname(original)}-moved`, basename(original))
    await mkdir(dirname(first), { recursive: true })
    await rename(original, first)
    journal.step('transcript moved while the daemon runs')
    await lab.settle()
    const moved = await viewOf(lab, session)
    journal.equal('after the move the source is not lost', lossState(moved), { freshness: 'ok', open_source_lost: false })
    journal.equal('after the move the actions are the same', actionCalls(moved), actionCalls(before))
    journal.equal('after the move no raw record is added', await rawTotal(lab), records)
    await lab.stopDaemon()
    const second = join(`${dirname(original)}-moved-again`, basename(original))
    await mkdir(dirname(second), { recursive: true })
    await rename(first, second)
    journal.step('transcript moved while the daemon is stopped')
    await lab.startDaemon()
    await lab.settle()
    const again = await viewOf(lab, session)
    journal.equal('after a move while stopped the source is not lost', lossState(again), {
      freshness: 'ok',
      open_source_lost: false,
    })
    journal.equal('after a move while stopped the actions are the same', actionCalls(again), actionCalls(before))
    journal.equal('after a move while stopped no raw record is added', await rawTotal(lab), records)
    journal.observe('gaps', gapsOf(again))
  },
}

const claudeDeletedMidTurn: Scenario = {
  name: 'claude-transcript-deleted-mid-turn',
  area: 'sources',
  summary:
    'The transcript is deleted while a Claude turn waits inside a tool; Claude writes the rest of the turn into a new file at the same path; the daemon keeps the earlier history and takes in the new lines once',
  runtimes: ['claude'],
  scripts: ({ gate }) => ({
    claude: { 'deleted-mid-turn': [[bash(echo('before'))], [bash(gate('deleted'))], [bash(echo('after'))], [{ text: 'done' }]] },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const turn = claudeTurn(lab, 'deleted-mid-turn')
    const gate = lab.gate('deleted')
    await gate.reached()
    await runningAction(lab)
    await lab.settle()
    const before = await waitFor('the session in the API', async () => {
      const views = await Promise.all((await lab.runs()).map((summary) => lab.snapshot(summary.id)))
      return views.flatMap((run) => run.objects.sessions)[0] ?? null
    })
    const [transcript] = await claudeTranscripts(lab.profile.claude, before.key.session)
    if (transcript === undefined) throw new Error('no transcript')
    const beforeTranscript = await claudeTranscript(lab.profile.claude, before.key.session)
    await rm(transcript)
    journal.step('transcript deleted mid-turn')
    const lost = await waitView(lab, before.key.session, 'the loss to be noticed', openLoss, 15_000).catch(() => null)
    journal.observe('loss noticed before the file came back', lost === null ? null : lossState(lost))
    await gate.release()
    const session = await claudeSession(lab, 'claude', turn)
    await lab.settle()
    const view = await viewOf(lab, session)
    const after = await claudeTranscript(lab.profile.claude, session)
    const expected = [...new Set([...claudeToolUses(beforeTranscript), ...claudeToolUses(after)])].sort()
    journal.observe('tool uses in the new file', claudeToolUses(after).length)
    journal.equal('every tool use of the old and the new file is one action', actionCalls(view), expected)
    journal.equal('the source is not lost after the file came back', lossState(view), {
      freshness: 'ok',
      open_source_lost: false,
    })
    journal.observe('session', sessionFields(view.session))
    journal.observe('gaps', gapsOf(view))
    await restart(lab)
    journal.equal('after a restart the actions are the same', actionCalls(await viewOf(lab, session)), expected)
  },
}

const codexArchive: Scenario = {
  name: 'codex-archive-unarchive-delete',
  area: 'sources',
  summary:
    'codex archive moves a rollout to archived_sessions, codex unarchive moves it back and the thread is resumed; codex delete removes another rollout: the archived thread stays one session without loss, the deleted one is marked as source lost',
  runtimes: ['codex'],
  scripts: () => ({
    codex: {
      'archive-a': [[shell(echo('archived'))]],
      'archive-a2': [[shell(echo('unarchived'))]],
      'delete-b': [[shell(echo('deleted'))]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['codex'])
    await trustCodexHooks(lab)
    await lab.startDaemon()
    const archived = await codexRun(lab, [...codexFlags, codexPrompt('archive-a')])
    const deleted = await codexRun(lab, [...codexFlags, codexPrompt('delete-b')])
    await lab.settle()
    const before = await viewOf(lab, archived)
    await finished(lab, 'codex archive', lab.codex(['archive', archived]))
    journal.observe('archived rollout', (await codexRollouts(lab.profile.codex, archived)).map((path) => basename(dirname(path))))
    await lab.settle()
    const inArchive = await viewOf(lab, archived)
    journal.equal('the archived thread is not lost', lossState(inArchive), { freshness: 'ok', open_source_lost: false })
    journal.equal('the archived thread keeps its actions', actionCalls(inArchive), actionCalls(before))
    await finished(lab, 'codex unarchive', lab.codex(['unarchive', archived]))
    await lab.settle()
    journal.equal('the unarchived thread is not lost', lossState(await viewOf(lab, archived)), {
      freshness: 'ok',
      open_source_lost: false,
    })
    await codexRun(lab, [...codexFlags, 'resume', archived, codexPrompt('archive-a2')])
    await lab.settle()
    const resumed = await viewOf(lab, archived)
    const rollout = await codexRollout(lab.profile.codex, archived)
    journal.equal('the resumed thread has every call once', actionCalls(resumed), codexCalls(rollout).sort())
    journal.observe('resumed session', sessionFields(resumed.session))
    await finished(lab, 'codex delete', lab.codex(['delete', '--force', deleted]))
    const lost = await waitView(lab, deleted, 'the deleted thread to be marked as source lost', openLoss)
    journal.equal('the deleted thread is marked as source lost', lossState(lost), { freshness: 'lost', open_source_lost: true })
    await restart(lab)
    journal.equal('after a restart the deleted thread is still lost', lossState(await viewOf(lab, deleted)), {
      freshness: 'lost',
      open_source_lost: true,
    })
    journal.equal('after a restart the resumed thread is not lost', lossState(await viewOf(lab, archived)), {
      freshness: 'ok',
      open_source_lost: false,
    })
  },
}

const claudeRootCreatedLater: Scenario = {
  name: 'claude-projects-root-created-after-start',
  area: 'sources',
  summary:
    'The daemon starts before Claude ever created its projects directory (first Claude session after installing aang): hooks arrive at once, the transcript is found by the periodic tree scan',
  runtimes: ['claude'],
  scripts: () => ({ claude: { first: [[bash(echo('first'))], [{ text: 'done' }]] } }),
  run: async (lab) => {
    const { journal } = lab
    await rm(join(lab.profile.claude, 'projects'), { recursive: true, force: true })
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const session = await claudeRun(lab, 'first')
    const early = await viewOf(lab, session)
    journal.observe('session right after the turn', sessionFields(early.session))
    const afterMs = await lab.settle()
    journal.observe('time until the transcript was read, ms', afterMs)
    journal.check('the transcript is read within the 60 s tree scan', afterMs <= 75_000, afterMs)
    journal.check('the transcript is read within 5 s', afterMs <= 5_000, afterMs, 5_000, findings.missingRoot)
    const view = await viewOf(lab, session)
    journal.equal(
      'every tool use is one action',
      actionCalls(view),
      claudeToolUses(await claudeTranscript(lab.profile.claude, session)).sort(),
    )
    journal.equal('the session has full support', view.session.support_mode, 'full')
  },
}

const codexRolloutDuringCommand: Scenario = {
  name: 'codex-rollout-read-during-command',
  area: 'sources',
  summary:
    'While a codex exec turn waits inside a long command, the rollout already holds the call of that command; the daemon should read it within seconds. Codex appends to the rollout through a held-open file, and the probe shows whether fs watch on this OS reports such appends',
  runtimes: ['codex'],
  scripts: ({ gate }) => ({ codex: { 'live-read': [[shell(echo('before'))], [shell(gate('live-read'))]] } }),
  run: async (lab) => {
    const { journal } = lab
    journal.observe('fs watch of appends through a reopened file', await probeWatch(lab.work, 'reopen'))
    journal.observe('fs watch of appends through a held-open file', await probeWatch(lab.work, 'held'))
    await installHooks(lab, ['codex'])
    await trustCodexHooks(lab)
    await lab.startDaemon()
    const turn = codexTurn(lab, [...codexFlags, codexPrompt('live-read')])
    const gate = lab.gate('live-read')
    await gate.reached()
    const reached = performance.now()
    const thread = await onlySession(lab)
    const rollout = await codexRollout(lab.profile.codex, thread)
    const { size } = await stat(rollout.path)
    const lagMs = await waitFor(
      'the daemon to read the rollout up to the running command',
      async () => ((await cursorOffset(lab, rollout.path)) ?? 0) >= size && Math.round(performance.now() - reached),
      75_000,
      100,
    ).catch(() => null)
    journal.observe('ms from the command start until the rollout was read', lagMs)
    journal.check(
      'the rollout of the running command is read within 5 s',
      lagMs !== null && lagMs <= 5_000,
      lagMs,
      5_000,
      findings.heldFileWatch,
    )
    await gate.release()
    await codexThread(lab, 'codex', turn)
    await lab.settle()
  },
}

const codexDeletedMidTurn: Scenario = {
  name: 'codex-rollout-deleted-mid-turn',
  area: 'sources',
  summary:
    'The rollout is deleted while a codex exec turn waits inside a command; Codex keeps writing to the unlinked file; the daemon marks the source as lost and still shows the later command from hooks',
  runtimes: ['codex'],
  scripts: ({ gate }) => ({
    codex: { 'rollout-deleted': [[shell(echo('before'))], [shell(gate('rollout-deleted'))], [shell(echo('after'))]] },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['codex'])
    await trustCodexHooks(lab)
    await lab.startDaemon()
    const turn = codexTurn(lab, [...codexFlags, codexPrompt('rollout-deleted')])
    const gate = lab.gate('rollout-deleted')
    await gate.reached()
    const thread = await onlySession(lab)
    const rollout = await codexRollout(lab.profile.codex, thread)
    journal.observe(
      'rollout bytes read before the deletion',
      await waitFor('the daemon to read the rollout', async () => {
        const offset = await cursorOffset(lab, rollout.path)
        return offset === null || offset === 0 ? null : { offset, size: (await stat(rollout.path)).size }
      }),
    )
    await rm(rollout.path)
    journal.step('rollout deleted mid-turn')
    await gate.release()
    await codexThread(lab, 'codex', turn)
    await lab.settle()
    journal.observe('rollout files after the turn', (await codexRollouts(lab.profile.codex, thread)).length)
    const view = await viewOf(lab, thread)
    journal.equal('the session is marked as source lost', lossState(view), { freshness: 'lost', open_source_lost: true })
    journal.check(
      'the command after the deletion is shown from hooks',
      view.run.objects.actions.filter((action) => action.session === view.session.id).length >= 3,
      actionCalls(view),
    )
    journal.observe('actions', view.run.objects.actions.map((action) => ({ call: action.key.call, state: action.execution.state, outcome: action.outcome?.value ?? null })))
    journal.observe('session', sessionFields(view.session))
    journal.observe('gaps', gapsOf(view))
  },
}

export const sourceScenarios: readonly Scenario[] = [
  claudeTranscriptDeleted,
  claudeTranscriptMoved,
  claudeDeletedMidTurn,
  claudeRootCreatedLater,
  codexArchive,
  codexRolloutDuringCommand,
  codexDeletedMidTurn,
]
