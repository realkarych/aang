import { rm } from 'node:fs/promises'
import { endpoints, type Link, type RunId } from '@aang/contract'
import { findings } from '../findings.js'
import type { Scenario } from '../scenario.js'
import {
  actionsOf,
  bash,
  claudeRun,
  codexFlags,
  codexPrompt,
  codexRun,
  echo,
  installHooks,
  sessionFields,
  shell,
  trustCodexHooks,
  viewOf,
} from '../drivers.js'
import type { Lab, SessionView } from '../lab.js'
import { claudeTranscripts, codexRollouts } from '../sources.js'

const origins = (view: SessionView): Extract<Link, { kind: 'common_origin' }>[] =>
  view.run.model.links.filter((link): link is Extract<Link, { kind: 'common_origin' }> => link.kind === 'common_origin')

const forkedFrom = (view: SessionView): RunId[] =>
  view.run.model.links.flatMap((link) => (link.kind === 'forked_from' ? [link.parent] : []))

const own = (view: SessionView): number => actionsOf(view).filter((action) => !action.inherited).length
const inherited = (view: SessionView): number => actionsOf(view).filter((action) => action.inherited).length

const originOf = async (lab: Lab, view: SessionView, ids: Readonly<Record<string, string>>): Promise<Record<string, unknown>> => {
  const names = new Map<string, string>()
  for (const [name, runtimeSession] of Object.entries(ids)) {
    const other = await viewOf(lab, runtimeSession)
    names.set(other.session.id, name)
  }
  const [link] = origins(view)
  return link === undefined
    ? { link: null }
    : {
        sessions: link.sessions.map((session) => names.get(session) ?? session).sort(),
        parent_candidate: link.parent_candidate === null ? null : (names.get(link.parent_candidate) ?? link.parent_candidate),
        basis: link.basis.kind,
      }
}

