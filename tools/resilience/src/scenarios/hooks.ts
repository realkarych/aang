import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HookInstallation, Runtime } from '@aang/contract'
import { claudePluginId, hookInstallPaths, writeClaudePlugin } from '@aang/hook'
import { findings } from '../findings.js'
import type { Scenario } from '../scenario.js'
import {
  actionCalls,
  bash,
  claudeRun,
  claudeTurn,
  codexFlags,
  codexPrompt,
  codexRun,
  echo,
  finished,
  gapsOf,
  installHooks,
  sessionFields,
  shell,
  trustCodexHooks,
  viewOf,
} from '../drivers.js'
import type { Lab, SessionView } from '../lab.js'
import { waitFor } from '../lab.js'
import { claudeSessionOf, claudeToolUses, claudeTranscript } from '../sources.js'

const installation = async (lab: Lab, runtime: Runtime): Promise<HookInstallation | null> =>
  (await lab.status()).runtimes.find((status) => status.runtime === runtime)?.hooks ?? null

const awaitInstallation = async (lab: Lab, runtime: Runtime, expected: HookInstallation): Promise<HookInstallation> => {
  const state = await waitFor(
    `${runtime} hooks to become ${expected}`,
    async () => ((await installation(lab, runtime)) === expected ? expected : null),
    20_000,
  ).catch(async () => installation(lab, runtime))
  lab.journal.step(`${runtime} hooks in the status`, state)
  return state ?? 'unknown'
}

const inactiveSessions = async (lab: Lab, runtime: Runtime): Promise<readonly string[]> =>
  (await lab.status()).runtimes.find((status) => status.runtime === runtime)?.hooks_inactive_sessions ?? []

const modeOf = (view: SessionView): Record<string, unknown> => ({
  support_mode: view.session.support_mode,
  freshness: view.session.freshness,
  open_hooks_inactive: view.run.objects.gaps.some(
    (gap) => gap.kind === 'hooks_inactive' && gap.closed_at === null && gap.session === view.session.id,
  ),
})

const filesOnly = { support_mode: 'files_only', freshness: 'hooks_inactive', open_hooks_inactive: true }
const full = { support_mode: 'full', freshness: 'ok', open_hooks_inactive: false }

const leases = async (lab: Lab): Promise<string[]> =>
  (await readdir(lab.profile.spool)).filter((name) => name.startsWith('lease-'))

