import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { endpoints, type RunSnapshot } from '@aang/contract'
import { objectId, runId } from '@aang/contract/ids'
import { invokeHook } from '@aang/testkit'
import { describe, test, type TestContext } from 'vitest'
import { bearer, type Home, spawnDaemon } from './daemon.js'
import { claudeHook, claudeSession, hookBinary, openFinished, rawRecords, sleep, waitUntil, watchedHome } from './sessions.js'

const processCheckIntervalMs = 100

const stopSessionProcess = async (child: ChildProcess, signal: NodeJS.Signals): Promise<void> => {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill(signal)
    await exited
  }
}

interface SessionProcess {
  readonly child: ChildProcess
  readonly pid: number
}

const startSessionProcess = async (onTestFinished: TestContext['onTestFinished']): Promise<SessionProcess> => {
  const child = spawn(process.execPath, ['-e', "process.stdin.on('end', () => process.exit(0)).resume()"], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  await once(child, 'spawn')
  onTestFinished(() => stopSessionProcess(child, 'SIGKILL'))
  const { pid } = child
  if (pid === undefined) {
    throw new Error('the session process has no pid')
  }
  return { child, pid }
}

const registryFile = (home: Home, pid: number): string => join(home.root, '.claude', 'sessions', `${String(pid)}.json`)

const register = async (home: Home, pid: number, session: string, cwd: string): Promise<string> => {
  const path = registryFile(home, pid)
  const written = `${path}.tmp`
  await mkdir(join(home.root, '.claude', 'sessions'), { recursive: true })
  await writeFile(
    written,
    JSON.stringify({ pid, sessionId: session, cwd, kind: 'interactive', entrypoint: 'cli', status: 'busy', startedAt: Date.now(), statusUpdatedAt: Date.now() }),
  )
  await rename(written, path)
  return path
}

const hookOf = (home: Home, pid: number, payload: string): Promise<void> =>
  invokeHook(
    { binary: hookBinary, spool: home.paths.spool },
    { runtime: 'claude', registration: 'plugin', env: { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: String(pid) }, payload },
  )

const startTool = async (home: Home, pid: number, session: string, cwd: string, call: string): Promise<void> => {
  for (const payload of [
    claudeHook('SessionStart.startup', session, cwd),
    claudeHook('UserPromptSubmit', session, cwd),
    claudeHook('PreToolUse.Bash', session, cwd, { tool_use_id: call }),
  ]) {
    await hookOf(home, pid, payload)
  }
}

const snapshotOf = async (base: string, home: Home, session: string): Promise<RunSnapshot | null> => {
  const response = await fetch(`${base}/api/runs/${runId(claudeSession(session))}`, { headers: bearer(home.token) })
  return response.status === 200 ? endpoints.run.response.parse(await response.json()) : null
}

const until = async (
  base: string,
  home: Home,
  session: string,
  accept: (snapshot: RunSnapshot) => boolean,
): Promise<RunSnapshot> => {
  const seen: { last: RunSnapshot | null } = { last: null }
  await waitUntil(async () => {
    seen.last = await snapshotOf(base, home, session)
    return seen.last !== null && accept(seen.last)
  })
  if (seen.last === null) {
    throw new Error(`the run of ${session} was not found`)
  }
  return seen.last
}

const running = (call: string) => (snapshot: RunSnapshot): boolean =>
  snapshot.objects.sessions.some(({ state }) => state === 'turn_running') &&
  snapshot.objects.actions.some(({ key, execution }) => key.call === call && execution.state === 'running')

describe.concurrent('the daemon checks the processes of Claude registry files', () => {
  test('a session process killed mid-tool leaves the session unknown and its action unknown, once across restarts', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished, { collector: { rootsScanIntervalMs: 200, processCheckIntervalMs } })
    const session = 'q45-killed-mid-tool'
    const call = 'toolu_q45_killed'
    const solver = await startSessionProcess(onTestFinished)
    const daemon = await spawnDaemon(home, onTestFinished)
    await register(home, solver.pid, session, workspace)
    await startTool(home, solver.pid, session, workspace, call)
    await until(daemon.base, home, session, running(call))

    await stopSessionProcess(solver.child, 'SIGKILL')

    const after = await until(daemon.base, home, session, ({ objects }) => objects.sessions.some(({ state }) => state === 'unknown'))
    expect(after.objects.sessions).toMatchObject([{ state: 'unknown', execution: { state: 'unknown' } }])
    expect(after.objects.actions).toMatchObject([
      { key: { call }, execution: { state: 'unknown' }, outcome: { value: 'unknown', basis: { kind: 'observed' } } },
    ])
    expect(await daemon.shutdown()).toBe(0)

    const restarted = await spawnDaemon(home, onTestFinished)
    await sleep(processCheckIntervalMs * 10)
    expect(await restarted.shutdown()).toBe(0)
    const store = openFinished(home, onTestFinished)
    const exits = rawRecords(store).filter(({ position }) => position.kind === 'process_exited')
    expect(exits).toMatchObject([{ channel: 'registry', parse_state: 'parsed', position: { pid: solver.pid } }])
    expect(store.observations.getSession(objectId(claudeSession(session)))).toMatchObject({ state: 'unknown' })
  })

  test('a session process that removes its registry file before it exits leaves no exit and keeps the turn', async ({
    expect,
    onTestFinished,
  }) => {
    const { home, workspace } = await watchedHome(onTestFinished, { collector: { rootsScanIntervalMs: 200, processCheckIntervalMs } })
    const session = 'q45-clean-exit'
    const call = 'toolu_q45_clean'
    const solver = await startSessionProcess(onTestFinished)
    const daemon = await spawnDaemon(home, onTestFinished)
    const path = await register(home, solver.pid, session, workspace)
    await startTool(home, solver.pid, session, workspace, call)
    await until(daemon.base, home, session, running(call))

    await rm(path)
    await stopSessionProcess(solver.child, 'SIGTERM')
    await sleep(processCheckIntervalMs * 10)

    expect(await snapshotOf(daemon.base, home, session)).toMatchObject({
      objects: { sessions: [{ state: 'turn_running' }], actions: [{ key: { call }, execution: { state: 'running' } }] },
    })
    expect(await daemon.shutdown()).toBe(0)
    const store = openFinished(home, onTestFinished)
    expect(rawRecords(store).filter(({ position }) => position.kind === 'process_exited')).toEqual([])
  })
})