const claudeForks: Scenario = {
  name: 'claude-forks',
  area: 'lineage',
  summary:
    'Two forks of one Claude session and a fork of a fork: each fork is its own run with a common-origin link and no guessed parent; copied history is inherited, not repeated; a fork_parent binding sets the parent and its revocation removes it',
  runtimes: ['claude'],
  scripts: () => ({
    claude: {
      origin: [[bash(echo('origin'))], [{ text: 'done' }]],
      'fork-one': [[bash(echo('one'))], [{ text: 'done' }]],
      'fork-two': [[bash(echo('two'))], [{ text: 'done' }]],
      'fork-three': [[bash(echo('three'))], [{ text: 'done' }]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const origin = await claudeRun(lab, 'origin')
    const one = await claudeRun(lab, 'fork-one', ['--resume', origin, '--fork-session'])
    const two = await claudeRun(lab, 'fork-two', ['--resume', origin, '--fork-session'])
    const three = await claudeRun(lab, 'fork-three', ['--resume', one, '--fork-session'])
    await lab.settle()
    const ids = { origin, one, two, three }
    const views = {
      origin: await viewOf(lab, origin),
      one: await viewOf(lab, one),
      two: await viewOf(lab, two),
      three: await viewOf(lab, three),
    }
    journal.equal('every session is its own run', new Set(Object.values(views).map((view) => view.run.run.id)).size, 4)
    journal.equal('the origin run has one session', views.origin.run.summary.sessions, 1)
    journal.equal(
      'own and inherited actions of each session',
      Object.fromEntries(Object.entries(views).map(([name, view]) => [name, { own: own(view), inherited: inherited(view) }])),
      { origin: { own: 1, inherited: 0 }, one: { own: 1, inherited: 1 }, two: { own: 1, inherited: 1 }, three: { own: 1, inherited: 2 } },
    )
    const links = {
      one: await originOf(lab, views.one, ids),
      two: await originOf(lab, views.two, ids),
      three: await originOf(lab, views.three, ids),
    }
    journal.observe('common origin links', links)
    journal.check(
      'each fork has a common-origin link without a guessed parent',
      Object.values(links).every((link) => Array.isArray(link['sessions']) && link['parent_candidate'] === null),
      links,
    )
    journal.equal('no Claude fork claims a forked-from parent', Object.values(views).map((view) => view.run.summary.forked_from), [null, null, null, null])
    journal.observe('launches', Object.fromEntries(Object.entries(views).map(([name, view]) => [name, sessionFields(view.session)['launches']])))
    const binding = endpoints.createBinding.response.parse(
      await lab.write('POST', endpoints.createBinding.path, { kind: 'fork_parent', run: views.one.run.run.id, parent: views.origin.session.id }),
    ).binding
    journal.step('fork_parent binding created', { kind: binding.kind })
    const bound = await viewOf(lab, one)
    journal.equal('the binding sets the parent of the fork', {
      forked_from: bound.run.summary.forked_from,
      links: forkedFrom(bound),
    }, { forked_from: views.origin.run.run.id, links: [views.origin.run.run.id] })
    await lab.write('DELETE', endpoints.revokeBinding.path.replace(':id', binding.id), {})
    const revoked = await viewOf(lab, one)
    journal.equal('revoking the binding removes the parent', { forked_from: revoked.run.summary.forked_from, links: forkedFrom(revoked) }, {
      forked_from: null,
      links: [],
    })
  },
}

const claudeForkParentUnseen: Scenario = {
  name: 'claude-fork-parent-unseen',
  area: 'lineage',
  summary:
    'The daemon is down while a Claude session and its fork run, and the parent transcript is deleted before the daemon is back: the fork is still recognised from its own file, the copied history is inherited, and no parent is named',
  runtimes: ['claude'],
  scripts: () => ({
    claude: {
      'unseen-origin': [[bash(echo('unseen'))], [{ text: 'done' }]],
      'unseen-fork': [[bash(echo('fork'))], [{ text: 'done' }]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    await lab.killDaemon()
    const origin = await claudeRun(lab, 'unseen-origin')
    const fork = await claudeRun(lab, 'unseen-fork', ['--resume', origin, '--fork-session'])
    for (const path of await claudeTranscripts(lab.profile.claude, origin)) await rm(path)
    journal.step('the parent transcript is deleted before the daemon is back')
    const spool = await lab.spoolFiles()
    journal.observe('spool files left by both sessions', spool.length)
    await lab.startDaemon()
    await lab.settle()
    const view = await viewOf(lab, fork)
    journal.equal('the copied history is inherited', { own: own(view), inherited: inherited(view) }, { own: 1, inherited: 1 })
    journal.observe('common origin link', await originOf(lab, view, { fork }))
    const parent = await lab.sessionView(origin)
    journal.observe('parent session from its hooks only', parent === null ? null : sessionFields(parent.session))
    journal.check(
      'the fork names no parent',
      view.run.summary.forked_from === null && origins(view).every((link) => link.parent_candidate === null || parent !== null),
      { forked_from: view.run.summary.forked_from, origins: origins(view).map(({ sessions, parent_candidate }) => ({ sessions, parent_candidate })) },
    )
  },
}

const claudeResumeContinue: Scenario = {
  name: 'claude-resume-continue',
  area: 'lineage',
  summary: '--resume and --continue of a Claude session keep one session and one run with three launches',
  runtimes: ['claude'],
  scripts: () => ({
    claude: {
      first: [[bash(echo('first'))], [{ text: 'done' }]],
      resumed: [[bash(echo('resumed'))], [{ text: 'done' }]],
      continued: [[bash(echo('continued'))], [{ text: 'done' }]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const session = await claudeRun(lab, 'first')
    const resumed = await claudeRun(lab, 'resumed', ['--resume', session])
    const continued = await claudeRun(lab, 'continued', ['--continue'])
    journal.equal('resume and continue keep the session id', [resumed, continued], [session, session])
    await lab.settle()
    journal.equal('one run', (await lab.runs()).length, 1)
    const view = await viewOf(lab, session)
    journal.equal('three launches', sessionFields(view.session)['launches'], ['startup', 'resume', 'resume'])
    journal.equal('three own actions', own(view), 3)
  },
}

const codexForks: Scenario = {
  name: 'codex-forks',
  area: 'lineage',
  summary:
    'codex exec fork creates a run linked to its source run; a fork whose source was deleted before the daemon saw it points to a run aang does not have',
  runtimes: ['codex'],
  scripts: () => ({
    codex: {
      'codex-origin': [[shell(echo('origin'))]],
      'codex-fork': [[shell(echo('fork'))]],
      'codex-unseen': [[shell(echo('unseen'))]],
      'codex-unseen-fork': [[shell(echo('unseen-fork'))]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['codex'])
    await trustCodexHooks(lab)
    await lab.startDaemon()
    const origin = await codexRun(lab, [...codexFlags, codexPrompt('codex-origin')])
    const fork = await codexRun(lab, [...codexFlags, 'fork', origin, codexPrompt('codex-fork')])
    await lab.settle()
    const source = await viewOf(lab, origin)
    const forked = await viewOf(lab, fork)
    journal.equal('the fork is its own run linked to the source run', {
      separate: forked.run.run.id !== source.run.run.id,
      forked_from: forked.run.summary.forked_from,
      links: forkedFrom(forked),
    }, { separate: true, forked_from: source.run.run.id, links: [source.run.run.id] })
    journal.equal('one launch of the fork', sessionFields(forked.session)['launches'], ['fork'], findings.codexLaunchTwice)
    await lab.stopDaemon()
    const unseen = await codexRun(lab, [...codexFlags, codexPrompt('codex-unseen')])
    const unseenFork = await codexRun(lab, [...codexFlags, 'fork', unseen, codexPrompt('codex-unseen-fork')])
    const removal = await lab.codex(['delete', '--force', unseen]).done
    journal.observe('codex delete of a forked thread', { code: removal.code, stderr: removal.stderr.trim().split('\n').at(-1) ?? '' })
    for (const path of await codexRollouts(lab.profile.codex, unseen)) await rm(path)
    journal.step('the source rollout is removed before the daemon is back')
    await lab.startDaemon()
    await lab.settle()
    const orphan = await viewOf(lab, unseenFork)
    const listed = (await lab.runs()).map(({ id }) => id)
    journal.observe('fork of an unseen source', {
      forked_from: orphan.run.summary.forked_from,
      forked_from_listed: orphan.run.summary.forked_from === null ? null : listed.includes(orphan.run.summary.forked_from),
      source_session_known: (await lab.sessionView(unseen)) !== null,
    })
  },
}

export const lineageScenarios: readonly Scenario[] = [claudeForks, claudeForkParentUnseen, claudeResumeContinue, codexForks]
