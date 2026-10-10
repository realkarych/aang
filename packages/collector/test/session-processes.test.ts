import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeAdapter } from '@aang/adapter-claude'
import type { CollectedRecord } from '@aang/contract'
import { expect, test, vi } from 'vitest'
import { createSandbox, holdExclusively, runCollector, type Running, type Sandbox, sleep } from './sandbox.js'

const processCheckIntervalMs = 50

const stopProcess = async (child: ChildProcess, signal: NodeJS.Signals): Promise<void> => {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill(signal)
    await exited
  }
}

const startProcess = async (sandbox: Sandbox): Promise<{ readonly child: ChildProcess; readonly pid: number }> => {
  const child = spawn(process.execPath, ['-e', "process.stdin.on('end', () => process.exit(0)).resume()"], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  await once(child, 'spawn')
  sandbox.cleanup(() => stopProcess(child, 'SIGKILL'))
  if (child.pid === undefined) {
    throw new Error('the session process has no pid')
  }
  return { child, pid: child.pid }
}

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

const register = async (sandbox: Sandbox, name: string, content: string): Promise<string> => {
  const path = join(sandbox.claude, 'sessions', name)
  await mkdir(join(sandbox.claude, 'sessions'), { recursive: true })
  await writeFile(path, content)
  return path
}

const entry = (pid: number, session: string): string => JSON.stringify({ pid, sessionId: session, status: 'busy', startedAt: Date.now() })

const exits = (running: Running): CollectedRecord[] =>
  running.records().filter(({ position }) => position.kind === 'process_exited')

const snapshotsOf = (running: Running): string[] =>
  running.records().flatMap(({ position }) => (position.kind === 'file' ? [position.path] : []))

test('the registry file of a killed process gives one exit record with its content, a live or cleanly exited process none', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const killed = await startProcess(sandbox)
  const clean = await startProcess(sandbox)
  const killedContent = entry(killed.pid, 'session-killed')
  const killedPath = await register(sandbox, `${String(killed.pid)}.json`, killedContent)
  const cleanPath = await register(sandbox, `${String(clean.pid)}.json`, entry(clean.pid, 'session-clean'))
  const ide = await register(sandbox, 'ide.json', JSON.stringify({ pid: 1 }))
  const running = runCollector(sandbox, { processCheckIntervalMs })
  await vi.waitFor(() => {
    expect(snapshotsOf(running).toSorted()).toEqual([killedPath, cleanPath, ide].toSorted())
  })
  await sleep(processCheckIntervalMs * 4)
  expect(exits(running)).toEqual([])

  await rm(cleanPath)
  await stopProcess(clean.child, 'SIGTERM')
  const killedAt = BigInt(Date.now()) * 1_000_000n
  await stopProcess(killed.child, 'SIGKILL')
  await vi.waitFor(() => {
    expect(exits(running)).toHaveLength(1)
  })
  await sleep(processCheckIntervalMs * 10)

  expect(exits(running)).toEqual([
    {
      channel: 'registry',
      runtime: 'claude',
      stream: null,
      position: { kind: 'process_exited', path: killedPath, pid: killed.pid, content_hash: sha256(killedContent) },
      hook: null,
      observed_at: expect.any(BigInt) as CollectedRecord['observed_at'],
      payload: killedContent,
    },
  ])
  expect(exits(running)[0]?.observed_at).toBeGreaterThanOrEqual(killedAt)
  expect(running.gaps()).toEqual([])
})

test('a restarted collector finds the exited process of a remaining registry file again under the same key', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const solver = await startProcess(sandbox)
  await register(sandbox, `${String(solver.pid)}.json`, entry(solver.pid, 'session-restarted'))
  await stopProcess(solver.child, 'SIGKILL')
  const first = runCollector(sandbox, { processCheckIntervalMs })
  await vi.waitFor(() => {
    expect(exits(first)).toHaveLength(1)
  })
  await first.close()

  const second = runCollector(sandbox, { processCheckIntervalMs })
  await vi.waitFor(() => {
    expect(exits(second)).toHaveLength(1)
  })

  const [before] = exits(first)
  const [after] = exits(second)
  expect(after?.position).toEqual(before?.position)
  expect(after === undefined ? null : claudeAdapter.rawKey(after)).toBe(before === undefined ? null : claudeAdapter.rawKey(before))
})

test('the registry file of an exited process that cannot be read is a read_failed gap, and the exit is found once it can', async ({
  onTestFinished,
}) => {
  const sandbox = await createSandbox(onTestFinished)
  const solver = await startProcess(sandbox)
  const content = entry(solver.pid, 'session-unreadable')
  const path = await register(sandbox, `${String(solver.pid)}.json`, content)
  const running = runCollector(sandbox, {
    fsWatch: false,
    rootsScanIntervalMs: 50,
    processCheckIntervalMs,
    readRetry: { pauseMs: 50, gapAfterMs: 300 },
  })
  await vi.waitFor(() => {
    expect(snapshotsOf(running)).toEqual([path])
  })
  const release = await holdExclusively(sandbox, path)

  await stopProcess(solver.child, 'SIGKILL')

  await vi.waitFor(
    () => {
      expect(running.gaps()).toHaveLength(1)
    },
    { timeout: 10_000 },
  )
  const [opened] = running.gaps()
  expect(opened).toMatchObject({ key: { kind: 'gap', gap: 'read_failed', subject: path }, stream: null, closed_at: null })
  expect(exits(running)).toEqual([])

  await release()

  await vi.waitFor(
    () => {
      expect(exits(running)).toHaveLength(1)
    },
    { timeout: 10_000 },
  )
  expect(exits(running)[0]).toMatchObject({ position: { kind: 'process_exited', path, pid: solver.pid }, payload: content })
  expect(running.gaps()).toHaveLength(2)
  expect(running.gaps()[1]).toMatchObject({ key: opened?.key, detected_at: opened?.detected_at })
  expect(running.gaps()[1]?.closed_at ?? 0n).toBeGreaterThanOrEqual(opened?.detected_at ?? 0n)
})
