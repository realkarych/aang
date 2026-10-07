import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Action } from '@aang/contract'
import { findings } from '../findings.js'
import type { Scenario } from '../scenario.js'
import {
  actionCalls,
  actionsOf,
  bash,
  claudePrompt,
  claudeRun,
  claudeSession,
  claudeTurn,
  codexFlags,
  codexPrompt,
  codexRun,
  echo,
  gapsOf,
  installHooks,
  sessionFields,
  shell,
  trustCodexHooks,
  viewOf,
  waitView,
} from '../drivers.js'
import type { SessionView } from '../lab.js'
import { claudeSessionOf, claudeToolUses, claudeTranscript, claudeTranscripts, codexRollouts } from '../sources.js'

const actionStates = (view: SessionView): Record<string, unknown>[] =>
  actionsOf(view).map((action) => ({
    call: action.key.call,
    execution: action.execution.state,
    outcome: action.outcome?.value ?? null,
  }))

const ordered = (action: Action): boolean =>
  action.started_at === null || action.ended_at === null || action.started_at <= action.ended_at

const claudeNoPersistence: Scenario = {
  name: 'claude-no-session-persistence',
  area: 'divergence',
  summary:
    'claude -p --no-session-persistence writes no transcript: the session is shown in hooks-only mode with its actions from hooks',
  runtimes: ['claude'],
  scripts: () => ({ claude: { 'hooks-only': [[bash(echo('unpersisted'))], [{ text: 'done' }]] } }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const session = await claudeRun(lab, 'hooks-only', ['--no-session-persistence'])
    journal.equal('no transcript is written', (await claudeTranscripts(lab.profile.claude, session)).length, 0)
    await lab.settle()
    const view = await viewOf(lab, session)
    journal.equal('the session is in hooks-only mode', view.session.support_mode, 'hooks_only')
    journal.equal('the action comes from hooks and ended ok', actionStates(view).map(({ execution, outcome }) => ({ execution, outcome })), [
      { execution: 'done', outcome: 'ok' },
    ])
    journal.observe('session', sessionFields(view.session))
    journal.observe('gaps', gapsOf(view))
  },
}

const codexEphemeral: Scenario = {
  name: 'codex-ephemeral',
  area: 'divergence',
  summary: 'codex exec --ephemeral writes no rollout: the thread is shown in hooks-only mode with its command from hooks',
  runtimes: ['codex'],
  scripts: () => ({ codex: { ephemeral: [[shell(echo('ephemeral'))]] } }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['codex'])
    await trustCodexHooks(lab)
    await lab.startDaemon()
    const thread = await codexRun(lab, [...codexFlags, '--ephemeral', codexPrompt('ephemeral')])
    journal.equal('no rollout is written', (await codexRollouts(lab.profile.codex, thread)).length, 0)
    await lab.settle()
    const view = await viewOf(lab, thread)
    journal.equal('the thread is in hooks-only mode', view.session.support_mode, 'hooks_only')
    journal.check(
      'the command comes from hooks and is not shown as running',
      actionsOf(view).length === 1 && actionsOf(view).every((action) => action.ended_at !== null && action.execution.state !== 'running'),
      actionStates(view),
    )
    journal.observe('command from hooks only', actionStates(view))
    journal.observe('session', sessionFields(view.session))
  },
}

const claudeKilledMidTool: Scenario = {
  name: 'claude-killed-mid-tool',
  area: 'divergence',
  summary:
    'The Claude process is killed while a tool runs: hooks saw the start, the transcript has the tool use without a result, nothing ends the turn; the session turns quiet after the configured silence and the action is not shown as failed',
  runtimes: ['claude'],
  config: { freshness: { quietAfterMs: 5_000 } },
  scripts: ({ gate }) => ({ claude: { killed: [[bash(echo('before'))], [bash(gate('killed'))], [{ text: 'done' }]] } }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const turn = claudeTurn(lab, 'killed')
    const gate = lab.gate('killed')
    await gate.reached()
    await sleep(1_000)
    const killed = await turn.kill()
    journal.step('claude killed with SIGKILL', { signal: killed.signal })
    const session = claudeSessionOf(killed.stdout)
    await lab.settle()
    const view = await waitView(lab, session, 'the session to turn quiet', ({ session: { freshness } }) => freshness === 'quiet', 20_000).catch(
      () => viewOf(lab, session),
    )
    journal.equal('the silent session is quiet', view.session.freshness, 'quiet')
    journal.check(
      'no action is shown as failed',
      actionsOf(view).every((action) => action.execution.state !== 'failed'),
      actionStates(view),
    )
    journal.check(
      'the session of the killed process is not shown as running',
      view.session.execution.state !== 'running',
      sessionFields(view.session),
      null,
      findings.deadProcess,
    )
    journal.observe('actions', actionStates(view))
    journal.observe('session', sessionFields(view.session))
    journal.observe('gaps', gapsOf(view))
  },
}

const claudeCwdDrift: Scenario = {
  name: 'claude-cwd-drift',
  area: 'divergence',
  summary:
    'A Claude session started in the watched project changes its directory to an added directory outside it: hooks and transcript lines then carry the outside cwd, yet the session stays in scope with every action; a session started outside is not taken in',
  runtimes: ['claude'],
  scripts: ({ project }) => {
    const outside = join(project, '..', 'outside')
    return {
      claude: {
        drift: [[bash(`cd "${outside}" && ${echo('outside')}`)], [bash(echo('still'))], [{ text: 'done' }]],
        external: [[bash(echo('external'))], [{ text: 'done' }]],
      },
    }
  },
  run: async (lab) => {
    const { journal } = lab
    const outside = join(lab.project, '..', 'outside')
    await mkdir(outside, { recursive: true })
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const session = await claudeRun(lab, 'drift', ['--add-dir', outside])
    await lab.settle()
    const view = await viewOf(lab, session)
    const transcript = await claudeTranscript(lab.profile.claude, session)
    const directories = [...new Set(transcript.lines.flatMap((line) => (typeof line['cwd'] === 'string' ? [line['cwd']] : [])))]
    journal.equal('transcript lines name the project and then the outside directory', directories, [lab.project, outside])
    journal.equal('every tool use is one action', actionCalls(view), claudeToolUses(transcript).sort())
    journal.equal('the session cwd is the start directory', view.session.cwd, lab.project)
    journal.check('start and end of every action are ordered', actionsOf(view).every(ordered), actionsOf(view).map(({ started_at, ended_at }) => ({ started_at, ended_at })))
    const external = await claudeSession(
      lab,
      'claude outside',
      lab.claude(['-p', claudePrompt('external'), '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash'], { cwd: outside }),
    )
    await lab.settle()
    journal.equal('a session started outside the watched root is not taken in', await lab.sessionView(external), null)
  },
}

export const divergenceScenarios: readonly Scenario[] = [
  claudeNoPersistence,
  codexEphemeral,
  claudeKilledMidTool,
  claudeCwdDrift,
]
