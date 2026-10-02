import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EpochNs } from '@aang/contract'
import {
  aangHomePaths,
  type DaemonState,
  leaseFileName,
  readDaemonState,
  readSpoolState,
  readUiToken,
  revokeLeases,
  writeDaemonState,
} from '@aang/contract/home'
import { describe, test, type TestContext } from 'vitest'

const temporaryAangHome = async (onTestFinished: TestContext['onTestFinished']): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'aang-home-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return join(root, '.aang')
}

const place = async (path: string, content = ''): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

describe.concurrent('files shared by the CLI and the daemon in AANG_HOME', () => {
  test('a spool that does not exist yet has no queue, no lease and no stop marker', async ({
    expect,
    onTestFinished,
  }) => {
    const paths = aangHomePaths(await temporaryAangHome(onTestFinished))

    expect(await readSpoolState(paths.spool)).toEqual({ files: 0, bytes: 0, leaseExpiresAt: null, stopped: false })
  })

  test('the spool state counts ready and partial files, takes the latest lease and sees the stop marker', async ({
    expect,
    onTestFinished,
  }) => {
    const paths = aangHomePaths(await temporaryAangHome(onTestFinished))
    await place(join(paths.spoolReady, 'first'), 'abc')
    await place(join(paths.spoolReady, 'second'), 'abcde')
    await place(join(paths.spoolTemporary, 'partial'), 'ab')
    await mkdir(join(paths.spoolReady, 'nested'))
    for (const name of [leaseFileName(1_900_000_000), leaseFileName(1_900_003_600), 'lease-', 'lease-01', 'lease-x']) {
      await place(join(paths.spool, name))
    }
    await place(paths.stoppedMarker)

    expect(await readSpoolState(paths.spool)).toEqual({
      files: 3,
      bytes: 10,
      leaseExpiresAt: EpochNs.parse(1_900_003_600_000_000_000n),
      stopped: true,
    })
  })

  test('revoking leases removes every lease and keeps the marker and the queue', async ({
    expect,
    onTestFinished,
  }) => {
    const paths = aangHomePaths(await temporaryAangHome(onTestFinished))
    await place(join(paths.spool, leaseFileName(1_900_000_000)))
    await place(join(paths.spool, leaseFileName(1_900_003_600)))
    await place(join(paths.spool, 'lease-x'))
    await place(join(paths.spoolReady, 'event'), 'payload')
    await place(paths.stoppedMarker)

    await revokeLeases(paths.spool)

    expect((await readdir(paths.spool)).sort()).toEqual(['lease-x', 'new', 'stopped'])
    expect(await readSpoolState(paths.spool)).toMatchObject({ files: 1, leaseExpiresAt: null, stopped: true })
  })

  test('revoking leases of a spool that does not exist succeeds', async ({ expect, onTestFinished }) => {
    const paths = aangHomePaths(await temporaryAangHome(onTestFinished))

    await expect(revokeLeases(paths.spool)).resolves.toBeUndefined()
  })

  test('the daemon state file round-trips nanosecond timestamps and replaces the previous state', async ({
    expect,
    onTestFinished,
  }) => {
    const paths = aangHomePaths(await temporaryAangHome(onTestFinished))
    await mkdir(paths.home, { recursive: true })
    const started: DaemonState = {
      pid: 4242,
      started_at: EpochNs.parse(1_900_000_000_123_456_789n),
      api: { host: '127.0.0.1', port: 4280 },
      spool_over_threshold: null,
    }
    const overThreshold: DaemonState = {
      ...started,
      spool_over_threshold: { detected_at: EpochNs.parse(1_900_000_060_987_654_321n), bytes: 1_073_741_825 },
    }

    expect(await readDaemonState(paths.daemonState)).toBeNull()
    await writeDaemonState(paths.daemonState, started)
    await writeDaemonState(paths.daemonState, overThreshold)

    expect(await readDaemonState(paths.daemonState)).toEqual(overThreshold)
    expect(await readdir(paths.home)).toEqual(['daemon.json'])
  })

  test('a malformed daemon state file is an error, not an absent daemon', async ({ expect, onTestFinished }) => {
    const paths = aangHomePaths(await temporaryAangHome(onTestFinished))
    await place(paths.daemonState, '{"pid": 0}')

    await expect(readDaemonState(paths.daemonState)).rejects.toThrow()
  })

  test('the UI token file is read without its line ending and rejected when malformed', async ({
    expect,
    onTestFinished,
  }) => {
    const paths = aangHomePaths(await temporaryAangHome(onTestFinished))
    const token = randomBytes(32).toString('base64url')

    expect(await readUiToken(paths.uiToken)).toBeNull()
    await place(paths.uiToken, `${token}\r\n`)
    expect(await readUiToken(paths.uiToken)).toBe(token)
    await place(paths.uiToken, 'short')
    await expect(readUiToken(paths.uiToken)).rejects.toThrow()
  })
})
