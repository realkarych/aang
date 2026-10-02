import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChangeSeq, type Gap } from '@aang/contract'
import { type DaemonState, readDaemonState, readSpoolState } from '@aang/contract/home'
import { openStore } from '@aang/store'
import { describe, type TestContext, test } from 'vitest'
import { createHome, type Home, spawnDaemon, startDaemon } from './daemon.js'

const waitUntil = async (condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const leaseIsValid = async (home: Home): Promise<boolean> => {
  const { leaseExpiresAt } = await readSpoolState(home.paths.spool)
  return leaseExpiresAt !== null && leaseExpiresAt > BigInt(Date.now()) * 1_000_000n
}

const queueEvent = async (home: Home, name: string, bytes: number): Promise<string> => {
  const file = join(home.paths.spoolReady, name)
  await mkdir(home.paths.spoolReady, { recursive: true })
  await writeFile(file, 'x'.repeat(bytes))
  return file
}

const thresholdConfig = { spool: { thresholdBytes: 1_000, checkIntervalMs: 50 } }

const recordedGaps = (home: Home, onTestFinished: TestContext['onTestFinished']): Gap[] => {
  const store = openStore({ home: home.paths.home })
  onTestFinished(() => {
    store.close()
  })
  return store.changes
    .after(ChangeSeq.parse(0), 100)
    .flatMap((change) => (change.layer === 'gap' ? [change.gap] : []))
}

const overThreshold = async (home: Home): Promise<DaemonState['spool_over_threshold']> =>
  (await readDaemonState(home.paths.daemonState))?.spool_over_threshold ?? null

describe.concurrent('the daemon keeps the spool lease only while the queue is under the threshold and no stop is requested', () => {
  test('over the threshold the lease is revoked with a gap; the drained queue restores the lease and closes the gap', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished, thresholdConfig)
    const daemon = await startDaemon(home, onTestFinished)
    expect(await leaseIsValid(home)).toBe(true)
    expect((await readDaemonState(home.paths.daemonState))?.spool_over_threshold).toBeNull()

    const event = await queueEvent(home, 'event', 1_500)

    await waitUntil(async () => ((await readDaemonState(home.paths.daemonState))?.spool_over_threshold ?? null) !== null)
    expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).toBeNull()
    expect((await readDaemonState(home.paths.daemonState))?.spool_over_threshold).toMatchObject({ bytes: 1_500 })

    await unlink(event)

    await waitUntil(() => leaseIsValid(home))
    expect((await readDaemonState(home.paths.daemonState))?.spool_over_threshold).toBeNull()
    daemon.abort()
    await daemon.stopped
    const gaps = recordedGaps(home, onTestFinished)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ kind: 'spool_over_threshold', run: null, session: null, stream: null })
    expect(gaps[0]?.details).toContain('1500 bytes, over the 1000-byte threshold')
    expect(gaps[0]?.closed_at).not.toBeNull()
  })

  test('a daemon started over the threshold grants no lease until the queue is drained', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished, thresholdConfig)
    const event = await queueEvent(home, 'event', 1_500)

    await startDaemon(home, onTestFinished)

    expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).toBeNull()
    expect((await readDaemonState(home.paths.daemonState))?.spool_over_threshold).toMatchObject({ bytes: 1_500 })
    await unlink(event)
    await waitUntil(() => leaseIsValid(home))
  })

  test('stopping the daemon while the spool is over the threshold closes the gap of that episode', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished, thresholdConfig)
    await queueEvent(home, 'event', 1_500)
    const daemon = await startDaemon(home, onTestFinished)
    expect((await readDaemonState(home.paths.daemonState))?.spool_over_threshold).toMatchObject({ bytes: 1_500 })

    daemon.abort()
    await daemon.stopped

    const gaps = recordedGaps(home, onTestFinished)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.closed_at).not.toBeNull()
    expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).toBeNull()
  })

  test('a daemon restarted after SIGKILL over the threshold continues the same episode and closes it once the queue drains', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished, thresholdConfig)
    const event = await queueEvent(home, 'event', 1_500)
    const crashed = await spawnDaemon(home, onTestFinished)
    const episode = await overThreshold(home)
    expect(episode).toMatchObject({ bytes: 1_500 })
    await crashed.kill()

    const restarted = await spawnDaemon(home, onTestFinished)

    expect(await overThreshold(home)).toEqual(episode)
    expect((await readSpoolState(home.paths.spool)).leaseExpiresAt).toBeNull()
    await unlink(event)
    await waitUntil(() => leaseIsValid(home))
    expect(await restarted.shutdown()).toBe(0)
    const gaps = recordedGaps(home, onTestFinished)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ kind: 'spool_over_threshold', detected_at: episode?.detected_at })
    expect(gaps[0]?.closed_at).not.toBeNull()
  })

  test('a daemon restarted after SIGKILL with the queue already drained closes the open episode and grants the lease', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished, thresholdConfig)
    const event = await queueEvent(home, 'event', 1_500)
    const crashed = await spawnDaemon(home, onTestFinished)
    const episode = await overThreshold(home)
    expect(episode).not.toBeNull()
    await crashed.kill()
    await unlink(event)

    const restarted = await spawnDaemon(home, onTestFinished)

    expect(await leaseIsValid(home)).toBe(true)
    expect(await overThreshold(home)).toBeNull()
    expect(await restarted.shutdown()).toBe(0)
    const gaps = recordedGaps(home, onTestFinished)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ kind: 'spool_over_threshold', detected_at: episode?.detected_at })
    expect(gaps[0]?.closed_at).not.toBeNull()
  })

  test('a stop marker that appears while the daemon runs revokes the lease and stops the daemon', async ({
    expect,
    onTestFinished,
  }) => {
    const home = await createHome(onTestFinished, { spool: { checkIntervalMs: 60_000, leaseRenewIntervalMs: 50 } })
    const daemon = await startDaemon(home, onTestFinished)
    expect(await leaseIsValid(home)).toBe(true)

    await writeFile(home.paths.stoppedMarker, '')

    expect(await daemon.stopped).toBe('stop_marker')
    expect(await readSpoolState(home.paths.spool)).toMatchObject({ leaseExpiresAt: null, stopped: true })
    expect(await readDaemonState(home.paths.daemonState)).toBeNull()
  })

  test('a stop marker left from an earlier stop is lifted when the daemon starts', async ({ expect, onTestFinished }) => {
    const home = await createHome(onTestFinished)
    await mkdir(home.paths.spool, { recursive: true })
    await writeFile(home.paths.stoppedMarker, '')

    await startDaemon(home, onTestFinished)

    expect((await readSpoolState(home.paths.spool)).stopped).toBe(false)
    expect(await leaseIsValid(home)).toBe(true)
  })
})
