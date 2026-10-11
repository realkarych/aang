import { readdir, rm, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { claudePluginId, uninstallClaudePlugin } from '@aang/hook'
import { pathForms } from './anonymize.js'
import { removeCodexHooks } from './codex-hooks.js'
import { type Collected, loadCollected } from './collect.js'
import { textField } from './events.js'
import { probeProjectDirs, type RootOverrides } from './files.js'
import type { ChecklistLayout } from './layout.js'
import { type ChecklistState, writeState } from './state.js'

export interface CleanupOptions {
  readonly dir: string
  readonly keepResults: boolean
  readonly roots: RootOverrides
}

const removalAttempts = 5

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

const remove = (path: string): Promise<void> => rm(path, { recursive: true, force: true, maxRetries: removalAttempts })

const codexWorktreeDirs = (worktrees: string, cwds: readonly string[]): string[] => [
  ...new Set(
    cwds.flatMap((cwd) => {
      const inside = relative(worktrees, cwd)
      const [first] = inside.split(sep)
      return inside === '' || inside.startsWith('..') || first === undefined ? [] : [join(worktrees, first)]
    }),
  ),
]

const createdSessions = async ({ layout, roots, events, files }: Collected): Promise<string[]> => {
  const transcripts = files.claudeTranscripts.flatMap((transcript) =>
    transcript.path === null ? [] : [transcript.path],
  )
  const transcriptDirs = (
    await Promise.all(
      files.claudeTranscripts.map(async (transcript) => {
        const companion = transcript.path === null ? null : transcript.path.replace(/\.jsonl$/, '')
        return companion !== null && (await exists(companion)) ? [companion] : []
      }),
    )
  ).flat()
  const cwds = events.filter((event) => event.runtime === 'codex').flatMap((event) => textField(event, 'cwd') ?? [])
  return [
    ...new Set([
      ...(await probeProjectDirs(roots, pathForms(layout.probeRepo))),
      ...transcripts,
      ...transcriptDirs,
      ...files.desktopSessions.map((meta) => meta.path),
      ...files.codexRollouts.flatMap((rollout) => (rollout.path === null ? [] : [rollout.path])),
      ...codexWorktreeDirs(join(roots.codexHome, 'worktrees'), cwds),
    ]),
  ]
}

const removeWorkDir = async (layout: ChecklistLayout, keepResults: boolean): Promise<string> => {
  if (!keepResults) {
    await remove(layout.dir)
    return `- removed the working directory ${layout.dir}`
  }
  const entries = await readdir(layout.dir)
  await Promise.all(
    entries.filter((name) => join(layout.dir, name) !== layout.results).map((name) => remove(join(layout.dir, name))),
  )
  return `- working directory cleaned, kept ${layout.results}`
}

const revertClaude = async (layout: ChecklistLayout, state: ChecklistState): Promise<ChecklistState> => {
  await uninstallClaudePlugin({
    aangHome: layout.aangHome,
    claude: { command: state.claude.command, configDir: state.claude.configDir },
  })
  const reverted: ChecklistState = { ...state, claude: { ...state.claude, registered: false } }
  await writeState(layout, reverted)
  return reverted
}

export const cleanup = async ({ dir, keepResults, roots }: CleanupOptions): Promise<string[]> => {
  const collected = await loadCollected(dir, roots, false)
  const { layout } = collected
  let { state } = collected
  const sessions = await createdSessions(collected)
  const done: string[] = []
  const notes: string[] = []
  if (state.claude.registered) {
    state = await revertClaude(layout, state)
    done.push(`- plugin ${claudePluginId} and the aang marketplace removed from the Claude user scope`)
  }
  if (state.codex !== null) {
    const codex = state.codex
    const removal = await removeCodexHooks(codex)
    done.push(
      removal.missingFile
        ? `- ${codex.hooksFile} not found, no aang entries to remove`
        : removal.deletedFile
          ? `- ${codex.hooksFile} was created by prepare and has been removed`
          : `- aang entries removed from ${codex.hooksFile}: ${String(removal.removed)}, neutralized in place: ${String(removal.neutralized)}`,
    )
    if (codex.backup !== null) {
      notes.push(`- backup of hooks.json before prepare: ${codex.backup} (delete it after checking)`)
    }
    notes.push(
      `- Codex does not remove aang hook trust entries in ${join(codex.codexHome, 'config.toml')} (hooks.state."${codex.hooksFile}:<event>:i:j"); remove them by hand if you do not need them`,
    )
    state = { ...state, codex: null }
    await writeState(layout, state)
  }
  if (state.outsideDir !== null) {
    await remove(state.outsideDir)
    done.push(`- removed ${state.outsideDir}`)
    state = { ...state, outsideDir: null }
    await writeState(layout, state)
  }
  done.push(await removeWorkDir(layout, keepResults))
  notes.push(
    `- the project entry ${layout.probeRepo} in ~/.claude.json or $CLAUDE_CONFIG_DIR/.claude.json after the TUI trust dialog`,
  )
  return [
    'Rolled back:',
    ...done,
    '',
    'Not rolled back automatically:',
    ...notes,
    '',
    sessions.length === 0
      ? 'No checklist sessions found in the runtime roots.'
      : 'Sessions and files created during the checklist (delete them by hand if you do not need them):',
    ...sessions.map((path) => `- ${path}`),
  ]
}
