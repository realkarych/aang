import { resolve } from 'node:path'
import { canonicalJson } from '@aang/contract/ids'
import { readGit } from '../ingest/git.js'
import type { CriterionCheck } from './plan.js'

export interface CheckGit {
  readonly worktree: string | null
  readonly commit: string | null
}

export interface ResolvedCheck {
  readonly check: CriterionCheck
  readonly git: CheckGit
}

export interface GitResolver {
  readonly prepare: (checks: readonly CriterionCheck[]) => Promise<void>
  readonly resolved: (checks: readonly CriterionCheck[]) => ResolvedCheck[] | null
}

const unresolved: CheckGit = { worktree: null, commit: null }

const output = async (directory: string, args: readonly string[]): Promise<string | null> => {
  try {
    return (await readGit(directory, args)).trim()
  } catch {
    return null
  }
}

const worktreeOf = async (directory: string): Promise<string | null> => {
  const top = await output(directory, ['rev-parse', '--show-toplevel'])
  return top === null || top === '' ? null : resolve(top)
}

const commitOf = async (directory: string, name: string): Promise<string | null> => {
  const commit = (await output(directory, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]))?.toLowerCase()
  return commit !== undefined && commit.startsWith(name) ? commit : null
}

const commitKey = (directory: string, name: string): string => canonicalJson([directory, name])

export const createGitResolver = (): GitResolver => {
  const worktrees = new Map<string, string | null>()
  const commits = new Map<string, string | null>()

  const gitOf = ({ result, directory, commit }: CriterionCheck): CheckGit | undefined => {
    if (!result.passed || directory === null) {
      return unresolved
    }
    const worktree = worktrees.get(directory)
    if (worktree === undefined) {
      return undefined
    }
    if (worktree === null || commit === null) {
      return { worktree, commit: null }
    }
    const verified = commits.get(commitKey(directory, commit.name))
    return verified === undefined ? undefined : { worktree, commit: verified }
  }

  return {
    prepare: async (checks) => {
      for (const { result, directory, commit } of checks) {
        if (!result.passed || directory === null) {
          continue
        }
        if (!worktrees.has(directory)) {
          worktrees.set(directory, await worktreeOf(directory))
        }
        if (commit === null || worktrees.get(directory) === null) {
          continue
        }
        const key = commitKey(directory, commit.name)
        if (!commits.has(key)) {
          commits.set(key, await commitOf(directory, commit.name))
        }
      }
    },
    resolved: (checks) => {
      const resolved: ResolvedCheck[] = []
      for (const check of checks) {
        const git = gitOf(check)
        if (git === undefined) {
          return null
        }
        resolved.push({ check, git })
      }
      return resolved
    },
  }
}
