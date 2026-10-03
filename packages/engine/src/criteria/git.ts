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
  readonly resolve: (checks: readonly CriterionCheck[]) => Promise<ResolvedCheck[]>
}

const unresolved: CheckGit = { worktree: null, commit: null }

const output = async (directory: string, args: readonly string[]): Promise<string | null> => {
  try {
    return (await readGit(directory, args)).trim()
  } catch {
    return null
  }
}

export const createGitResolver = (): GitResolver => {
  const worktrees = new Map<string, string>()
  const commits = new Map<string, string>()

  const worktreeOf = async (directory: string): Promise<string | null> => {
    const known = worktrees.get(directory)
    if (known !== undefined) {
      return known
    }
    const top = await output(directory, ['rev-parse', '--show-toplevel'])
    if (top === null || top === '') {
      return null
    }
    const worktree = resolve(top)
    worktrees.set(directory, worktree)
    return worktree
  }

  const commitOf = async (directory: string, name: string): Promise<string | null> => {
    const key = canonicalJson([directory, name])
    const known = commits.get(key)
    if (known !== undefined) {
      return known
    }
    const commit = (await output(directory, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]))?.toLowerCase()
    if (commit === undefined || !commit.startsWith(name)) {
      return null
    }
    commits.set(key, commit)
    return commit
  }

  const gitOf = async ({ result, directory, commit }: CriterionCheck): Promise<CheckGit> => {
    if (!result.passed || directory === null) {
      return unresolved
    }
    const worktree = await worktreeOf(directory)
    return { worktree, commit: worktree === null || commit === null ? null : await commitOf(directory, commit) }
  }

  return {
    resolve: async (checks) => {
      const resolved: ResolvedCheck[] = []
      for (const check of checks) {
        resolved.push({ check, git: await gitOf(check) })
      }
      return resolved
    },
  }
}
