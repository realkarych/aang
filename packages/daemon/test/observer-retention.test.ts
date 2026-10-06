import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ArtifactVersion, endpoints, type RunId, type StageArtifact } from '@aang/contract'
import { runId } from '@aang/contract/ids'
import { installFakeCodex, mainStageTitle } from '@aang/testkit'
import { test } from 'vitest'
import { bearer, type Home, startDaemon } from './daemon.js'
import { configure, installLauncher, observerEnvironment } from './observers.js'
import { claudeHook, claudeSession, enqueue, waitUntil, watchedHome } from './sessions.js'

const session = 'session-h6-retention'

const run: RunId = runId(claudeSession(session))

const write = (call: string, command: string, workspace: string): string[] =>
  ['PreToolUse.Bash', 'PostToolUse.Bash'].map((name) =>
    claudeHook(name, session, workspace, { tool_use_id: call, tool_input: { command, description: 'Write a file' } }),
  )

const outputsOf = async (base: string, home: Home): Promise<StageArtifact[]> => {
  const headers = bearer(home.token)
  const snapshot = await fetch(`${base}/api/runs/${run}`, { headers })
  if (!snapshot.ok) {
    return []
  }
  const stage = endpoints.run.response.parse(await snapshot.json()).model.stages.find(({ title }) => title === mainStageTitle)
  if (stage === undefined) {
    return []
  }
  const inspector = await fetch(`${base}/api/runs/${run}/stages/${stage.id}`, { headers })
  return endpoints.stage.response.parse(await inspector.json()).outputs
}

const outputAt = (outputs: readonly StageArtifact[], path: string): ArtifactVersion | undefined =>
  outputs.find(({ version }) => version.ref.kind === 'file' && version.ref.path === path)?.version

const contentOf = async (base: string, home: Home, version: ArtifactVersion): Promise<unknown> => {
  const response = await fetch(`${base}/api/artifact-versions/${version.id}`, { headers: bearer(home.token) })
  return endpoints.artifactVersion.response.parse(await response.json()).content
}

test('the daemon keeps the files an accepted observer answer links, and after a restart the ones it could not read before', async ({
  expect,
  onTestFinished,
}) => {
  const { home, workspace } = await watchedHome(onTestFinished)
  const codex = installFakeCodex(join(home.root, 'fake-cli'), { replies: [{ kind: 'script', script: 'report' }] })
  await installLauncher(home)
  await configure(home, workspace, {
    cli: { codex: codex.path },
    observer: { backend: 'codex', crossVendor: true },
  })
  const workCalls = (): number =>
    codex.calls().filter(({ command, prompt }) => command === 'exec' && prompt?.includes(run) === true).length
  const report = join(workspace, 'report.md')
  const later = join(workspace, 'later.md')
  await writeFile(report, '# Report\n')

  const first = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
  await enqueue(home, 'claude', [
    claudeHook('SessionStart.startup', session, workspace),
    ...write('toolu_report', 'echo report > report.md', workspace),
    ...write('toolu_later', 'echo later > later.md', workspace),
  ])
  const linked: { outputs: StageArtifact[] } = { outputs: [] }
  await waitUntil(async () => {
    linked.outputs = await outputsOf(first.base, home)
    return outputAt(linked.outputs, report)?.retention.kind === 'file_read'
  })
  const kept = outputAt(linked.outputs, report)
  const missing = outputAt(linked.outputs, later)
  if (kept === undefined || missing === undefined) {
    throw new Error('both written files must be outputs of the stage')
  }
  expect(missing.retention).toEqual({ kind: 'reference' })
  expect(await contentOf(first.base, home, kept)).toMatchObject({ kind: 'stored', source: 'file_read', data: '# Report\n' })
  expect(await contentOf(first.base, home, missing)).toEqual({ kind: 'unavailable', reason: 'reference_only' })
  const calls = workCalls()
  first.abort()
  await first.stopped

  await writeFile(later, '# Later\n')
  const second = await startDaemon(home, onTestFinished, { env: observerEnvironment(home) })
  await waitUntil(async () => outputAt(await outputsOf(second.base, home), later)?.retention.kind === 'file_read')
  expect(await contentOf(second.base, home, missing)).toMatchObject({ kind: 'stored', source: 'file_read', data: '# Later\n' })
  expect(workCalls()).toBe(calls)
  second.abort()
  await second.stopped
})
