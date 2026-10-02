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
    return `- удалён рабочий каталог ${layout.dir}`
  }
  const entries = await readdir(layout.dir)
  await Promise.all(
    entries.filter((name) => join(layout.dir, name) !== layout.results).map((name) => remove(join(layout.dir, name))),
  )
  return `- рабочий каталог очищен, оставлен ${layout.results}`
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
    done.push(`- плагин ${claudePluginId} и маркетплейс aang удалены из пользовательского scope Claude`)
  }
  if (state.codex !== null) {
    const codex = state.codex
    const removal = await removeCodexHooks(codex)
    done.push(
      removal.missingFile
        ? `- ${codex.hooksFile} не найден, записи aang удалять не из чего`
        : removal.deletedFile
          ? `- ${codex.hooksFile} создавался подготовкой и удалён`
          : `- из ${codex.hooksFile} удалено записей aang: ${String(removal.removed)}, нейтрализовано на месте: ${String(removal.neutralized)}`,
    )
    if (codex.backup !== null) {
      notes.push(`- резервная копия hooks.json до подготовки: ${codex.backup} (удалите после проверки)`)
    }
    notes.push(
      `- записи доверия hooks aang в ${join(codex.codexHome, 'config.toml')} (hooks.state."${codex.hooksFile}:<событие>:i:j") Codex не удаляет; уберите их вручную, если они не нужны`,
    )
    state = { ...state, codex: null }
    await writeState(layout, state)
  }
  if (state.outsideDir !== null) {
    await remove(state.outsideDir)
    done.push(`- удалён ${state.outsideDir}`)
    state = { ...state, outsideDir: null }
    await writeState(layout, state)
  }
  done.push(await removeWorkDir(layout, keepResults))
  notes.push(
    `- запись проекта ${layout.probeRepo} в ~/.claude.json или $CLAUDE_CONFIG_DIR/.claude.json после диалога доверия TUI`,
  )
  return [
    'Откат выполнен:',
    ...done,
    '',
    'Не откатывается автоматически:',
    ...notes,
    '',
    sessions.length === 0
      ? 'Сессий чек-листа в корнях рантаймов не найдено.'
      : 'Сессии и файлы, созданные во время чек-листа (удалите вручную, если они не нужны):',
    ...sessions.map((path) => `- ${path}`),
  ]
}
