import { resolve } from 'node:path'
import { canonicalJson } from '@aang/contract/ids'
import { readGit } from '../ingest/git.js'
import type { CriterionCheck, ReportedCommit } from './plan.js'

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

interface Lookup {
  readonly found: string
  readonly missed: string
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

const worktreeLookup = (directory: string, { result }: CriterionCheck): Lookup => ({
  found: canonicalJson(['worktree', directory]),
  missed: canonicalJson(['worktree', directory, result.evidence]),
})

const commitLookup = (directory: string, { result }: CriterionCheck, commit: ReportedCommit): Lookup => ({
  found: canonicalJson(['commit', directory, commit.name]),
  missed: canonicalJson(['commit', directory, commit.name, result.evidence, [...commit.evidence]]),
})

export const createGitResolver = (): GitResolver => {
  const found = new Map<string, string>()
  const missed = new Set<string>()

  const known = (lookup: Lookup): string | null | undefined =>
    found.get(lookup.found) ?? (missed.has(lookup.missed) ? null : undefined)

  const learn = async (lookup: Lookup, read: () => Promise<string | null>): Promise<string | null> => {
    const cached = known(lookup)
    if (cached !== undefined) {
      return cached
    }
    const value = await read()
    if (value === null) {
      missed.add(lookup.missed)
    } else {
      found.set(lookup.found, value)
    }
    return value
  }

  const gitOf = (check: CriterionCheck): CheckGit | undefined => {
    const { result, directory, commit } = check
    if (!result.passed || directory === null) {
      return unresolved
    }
    const worktree = known(worktreeLookup(directory, check))
    if (worktree === undefined) {
      return undefined
    }
    if (worktree === null || commit === null) {
      return { worktree, commit: null }
    }
    const verified = known(commitLookup(directory, check, commit))
    return verified === undefined ? undefined : { worktree, commit: verified }
  }

  return {
    prepare: async (checks) => {
      for (const check of checks) {
        const { result, directory, commit } = check
        if (!result.passed || directory === null) {
          continue
        }
        const worktree = await learn(worktreeLookup(directory, check), () => worktreeOf(directory))
        if (worktree !== null && commit !== null) {
          await learn(commitLookup(directory, check, commit), () => commitOf(directory, commit.name))
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