const claudeHookBinaryMissing: Scenario = {
  name: 'claude-hook-binary-missing',
  area: 'hooks',
  summary:
    'The aang-hook binary is missing while a Claude session runs: Claude is not blocked, the session is shown in files-only mode with hooks inactive; after the binary is back a new session has full support',
  runtimes: ['claude'],
  scripts: () => ({
    claude: {
      'no-hook': [[bash(echo('unhooked'))], [{ text: 'done' }]],
      'hook-back': [[bash(echo('hooked'))], [{ text: 'done' }]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const { binary } = hookInstallPaths(lab.profile.aangHome)
    await rename(binary, `${binary}.away`)
    journal.step('aang-hook moved away')
    const unhooked = await claudeRun(lab, 'no-hook')
    journal.step('claude finished without the hook binary')
    await lab.settle()
    const view = await viewOf(lab, unhooked)
    journal.equal('the session without hooks is files-only with hooks inactive', modeOf(view), filesOnly)
    journal.equal(
      'the session without hooks keeps its actions',
      actionCalls(view),
      claudeToolUses(await claudeTranscript(lab.profile.claude, unhooked)).sort(),
    )
    journal.check('aang status lists the session as hooks inactive', (await inactiveSessions(lab, 'claude')).includes(view.session.id), await inactiveSessions(lab, 'claude'))
    journal.observe('claude hooks in the status while the binary is missing', await installation(lab, 'claude'))
    await rename(`${binary}.away`, binary)
    journal.step('aang-hook restored')
    const hooked = await claudeRun(lab, 'hook-back')
    await lab.settle()
    const back = await viewOf(lab, hooked)
    journal.equal('a new session after the binary is back has full support', modeOf(back), full)
    journal.check(
      'aang status keeps only the unhooked session as hooks inactive',
      (await inactiveSessions(lab, 'claude')).includes(view.session.id) &&
        !(await inactiveSessions(lab, 'claude')).includes(back.session.id),
      await inactiveSessions(lab, 'claude'),
    )
  },
}

const claudeLeaseLost: Scenario = {
  name: 'claude-lease-lost-mid-session',
  area: 'hooks',
  summary:
    'The spool lease disappears between two turns of one Claude session and the daemon does not renew it before the next turn: hooks of that turn are lost, its content comes from the transcript, and status shows the missing lease; after a restart hooks resume',
  runtimes: ['claude'],
  config: { spool: { checkIntervalMs: 600_000 } },
  scripts: () => ({
    claude: {
      'lease-first': [[bash(echo('first'))], [{ text: 'done' }]],
      'lease-second': [[bash(echo('second'))], [{ text: 'done' }]],
      'lease-third': [[bash(echo('third'))], [{ text: 'done' }]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    const session = await claudeRun(lab, 'lease-first')
    await lab.settle()
    for (const lease of await leases(lab)) await rm(join(lab.profile.spool, lease))
    journal.step('spool lease removed')
    await claudeRun(lab, 'lease-second', ['--resume', session])
    journal.equal('hooks wrote nothing without a lease', await lab.spoolFiles(), [])
    await lab.settle()
    const status = await lab.status()
    journal.equal('aang status shows that there is no lease', status.spool.lease_expires_at, null)
    const lost = await viewOf(lab, session)
    journal.equal(
      'the turn without hooks is read from the transcript',
      actionCalls(lost),
      claudeToolUses(await claudeTranscript(lab.profile.claude, session)).sort(),
    )
    journal.check(
      'the turn without hook events is marked on the session',
      lost.session.support_mode !== 'full' || lost.run.objects.gaps.some((gap) => gap.session === lost.session.id && gap.kind === 'hooks_inactive'),
      modeOf(lost),
      null,
      findings.hooksLostMidSession,
    )
    journal.observe('session after the turn without hooks', { ...sessionFields(lost.session), ...modeOf(lost) })
    journal.observe('gaps after the turn without hooks', gapsOf(lost))
    journal.observe('status gaps after the turn without hooks', status.gaps.map(({ kind, details }) => ({ kind, details })))
    await lab.killDaemon()
    await lab.startDaemon()
    journal.check('the restarted daemon grants a lease', (await leases(lab)).length === 1, await leases(lab))
    await claudeRun(lab, 'lease-third', ['--resume', session])
    await lab.settle()
    const view = await viewOf(lab, session)
    journal.equal(
      'every tool use of the transcript is one action',
      actionCalls(view),
      claudeToolUses(await claudeTranscript(lab.profile.claude, session)).sort(),
    )
    journal.observe('session after hooks resumed', { ...sessionFields(view.session), ...modeOf(view) })
  },
}

const prependForeignHook = async (codexHome: string): Promise<void> => {
  const path = join(codexHome, 'hooks.json')
  const document = JSON.parse(await readFile(path, 'utf8')) as { hooks: Record<string, unknown[]> }
  document.hooks['PreToolUse'] = [{ hooks: [{ type: 'command', command: 'true', timeout: 2 }] }, ...(document.hooks['PreToolUse'] ?? [])]
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`)
}

const codexTrust: Scenario = {
  name: 'codex-hooks-trust',
  area: 'hooks',
  summary:
    'Codex hooks of aang before and after trust: untrusted hooks do not run and the session is files-only; after trust the status is active and sessions have full support; a repeated aang install keeps the trust; a foreign hook inserted before the aang entry shifts the positional trust key',
  runtimes: ['codex'],
  scripts: () => ({
    codex: {
      untrusted: [[shell(echo('untrusted'))]],
      trusted: [[shell(echo('trusted'))]],
      reinstalled: [[shell(echo('reinstalled'))]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['codex'])
    await lab.startDaemon()
    journal.equal('installed hooks are untrusted', await awaitInstallation(lab, 'codex', 'untrusted'), 'untrusted')
    const untrusted = await codexRun(lab, [...codexFlags, codexPrompt('untrusted')])
    journal.equal('Codex skipped the untrusted hooks', await lab.spoolFiles(), [])
    await lab.settle()
    const view = await viewOf(lab, untrusted)
    journal.equal('the session with untrusted hooks is files-only with hooks inactive', modeOf(view), filesOnly)
    journal.check('aang status lists it as hooks inactive', (await inactiveSessions(lab, 'codex')).includes(view.session.id), await inactiveSessions(lab, 'codex'))
    await trustCodexHooks(lab)
    journal.equal('trusted hooks are active', await awaitInstallation(lab, 'codex', 'active'), 'active')
    const trusted = await codexRun(lab, [...codexFlags, codexPrompt('trusted')])
    await lab.settle()
    journal.equal('a session with trusted hooks has full support', modeOf(await viewOf(lab, trusted)), full)
    const hooksFile = join(lab.profile.codex, 'hooks.json')
    const before = await readFile(hooksFile, 'utf8')
    await installHooks(lab, ['codex'])
    journal.equal('a repeated install leaves hooks.json as it was', (await readFile(hooksFile, 'utf8')) === before, true)
    journal.equal('a repeated install keeps the trust', await awaitInstallation(lab, 'codex', 'active'), 'active')
    const reinstalled = await codexRun(lab, [...codexFlags, codexPrompt('reinstalled')])
    await lab.settle()
    journal.equal('a session after the repeated install has full support', modeOf(await viewOf(lab, reinstalled)), full)
    await prependForeignHook(lab.profile.codex)
    journal.step('a foreign PreToolUse hook is inserted before the aang entry')
    journal.equal(
      'the shifted aang entry loses its trust and the status shows it',
      await awaitInstallation(lab, 'codex', 'untrusted'),
      'untrusted',
    )
  },
}

const claudePluginDisabled: Scenario = {
  name: 'claude-plugin-disabled',
  area: 'hooks',
  summary:
    'The aang plugin is disabled with claude plugin disable: aang status shows hooks disabled and a new session is files-only; after enabling, sessions have full support again',
  runtimes: ['claude'],
  scripts: () => ({
    claude: {
      disabled: [[bash(echo('disabled'))], [{ text: 'done' }]],
      enabled: [[bash(echo('enabled'))], [{ text: 'done' }]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    await lab.startDaemon()
    journal.equal('the installed plugin is active', await awaitInstallation(lab, 'claude', 'active'), 'active')
    await finished(lab, 'claude plugin disable', lab.claude(['plugin', 'disable', claudePluginId]))
    journal.equal('the disabled plugin is shown as disabled', await awaitInstallation(lab, 'claude', 'disabled'), 'disabled')
    const disabled = await claudeRun(lab, 'disabled')
    await lab.settle()
    journal.equal('a session with the disabled plugin is files-only', modeOf(await viewOf(lab, disabled)), filesOnly)
    await finished(lab, 'claude plugin enable', lab.claude(['plugin', 'enable', claudePluginId]))
    journal.equal('the enabled plugin is active again', await awaitInstallation(lab, 'claude', 'active'), 'active')
    const enabled = await claudeRun(lab, 'enabled')
    await lab.settle()
    journal.equal('a session with the enabled plugin has full support', modeOf(await viewOf(lab, enabled)), full)
  },
}

const pluginsOf = (stdout: string): string[] =>
  stdout
    .split('\n')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as { subtype?: unknown; plugins?: { name?: unknown; source?: unknown }[] }
        return event.subtype === 'init' ? (event.plugins ?? []) : []
      } catch {
        return []
      }
    })
    .filter(({ name }) => name === 'aang')
    .map(({ source }) => String(source))

const claudeDuplicatePlugin: Scenario = {
  name: 'claude-duplicate-plugin',
  area: 'hooks',
  summary:
    'The aang plugin is installed from the marketplace, a copy sits in the fallback skills directory and another is passed with --plugin-dir: Claude loads one plugin per name, so every hook is delivered once and no double registration arises; the engine check of ADR-0004 stays a safety net',
  runtimes: ['claude'],
  scripts: () => ({
    claude: {
      'skills-copy': [[bash(echo('skills'))], [{ text: 'done' }]],
      'inline-copy': [[bash(echo('inline'))], [{ text: 'done' }]],
    },
  }),
  run: async (lab) => {
    const { journal } = lab
    await installHooks(lab, ['claude'])
    const { binary, spool } = hookInstallPaths(lab.profile.aangHome)
    await writeClaudePlugin({ directory: join(lab.profile.claude, 'skills', 'aang'), hookBinary: binary, spool })
    const inline = join(lab.work, 'aang-plugin-copy')
    await writeClaudePlugin({ directory: inline, hookBinary: binary, spool })
    journal.step('copies of the plugin are written to the skills directory and to a plugin directory')
    await lab.startDaemon()
    const skills = await finished(lab, 'claude skills-copy', claudeTurn(lab, 'skills-copy'))
    const inlined = await finished(lab, 'claude inline-copy', claudeTurn(lab, 'inline-copy', ['--plugin-dir', inline]))
    journal.equal('one aang plugin is loaded in each session', [pluginsOf(skills.stdout), pluginsOf(inlined.stdout)], [
      ['aang@aang'],
      ['aang@inline'],
    ])
    await lab.settle()
    for (const [name, result] of [['skills-copy', skills], ['inline-copy', inlined]] as const) {
      const session = claudeSessionOf(result.stdout)
      const view = await viewOf(lab, session)
      journal.equal(`${name}: the session is not flagged as double registration`, view.session.double_registration, false)
      journal.equal(
        `${name}: every tool use is one action`,
        actionCalls(view),
        claudeToolUses(await claudeTranscript(lab.profile.claude, session)).sort(),
      )
    }
    journal.observe('raw records', (await lab.records()).counts)
  },
}

export const hookScenarios: readonly Scenario[] = [
  claudeHookBinaryMissing,
  claudeLeaseLost,
  codexTrust,
  claudePluginDisabled,
  claudeDuplicatePlugin,
]
