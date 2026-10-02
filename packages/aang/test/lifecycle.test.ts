import { chmod, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { isAlive, kill, resume, sleep, suspend, waitUntil } from './processes.js'
import { createSandbox, type SpoolView, startedPid } from './sandbox.js'

const posix = process.platform !== 'win32'
const permissionsRestrict = posix && process.getuid?.() !== 0

describe.concurrent('aang start, stop and status manage one daemon per AANG_HOME', () => {
  test('start runs a daemon on loopback that holds a spool lease, and a second start is refused', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)

    const started = await sandbox.aang('start')

    expect(started.code).toBe(0)
    expect(started.stdout).toMatch(/^aang started: pid [0-9]+, http:\/\/127\.0\.0\.1:[0-9]+$/m)
    const state = await sandbox.daemonState()
    expect(state).toMatchObject({ pid: startedPid(started), api: { host: '127.0.0.1' } })
    expect(await sandbox.hookWrites()).toBe(true)
    if (posix) {
      expect((await stat(sandbox.aangHome)).mode & 0o777).toBe(0o700)
      expect((await stat(join(sandbox.aangHome, 'token'))).mode & 0o777).toBe(0o600)
    }

    const second = await sandbox.aang('start')

    expect(second.code).toBe(1)
    expect(second.stderr).toContain(`an aang daemon is already running for ${sandbox.aangHome}`)
    expect(await sandbox.daemonState()).toEqual(state)
    expect(isAlive(startedPid(started))).toBe(true)
    expect(await sandbox.hookWrites()).toBe(true)

    const foreground = await sandbox.aang('start', '--foreground')

    expect(foreground.code).toBe(1)
    expect(foreground.stderr).toContain('an aang daemon is already running')
    expect(await sandbox.daemonState()).toEqual(state)
  })

  test('a relative AANG_HOME names the same home for start, status, open and stop', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished, { spool: { leaseTtlMs: 600_000 } }, { relativeHome: true })

    const started = await sandbox.aang('start')

    expect(started.code).toBe(0)
    const pid = startedPid(started)
    sandbox.track(pid)
    expect(await sandbox.daemonState()).toMatchObject({ pid })
    const view = await sandbox.spoolView()
    expect(await sandbox.hookWrites()).toBe(true)
    expect(Math.max(...view.leaseExpiries) * 1000).toBeLessThanOrEqual(Date.now() + 600_000)
    const status = await sandbox.aang('status')
    expect(status.stdout).toContain(`aang home: ${sandbox.aangHome}\n`)
    expect(status.stdout).toContain(`daemon: running, pid ${String(pid)}, `)
    const link = (await sandbox.aang('open')).stdout.trim()
    expect((await fetch(link, { redirect: 'manual' })).status).toBe(200)

    expect(await sandbox.aang('stop')).toMatchObject({ code: 0, stdout: `aang stopped: pid ${String(pid)}\n` })
    expect(isAlive(pid)).toBe(false)
    expect(await readdir(sandbox.aangHome)).not.toContain('aang home')
  })

  test('stop shuts the daemon down through the API, removes the lease, keeps the stop marker, and the next start lifts it', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const pid = startedPid(await sandbox.aang('start'))

    const stopped = await sandbox.aang('stop')

    expect(stopped).toMatchObject({ code: 0, stdout: `aang stopped: pid ${String(pid)}\n` })
    expect(isAlive(pid)).toBe(false)
    expect(await sandbox.daemonState()).toBeNull()
    expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: true })
    expect(await sandbox.hookWrites()).toBe(false)
    const status = await sandbox.aang('status')
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('daemon: not running\n')
    expect(status.stdout).toContain('lease: none\n')
    expect(status.stdout).toContain('stop marker: set\n')

    const restarted = await sandbox.aang('start')

    expect(restarted.code).toBe(0)
    expect((await sandbox.spoolView()).stopped).toBe(false)
    expect(await sandbox.hookWrites()).toBe(true)
    expect((await sandbox.aang('status')).stdout).toMatch(/^stop marker: not set$/m)
    expect(await sandbox.aang('stop')).toMatchObject({ code: 0 })
  })

  test('stop after the daemon was killed removes the lease itself and reports that nothing is running', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const pid = startedPid(await sandbox.aang('start'))
    kill(pid)
    await waitUntil(() => !isAlive(pid))
    expect(await sandbox.hookWrites()).toBe(true)

    const stopped = await sandbox.aang('stop')

    expect(stopped.code).toBe(0)
    expect(stopped.stdout).toContain('aang is not running; the spool lease is removed and the stop marker is set')
    expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: true })
    expect(await sandbox.hookWrites()).toBe(false)
    expect(await sandbox.daemonState()).toBeNull()
  })

  test('a running daemon renews its short lease, and after the daemon is killed the lease runs out', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished, { spool: { leaseTtlMs: 2_000, leaseRenewIntervalMs: 300 } })
    const pid = startedPid(await sandbox.aang('start'))
    const renewedUntil = Date.now() + 3_500
    while (Date.now() < renewedUntil) {
      expect(await sandbox.hookWrites()).toBe(true)
      await sleep(100)
    }

    kill(pid)
    await waitUntil(() => !isAlive(pid))
    const killedAt = Date.now()
    const leftover = await sandbox.spoolView()

    expect(await sandbox.hookWrites()).toBe(true)
    expect(Math.max(...leftover.leaseExpiries) * 1000).toBeLessThanOrEqual(killedAt + 2_000)
    await waitUntil(async () => !(await sandbox.hookWrites()), 5_000)
    expect(await sandbox.hookWrites()).toBe(false)
    expect(await sandbox.spoolView()).toMatchObject({ stopped: false })
  })

  test(
    'a suspended daemon: stop removes the lease without confirming the stop, start is refused, and the resumed daemon exits without a lease',
    { timeout: 120_000 },
    async ({ expect, onTestFinished }) => {
      const sandbox = await createSandbox(onTestFinished, {
        spool: { checkIntervalMs: 200, leaseRenewIntervalMs: 300 },
      })
      const pid = startedPid(await sandbox.aang('start'))
      await suspend(pid)

      const stopped = await sandbox.aang('stop')

      expect(stopped.code).toBe(1)
      expect(stopped.stderr).toContain(`process ${String(pid)} is alive`)
      expect(stopped.stderr).toContain('the stop is not confirmed')
      expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: true })
      expect(await sandbox.hookWrites()).toBe(false)

      const refused = await sandbox.aang('start')

      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('already running')
      expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: true })

      await resume(pid)
      const observed: SpoolView[] = []
      while (isAlive(pid)) {
        observed.push(await sandbox.spoolView())
        await sleep(20)
      }

      expect(observed.filter((view) => view.leaseExpiries.length > 0 || !view.stopped)).toEqual([])
      expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: true })
      expect(await sandbox.hookWrites()).toBe(false)
      expect(await sandbox.daemonState()).toBeNull()

      const restarted = await sandbox.aang('start')

      expect(restarted.code).toBe(0)
      expect((await sandbox.spoolView()).stopped).toBe(false)
      expect(await sandbox.hookWrites()).toBe(true)
      expect(await sandbox.aang('stop')).toMatchObject({ code: 0 })
    },
  )

  test('over the spool threshold the lease is revoked, status shows the volume and the growth, and draining restores the lease', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished, { spool: { thresholdBytes: 1_000, checkIntervalMs: 100 } })
    await sandbox.aang('start')
    const ready = join(sandbox.spool, 'new')
    await writeFile(join(ready, 'first-event'), 'x'.repeat(1_500))

    await waitUntil(async () => ((await sandbox.daemonState())?.spool_over_threshold ?? null) !== null)

    expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: false })
    expect(await sandbox.hookWrites()).toBe(false)
    await writeFile(join(ready, 'second-event'), 'y'.repeat(300))
    const status = await sandbox.aang('status')
    expect(status.stdout).toContain('spool: 2 files, 1800 bytes\n')
    expect(status.stdout).toContain('lease: none\n')
    expect(status.stdout).toContain('threshold: 1000 bytes\n')
    expect(status.stdout).toMatch(/^over threshold since \S+: 1500 bytes at detection, 300 bytes of growth since$/m)

    await unlink(join(ready, 'first-event'))
    await unlink(join(ready, 'second-event'))

    await waitUntil(() => sandbox.hookWrites())
    expect((await sandbox.daemonState())?.spool_over_threshold).toBeNull()
    expect((await sandbox.aang('status')).stdout).not.toContain('over threshold since')
    expect(await sandbox.aang('stop')).toMatchObject({ code: 0 })
  })

  test.runIf(permissionsRestrict)(
    'a daemon that cannot remove its lease while stopping still closes its API and exits',
    async ({ expect, onTestFinished }) => {
      const sandbox = await createSandbox(onTestFinished)
      const pid = startedPid(await sandbox.aang('start'))
      const state = await sandbox.daemonState()
      if (state === null) {
        throw new Error('aang start left no daemon state')
      }
      await chmod(sandbox.spool, 0o500)
      try {
        process.kill(pid, 'SIGTERM')
        await waitUntil(() => !isAlive(pid))
      } finally {
        await chmod(sandbox.spool, 0o700)
      }

      await expect(fetch(`http://127.0.0.1:${String(state.api.port)}/api/x`)).rejects.toThrow()
      expect(await sandbox.daemonState()).toBeNull()
      expect(await readFile(join(sandbox.aangHome, 'daemon.log'), 'utf8')).toContain('EACCES')
      const restarted = await sandbox.aang('start')
      expect(restarted.code).toBe(0)
      expect(await sandbox.aang('stop')).toMatchObject({ code: 0 })
    },
  )

  test('a broken config fails start, while status and stop still work', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)
    await writeFile(join(sandbox.aangHome, 'config.json'), '{"spool": {"thresholdBytes": "big"}}')

    const started = await sandbox.aang('start')

    expect(started.code).toBe(1)
    expect(started.stderr).toContain('config.json')
    expect(await sandbox.daemonState()).toBeNull()
    const status = await sandbox.aang('status')
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('threshold: unknown, the config is invalid\n')
    await writeFile(join(sandbox.aangHome, 'daemon.json'), 'not json')
    const stopped = await sandbox.aang('stop')
    expect(stopped.code).toBe(0)
    expect(stopped.stderr).toContain('ignoring unreadable')
    expect(stopped.stdout).toContain('aang is not running')
    expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: true })
  })

  test('without the UI token stop cannot reach the API, and the daemon still exits on the stop marker', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished, { spool: { checkIntervalMs: 1_000 } })
    const pid = startedPid(await sandbox.aang('start'))
    await unlink(join(sandbox.aangHome, 'token'))

    const stopped = await sandbox.aang('stop')

    expect(stopped.code).toBe(0)
    expect(stopped.stderr).toContain('no UI token')
    expect(stopped.stdout).toBe(`aang stopped: pid ${String(pid)} exited after the stop marker\n`)
    expect(isAlive(pid)).toBe(false)
    expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: true })
    expect(await sandbox.hookWrites()).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'Ctrl+C stops a foreground daemon and removes its lease',
    async ({ expect, onTestFinished }) => {
      const sandbox = await createSandbox(onTestFinished)
      const foreground = sandbox.spawnAang('start', '--foreground')
      let stdout = ''
      foreground.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      const exited = new Promise<number | null>((resolve) => {
        foreground.on('close', resolve)
      })
      await waitUntil(() => stdout.includes('aang running in the foreground'))

      foreground.kill('SIGINT')

      expect(await exited).toBe(0)
      expect(stdout).toContain('aang stopped: signal\n')
      expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: false })
      expect(await sandbox.hookWrites()).toBe(false)
      expect(await sandbox.daemonState()).toBeNull()
    },
  )

  test('start --foreground runs the daemon in the CLI process until aang stop', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const foreground = sandbox.spawnAang('start', '--foreground')
    let stdout = ''
    foreground.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    const exited = new Promise<number | null>((resolve) => {
      foreground.on('close', resolve)
    })
    await waitUntil(() => stdout.includes('aang running in the foreground: pid '))
    expect(stdout).toContain(`pid ${String(foreground.pid)}, http://127.0.0.1:`)
    expect(await sandbox.hookWrites()).toBe(true)

    const stopped = await sandbox.aang('stop')

    expect(stopped.code).toBe(0)
    expect(await exited).toBe(0)
    expect(stdout).toContain('aang stopped: shutdown\n')
    expect(await sandbox.spoolView()).toEqual({ leaseExpiries: [], stopped: true })
    expect(await sandbox.hookWrites()).toBe(false)
  })
})
