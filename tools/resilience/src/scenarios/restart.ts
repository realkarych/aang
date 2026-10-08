import { findings } from '../findings.js'
import type { Scenario } from '../scenario.js'
import {
  actionCalls,
  actionsOf,
  bash,
  checkNoTransientHooksGap,
  claudeRun,
  claudeSession,
  claudeTurn,
  codexFlags,
  codexPrompt,
  codexThread,
  codexTurn,
  echo,
  gapsOf,
  installHooks,
  shell,
  trustCodexHooks,
  otherGaps,
  recordInventory,
  sessionFields,
  viewOf,
} from '../drivers.js'
import type { Lab } from '../lab.js'
import { waitFor } from '../lab.js'
import { claudeToolUses, claudeTranscript, claudeUsageMessages, codexCalls, codexRollout } from '../sources.js'

const objectCounts = async (lab: Lab, session: string): Promise<Record<string, number>> => {
  const view = await viewOf(lab, session)
  const { objects } = view.run
  return {
    sessions: objects.sessions.length,
    agents: objects.agents.length,
    actions: objects.actions.length,
    questions: objects.questions.length,
    usage_records: objects.usage_records.length,
    gaps: objects.gaps.length,
  }
}

const claudeSigkillMidTurn: Scenario = {
  name: 'claude-sigkill-mid-turn',
  area: 'restart',
  summary:
    'The daemon is killed with SIGKILL while a Claude turn waits inside a tool; the turn and the session end while the daemon is down; the restarted daemon takes in the spool and the rest of the transcript once',
  runtimes: ['claude'],
  scripts: ({ gate }) => ({
    claude: {
      'kill-mid-turn': [[bash(echo('before'))], [bash(gate('mid-turn'))], [bash(echo('after'))], [{ text: 'done' }]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const turn = claudeTurn(lab, 'kill-mid-turn')
    const gate = lab.gate('mid-turn')
    await gate.reached()
    const running = await waitFor('the daemon to show the gated action', async () => {
      for (const summary of await lab.runs()) {
        const run = await lab.snapshot(summary.id)
        const gated = run.objects.actions.find((action) => action.execution.state === 'running')
        if (gated !== undefined) return { run: summary.id, actions: run.objects.actions.length }
      }
      return null
    })
    journal.observe('before kill', running)
    await lab.killDaemon()
    await gate.release()
    const session = await claudeSession(lab, 'claude', turn)
    const pending = await lab.spoolFiles()
    journal.observe('spool files written while the daemon was down', pending.length)
    journal.check('hooks kept writing to the spool while the daemon was down', pending.length > 0, pending.length)
    await lab.startDaemon()
    await lab.settle()
    const view = await viewOf(lab, session)
    const transcript = await claudeTranscript(lab.profile.claude, session)
    journal.equal('every tool use of the transcript is one action', actionCalls(view), claudeToolUses(transcript).sort())
    journal.equal(
      'every action ended ok',
      actionsOf(view).map((action) => action.outcome?.value ?? null),
      actionsOf(view).map(() => 'ok'),
    )
    journal.equal(
      'one usage record per assistant message with usage',
      view.run.objects.usage_records.filter((record) => record.session === view.session.id).length,
      claudeUsageMessages(transcript).length,
    )
    journal.equal('the session ended and has full support', sessionFields(view.session), {
      ...sessionFields(view.session),
      state: 'ended',
      freshness: 'ok',
      support_mode: 'full',
      launches: ['startup'],
    })
    journal.equal('the spool is empty after the restart', await lab.spoolFiles(), [])
    journal.equal('no gaps besides unrecognised records', otherGaps(view), [])
    await recordInventory(lab)
    const first = await objectCounts(lab, session)
    await lab.killDaemon()
    await lab.startDaemon()
    await lab.settle()
    journal.equal('a second restart adds nothing', await objectCounts(lab, session), first)
    journal.observe('objects', first)
  },
}

const claudeStopBetweenTurns: Scenario = {
  name: 'claude-stop-between-turns',
  area: 'restart',
  summary:
    'aang stop between two turns of one Claude session: hooks write nothing while aang is stopped, the turn taken while stopped comes from the transcript after aang start, and hooks resume for the next turn',
  runtimes: ['claude'],
  scripts: () => ({
    claude: {
      'stop-first': [[bash(echo('first'))], [{ text: 'done' }]],
      'stop-second': [[bash(echo('second'))], [{ text: 'done' }]],
      'stop-third': [[bash(echo('third'))], [{ text: 'done' }]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const session = await claudeRun(lab, 'stop-first')
    await lab.settle()
    const stop = await lab.aang('stop')
    journal.check('aang stop succeeds', stop.code === 0, stop.code)
    await claudeRun(lab, 'stop-second', ['--resume', session])
    journal.equal('hooks wrote nothing while aang was stopped', await lab.spoolFiles(), [])
    await lab.startDaemon()
    await lab.settle()
    const stopped = await viewOf(lab, session)
    const second = await claudeTranscript(lab.profile.claude, session)
    journal.equal('the turn taken while stopped is read from the transcript', actionCalls(stopped), claudeToolUses(second).sort())
    journal.observe('session after the stopped turn', sessionFields(stopped.session))
    await claudeRun(lab, 'stop-third', ['--resume', session])
    await lab.settle()
    const view = await viewOf(lab, session)
    const transcript = await claudeTranscript(lab.profile.claude, session)
    journal.equal('every tool use of the transcript is one action', actionCalls(view), claudeToolUses(transcript).sort())
    journal.equal(
      'every action ended ok',
      actionsOf(view).map((action) => action.outcome?.value ?? null),
      actionsOf(view).map(() => 'ok'),
    )
    journal.equal('the spool is empty', await lab.spoolFiles(), [])
    journal.observe('session after the next turn', sessionFields(view.session))
    journal.observe('gaps', gapsOf(view))
    const registryGaps = (await lab.status()).gaps.flatMap(({ details }) =>
      details?.includes('registry record') === true ? [details] : [],
    )
    journal.equal('ended sessions leave no gap for their removed registry files', registryGaps, [])
    await recordInventory(lab)
  },
}

const codexSigkillMidTurn: Scenario = {
  name: 'codex-sigkill-mid-turn',
  area: 'restart',
  summary:
    'The daemon is killed with SIGKILL while a codex exec turn with trusted aang hooks waits inside a command; the turn ends while the daemon is down; the restarted daemon takes in the spool and the rest of the rollout once',
  runtimes: ['codex'],
  scripts: ({ gate }) => ({
    codex: {
      'codex-kill': [[shell(echo('before'))], [shell(gate('codex-mid-turn'))], [shell(echo('after'))]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['codex'])
    await trustCodexHooks(lab)
    await lab.startDaemon()
    await waitFor('codex hooks to be active in the status', async () =>
      (await lab.status()).runtimes.find(({ runtime }) => runtime === 'codex')?.hooks === 'active',
    )
    const turn = codexTurn(lab, [...codexFlags, codexPrompt('codex-kill')])
    const gate = lab.gate('codex-mid-turn')
    await gate.reached()
    const running = await waitFor('the daemon to show the gated command', async () => {
      for (const summary of await lab.runs()) {
        const run = await lab.snapshot(summary.id)
        if (run.objects.actions.some((action) => action.execution.state === 'running')) {
          return { actions: run.objects.actions.length }
        }
      }
      return null
    })
    journal.observe('before kill', running)
    await lab.killDaemon()
    await gate.release()
    const thread = await codexThread(lab, 'codex', turn)
    const pending = await lab.spoolFiles()
    journal.observe('spool files written while the daemon was down', pending.length)
    journal.check('hooks kept writing to the spool while the daemon was down', pending.length > 0, pending.length)
    await lab.startDaemon()
    await lab.settle()
    const view = await viewOf(lab, thread)
    const rollout = await codexRollout(lab.profile.codex, thread)
    journal.equal('every call of the rollout is one action', actionCalls(view), codexCalls(rollout).sort())
    journal.equal(
      'every action ended ok',
      actionsOf(view).map((action) => action.outcome?.value ?? null),
      actionsOf(view).map(() => 'ok'),
    )
    journal.equal('the session has full support and fresh sources', sessionFields(view.session), {
      ...sessionFields(view.session),
      freshness: 'ok',
      support_mode: 'full',
    })
    journal.equal('one launch of the thread', sessionFields(view.session)['launches'], ['startup'], findings.codexLaunchTwice)
    checkNoTransientHooksGap(lab, view)
    journal.observe('session', sessionFields(view.session))
    journal.equal('the spool is empty after the restart', await lab.spoolFiles(), [])
    journal.equal('no gaps besides unrecognised records', otherGaps(view), [])
    await recordInventory(lab)
    const first = await objectCounts(lab, thread)
    await lab.killDaemon()
    await lab.startDaemon()
    await lab.settle()
    journal.equal('a second restart adds nothing', await objectCounts(lab, thread), first)
    journal.observe('objects', first)
  },
}

export const restartScenarios: readonly Scenario[] = [claudeSigkillMidTurn, claudeStopBetweenTurns, codexSigkillMidTurn]
