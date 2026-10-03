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

const readCheckGit = async (directory: string, commit: ReportedCommit | null): Promise<CheckGit> => {
  const worktree = await worktreeOf(directory)
  return { worktree, commit: worktree === null || commit === null ? null : await commitOf(directory, commit.name) }
}

const resultKey = ({ result, directory, commit }: CriterionCheck): string =>
  canonicalJson([directory, result.evidence, commit === null ? null : [commit.name, [...commit.evidence]]])

export const createGitResolver = (): GitResolver => {
  const known = new Map<string, CheckGit>()

  const gitOf = (check: CriterionCheck): CheckGit | undefined =>
    !check.result.passed || check.directory === null ? unresolved : known.get(resultKey(check))

  return {
    prepare: async (checks) => {
      for (const check of checks) {
        const key = resultKey(check)
        if (check.result.passed && check.directory !== null && !known.has(key)) {
          known.set(key, await readCheckGit(check.directory, check.commit))
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
