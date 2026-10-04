import { relative, resolve, sep } from 'node:path'
import type { EpochNs, GitSnapshotPayload, RunId, SessionKey, SnapshotTrigger } from '@aang/contract'
import { readGit } from '../ingest/git.js'
import { contains } from '../ingest/scope.js'

export interface SnapshotRequest {
  readonly run: RunId
  readonly root: SessionKey
  readonly cwd: string
  readonly maskRoot: string
  readonly masks: readonly string[]
  readonly trigger: SnapshotTrigger
}

export interface TakenSnapshot {
  readonly request: SnapshotRequest
  readonly payload: GitSnapshotPayload
  readonly at: EpochNs
}

type StatusEntry = GitSnapshotPayload['entries'][number]

const pathspecOf = (top: string, maskRoot: string, mask: string): string | null => {
  const target = resolve(maskRoot, mask)
  if (contains(top, target)) {
    const relation = relative(top, target)
    return relation === '' ? '.' : relation.split(sep).join('/')
  }
  return contains(target, top) ? '.' : null
}

const renamed = (status: string): boolean => status.includes('R') || status.includes('C')

const statusEntries = (output: string): StatusEntry[] => {
  const fields = output.split('\0')
  const entries: StatusEntry[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? ''
    if (field.length < 4) {
      continue
    }
    const status = field.slice(0, 2)
    entries.push({ status, path: field.slice(3) })
    if (renamed(status)) {
      index += 1
    }
  }
  return entries
}

const headOf = async (top: string): Promise<string | null> => {
  try {
    return (await readGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim()
  } catch {
    return null
  }
}

const statusArguments = ['status', '--porcelain=v1', '-z', '--ignored=traditional', '--untracked-files=normal', '--ignore-submodules=none']

const failure = (request: SnapshotRequest, error: unknown): GitSnapshotPayload => ({
  worktree: request.cwd,
  trigger: request.trigger,
  masks: [...request.masks],
  head: null,
  entries: [],
  clean: false,
  error: error instanceof Error ? error.message : String(error),
})

export const takeSnapshot = async (request: SnapshotRequest, now: () => EpochNs): Promise<TakenSnapshot | null> => {
  let payload: GitSnapshotPayload
  try {
    const top = resolve((await readGit(request.cwd, ['rev-parse', '--show-toplevel'])).trim())
    const pathspecs = request.masks.flatMap((mask) => pathspecOf(top, request.maskRoot, mask) ?? [])
    if (pathspecs.length === 0) {
      return null
    }
    const head = await headOf(top)
    const entries = statusEntries(await readGit(top, [...statusArguments, '--', ...pathspecs]))
    payload = {
      worktree: top,
      trigger: request.trigger,
      masks: [...request.masks],
      head,
      entries,
      clean: head !== null && entries.length === 0,
      error: null,
    }
  } catch (error) {
    payload = failure(request, error)
  }
  return { request, payload, at: now() }
}
