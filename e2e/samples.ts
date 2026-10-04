import { join } from 'node:path'
import type { RunId, Runtime } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import type { Profile } from '@aang/testkit'
import type { HookFields } from './fixtures.js'

export interface SampleSession {
  readonly runtime: Runtime
  readonly session: string
  readonly cwd: string
  readonly file: string
}

const claudeProject = 'projects/-tmp-aang-spike-cc-transcripts-run'

export const claudeOriginal: SampleSession = {
  runtime: 'claude',
  session: '86f93ed5-1acd-4c6e-8c60-f1c98335c2ef',
  cwd: '/tmp/aang-spike/cc-transcripts/run',
  file: `${claudeProject}/86f93ed5-1acd-4c6e-8c60-f1c98335c2ef.jsonl`,
}

export const claudeFork: SampleSession = {
  runtime: 'claude',
  session: 'cdfb3544-67c1-4590-a4d9-280593b6ed55',
  cwd: '/tmp/aang-spike/cc-transcripts/run',
  file: `${claudeProject}/cdfb3544-67c1-4590-a4d9-280593b6ed55.jsonl`,
}

export const codexThread: SampleSession = {
  runtime: 'codex',
  session: '01a0f752-40a7-76b2-9df9-5b374f75f98f',
  cwd: '/tmp/aang-spike/codex-cli/run1',
  file: 'sessions/2026/10/01/rollout-2026-10-01T11-55-58-01a0f752-40a7-76b2-9df9-5b374f75f98f.jsonl',
}

export const sessionFile = (profile: Profile, { runtime, file }: SampleSession): string =>
  join(runtime === 'claude' ? profile.claude : profile.codex, ...file.split('/'))

export const runOf = ({ runtime, session }: SampleSession): RunId => runId({ kind: 'session', runtime, session })

export const hookFields = (profile: Profile, session: SampleSession): HookFields => ({
  session_id: session.session,
  cwd: session.cwd,
  transcript_path: sessionFile(profile, session),
})
