import { join } from 'node:path'
import type { Runtime } from '@aang/contract'
import type { SnapshotRoot } from './snapshot.js'
import type { TailRoot } from './tail.js'
import type { TreeRoot } from './tree.js'

export interface CollectorRoots {
  readonly tree: readonly TreeRoot[]
  readonly tail: readonly TailRoot[]
  readonly snapshots: readonly SnapshotRoot[]
}

const jsonExtension = '.json'
const metaExtension = '.meta.json'

const isProjectSnapshot = (segments: readonly string[]): boolean => {
  const name = segments.at(-1) ?? ''
  return name.endsWith(metaExtension) || (name.endsWith(jsonExtension) && segments.at(-2) === 'workflows')
}

const isTeamConfig = (segments: readonly string[]): boolean => segments.length === 2 && segments[1] === 'config.json'

const isRegistryEntry = (segments: readonly string[]): boolean =>
  segments.length === 1 && (segments[0] ?? '').endsWith(jsonExtension)

export const collectorRoots = (runtimeRoots: Readonly<Record<Runtime, string>>): CollectorRoots => {
  const claudeProjects: TreeRoot = { directory: join(runtimeRoots.claude, 'projects'), recursive: true }
  const claudeTeams: TreeRoot = { directory: join(runtimeRoots.claude, 'teams'), recursive: true }
  const claudeRegistry: TreeRoot = { directory: join(runtimeRoots.claude, 'sessions'), recursive: false }
  const codexSessions: TreeRoot = { directory: join(runtimeRoots.codex, 'sessions'), recursive: true }
  const codexArchive: TreeRoot = { directory: join(runtimeRoots.codex, 'archived_sessions'), recursive: true }
  return {
    tree: [claudeRegistry, claudeTeams, claudeProjects, codexSessions, codexArchive],
    tail: [
      { root: claudeProjects, runtime: 'claude', channel: 'transcript' },
      { root: codexSessions, runtime: 'codex', channel: 'rollout' },
      { root: codexArchive, runtime: 'codex', channel: 'rollout' },
    ],
    snapshots: [
      { root: claudeRegistry, runtime: 'claude', channel: 'registry', selects: isRegistryEntry },
      { root: claudeTeams, runtime: 'claude', channel: 'transcript', selects: isTeamConfig },
      { root: claudeProjects, runtime: 'claude', channel: 'transcript', selects: isProjectSnapshot },
    ],
  }
}
