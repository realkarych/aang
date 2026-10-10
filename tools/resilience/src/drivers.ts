import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Action, Session } from '@aang/contract'
import { codexHooksState } from '@aang/hook'
import type { ClaudeStubBlock, CodexStubCall } from '@aang/record'
import { findings } from './findings.js'
import type { Lab, SessionView } from './lab.js'
import { waitFor } from './lab.js'
import type { Finished, Launched } from './processes.js'
import { tail } from './processes.js'
import { claudeSessionOf, codexThreadOf } from './sources.js'

export const bash = (command: string): ClaudeStubBlock => ({
  tool: 'Bash',
  input: { command, description: 'Run a resilience step' },
})

export const shell = (cmd: string): CodexStubCall => ({
  type: 'function_call',
  name: 'exec_command',
  arguments: { cmd, yield_time_ms: 60_000 },
})

export const echo = (word: string): string => `echo ${word}`

const claudeFlags: readonly string[] = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'default',
  '--allowedTools',
  'Bash,Read,Write,Edit',
  '--strict-mcp-config',
]

export const claudePrompt = (key: string): string =>
  `[aang:${key}] Run the commands of this step with the Bash tool, then reply done.`

export const claudeTurn = (lab: Lab, key: string, extra: readonly string[] = []): Launched =>
  lab.claude(['-p', claudePrompt(key), ...claudeFlags, ...extra])

export const codexPrompt = (key: string): string => `[aang:${key}] Run the commands of this step, then reply done.`

export const codexFlags: readonly string[] = ['--json', '--skip-git-repo-check']

export const codexTurn = (lab: Lab, args: readonly string[]): Launched => lab.codex(['exec', ...args])

export const finished = async (lab: Lab, what: string, launched: Launched): Promise<Finished> => {
  const result = await launched.done
  lab.journal.step(`${what} exited`, { code: result.code, signal: result.signal, timedOut: result.timedOut })
  if (result.code !== 0) {
    throw new Error(`${what} exited with ${String(result.code ?? result.signal)}: ${tail(result.stderr || result.stdout)}`)
  }
  return result
}

export const claudeSession = async (lab: Lab, what: string, launched: Launched): Promise<string> =>
  claudeSessionOf((await finished(lab, what, launched)).stdout)

export const codexThread = async (lab: Lab, what: string, launched: Launched): Promise<string> =>
  codexThreadOf((await finished(lab, what, launched)).stdout)

export const installHooks = async (lab: Lab, runtimes: readonly ('claude' | 'codex')[]): Promise<void> => {
  const result = await lab.aang('install', ...runtimes.map((runtime) => `--${runtime}`))
  if (result.code !== 0) {
    throw new Error(`aang install failed: ${tail(result.stderr || result.stdout)}`)
  }
}

export const trustCodexHooks = async (lab: Lab): Promise<number> => {
  const { aangHome, codex } = lab.profile
  const command = lab.config.cli?.codex
  if (typeof command !== 'string') throw new Error('the lab has no Codex command')
  const state = await codexHooksState({ aangHome, codexHome: codex, codex: { command } })
  const untrusted = state.hooks.filter((hook) => hook.trustStatus !== 'trusted')
  await appendFile(
    join(codex, 'config.toml'),
    untrusted
      .map((hook) => `\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(String(hook['currentHash']))}\n`)
      .join(''),
  )
  lab.journal.step('codex hooks of aang trusted as /hooks would', { hooks: untrusted.length })
  return untrusted.length
}

export const waitView = async (
  lab: Lab,
  runtimeSession: string,
  what: string,
  predicate: (view: SessionView) => boolean,
  timeoutMs = 30_000,
): Promise<SessionView> =>
  waitFor(
    what,
    async () => {
      const view = await lab.sessionView(runtimeSession)
      return view !== null && predicate(view) ? view : null
    },
    timeoutMs,
  )

export const claudeRun = async (lab: Lab, key: string, extra: readonly string[] = []): Promise<string> =>
  claudeSession(lab, `claude ${key}`, claudeTurn(lab, key, extra))

export const codexRun = async (lab: Lab, args: readonly string[]): Promise<string> =>
  codexThread(lab, `codex ${args[0] ?? ''}`, codexTurn(lab, args))

export const viewOf = async (lab: Lab, runtimeSession: string): Promise<SessionView> =>
  waitFor(`the session ${runtimeSession} in the API`, () => lab.sessionView(runtimeSession))

export const actionsOf = (view: SessionView): readonly Action[] =>
  view.run.objects.actions.filter((action) => action.session === view.session.id)

export const actionCalls = (view: SessionView): string[] => actionsOf(view).map((action) => action.key.call).sort()

export const sessionFields = (session: Session): Record<string, unknown> => ({
  state: session.state,
  execution: session.execution.state,
  freshness: session.freshness,
  support_mode: session.support_mode,
  launches: session.launches.map(({ launch }) => launch),
  double_registration: session.double_registration,
  unknown_records: session.unknown_records,
})

export const gapsOf = (view: SessionView): readonly { kind: string; open: boolean; details: string | null }[] =>
  view.run.objects.gaps
    .filter((gap) => gap.session === view.session.id || gap.session === null)
    .map((gap) => ({ kind: gap.kind, open: gap.closed_at === null, details: gap.details }))

export const otherGaps = (view: SessionView): ReturnType<typeof gapsOf> =>
  gapsOf(view).filter((gap) => gap.kind !== 'unknown_records' && !(gap.kind === 'hooks_inactive' && !gap.open))

export const checkNoTransientHooksGap = (lab: Lab, view: SessionView): boolean =>
  lab.journal.equal(
    'no hooks_inactive gap was opened for a session with active hooks',
    gapsOf(view).filter((gap) => gap.kind === 'hooks_inactive'),
    [],
    findings.transientHooksInactive,
  )

export const recordInventory = async (lab: Lab): Promise<void> => {
  const { unknown, counts } = await lab.records()
  lab.journal.observe('raw records by channel', counts)
  lab.journal.observe(
    'unrecognised records',
    unknown.map(({ channel, kind }) => `${channel}:${kind}`),
  )
}
