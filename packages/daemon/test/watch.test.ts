import { appendFile, mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { objectId } from '@aang/contract/ids'
import { describe, test } from 'vitest'
import { type Home, spawnDaemon } from './daemon.js'
import {
  admin,
  claudeSession,
  claudeStream,
  claudeTranscript,
  daysAgo,
  openFinished,
  rawRecords,
  sleep,
  storedCount,
  transcriptLines,
  waitUntil,
  watchedHome,
} from './sessions.js'

const cursors = 'SELECT count(*) AS count FROM cursors WHERE stream IS NOT NULL'

const streamRecords = 'SELECT count(*) AS count FROM raw_records WHERE stream = ?'

const recordsOf = (home: Home, session: string): number => storedCount(home, streamRecords, claudeStream(session))

describe.concurrent('aang watch and unwatch change which sessions the daemon takes', () => {
  test(
    'after watch the discarded files of the project within the lookback are reread despite their cursors, older ones are not, and the roots are kept in the store without rewriting the config',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const project = join(home.root, 'project')
      await mkdir(project)
      const fresh = 'g9-fresh'
      const stale = 'g9-stale'
      await claudeTranscript(home, '-project', fresh, transcriptLines(fresh, project, 22))
      const stalePath = await claudeTranscript(home, '-project', stale, transcriptLines(stale, project, 22))
      const config = await readFile(join(home.paths.home, 'config.json'), 'utf8')
      const first = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, cursors) === 2)
      expect(await first.shutdown()).toBe(0)
      const before = openFinished(home, onTestFinished)
      const discarded = {
        records: rawRecords(before).length,
        fresh: before.scopes.ofSession(claudeSession(fresh))?.scope,
        stale: before.scopes.ofSession(claudeSession(stale))?.scope,
      }
      before.close()
      expect(discarded).toEqual({ records: 0, fresh: 'external', stale: 'external' })
      await utimes(stalePath, daysAgo(10), daysAgo(10))

      const second = await spawnDaemon(home, onTestFinished)
      const watched = await admin(home, second.base, 'watch', { scope: 'path', path: project, lookback_days: null })
      await waitUntil(() => recordsOf(home, fresh) === 22)
      await sleep(500)
      expect(await second.shutdown()).toBe(0)

      expect(watched).toEqual({
        status: 200,
        body: { watch: { all: false, lookback_days: 7, roots: [workspace, project] }, rescanned_streams: 2 },
      })
      const store = openFinished(home, onTestFinished)
      expect(store.observations.getSession(objectId(claudeSession(fresh)))).toMatchObject({ cwd: project })
      expect(store.observations.getSession(objectId(claudeSession(stale)))).toBeNull()
      expect(store.scopes.ofSession(claudeSession(stale))?.scope).toBe('watched')
      expect(rawRecords(store).map(({ stream }) => stream)).toEqual(Array(22).fill(claudeStream(fresh)))
      expect(store.settings.get('watch')).toEqual({ all: false, lookback_days: 7, roots: [workspace, project] })
      expect(await readFile(join(home.paths.home, 'config.json'), 'utf8')).toBe(config)
    },
  )

  test(
    'watch with a longer lookback reads the files that the general lookback skipped, only for this reread',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const project = join(home.root, 'project')
      await mkdir(project)
      const older = 'g9-older'
      const oldest = 'g9-oldest'
      const olderPath = await claudeTranscript(home, '-project', older, transcriptLines(older, project, 22))
      const oldestPath = await claudeTranscript(home, '-project', oldest, transcriptLines(oldest, project, 22))
      await utimes(olderPath, daysAgo(20), daysAgo(20))
      await utimes(oldestPath, daysAgo(40), daysAgo(40))
      const ready = 'g9-ready'
      await claudeTranscript(home, '-work', ready, transcriptLines(ready, workspace, 22))
      const daemon = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => recordsOf(home, ready) === 22)

      const watched = await admin(home, daemon.base, 'watch', { scope: 'path', path: project, lookback_days: 30 })
      await waitUntil(() => recordsOf(home, older) === 22)
      await sleep(500)
      expect(await daemon.shutdown()).toBe(0)

      expect(watched).toMatchObject({ status: 200, body: { watch: { lookback_days: 7, roots: [workspace, project] } } })
      const store = openFinished(home, onTestFinished)
      expect(store.observations.getSession(objectId(claudeSession(older)))).toMatchObject({ cwd: project })
      expect(store.observations.getSession(objectId(claudeSession(oldest)))).toBeNull()
      expect(store.settings.get('watch')).toMatchObject({ lookback_days: 7 })
    },
  )

  test(
    'watch --all takes every session; unwatch of a root and unwatch --all stop taking new records and keep what was taken',
    { timeout: 60_000 },
    async ({ expect, onTestFinished }) => {
      const { home, workspace } = await watchedHome(onTestFinished)
      const elsewhere = join(home.root, 'elsewhere')
      await mkdir(elsewhere)
      const inside = 'g9-inside'
      const outside = 'g9-outside'
      const witness = 'g9-witness'
      const lines = (session: string, cwd: string): string[] => transcriptLines(session, cwd, 24)
      const insidePath = await claudeTranscript(home, '-work', inside, lines(inside, workspace).slice(0, 22))
      const outsidePath = await claudeTranscript(home, '-elsewhere', outside, lines(outside, elsewhere).slice(0, 22))
      const witnessPath = await claudeTranscript(home, '-elsewhere', witness, lines(witness, elsewhere).slice(0, 22))
      const daemon = await spawnDaemon(home, onTestFinished)
      await waitUntil(() => storedCount(home, cursors) === 3)

      const all = await admin(home, daemon.base, 'watch', { scope: 'all', lookback_days: null })
      await waitUntil(
        () => recordsOf(home, outside) === 22 && recordsOf(home, witness) === 22,
      )
      const root = await admin(home, daemon.base, 'unwatch', { scope: 'path', path: workspace })
      const allOff = await admin(home, daemon.base, 'unwatch', { scope: 'all' })
      const kept = await admin(home, daemon.base, 'watch', { scope: 'path', path: elsewhere, lookback_days: null })
      await appendFile(insidePath, `${lines(inside, workspace).slice(22).join('\n')}\n`)
      await appendFile(outsidePath, `${lines(outside, elsewhere).slice(22).join('\n')}\n`)
      await appendFile(witnessPath, `${lines(witness, elsewhere).slice(22).join('\n')}\n`)
      await waitUntil(() => recordsOf(home, witness) === 24)
      await sleep(300)
      expect(await daemon.shutdown()).toBe(0)

      expect(all).toMatchObject({ status: 200, body: { watch: { all: true, roots: [workspace] } } })
      expect(root).toEqual({ status: 200, body: { watch: { all: true, lookback_days: 7, roots: [] } } })
      expect(allOff).toEqual({ status: 200, body: { watch: { all: false, lookback_days: 7, roots: [] } } })
      expect(kept).toMatchObject({ status: 200, body: { watch: { all: false, roots: [elsewhere] } } })
      const store = openFinished(home, onTestFinished)
      const counts = Object.fromEntries(
        [inside, outside, witness].map((session) => [
          session,
          rawRecords(store).filter(({ stream }) => stream === claudeStream(session)).length,
        ]),
      )
      expect(counts).toEqual({ [inside]: 22, [outside]: 24, [witness]: 24 })
      expect(store.scopes.ofSession(claudeSession(inside))?.scope).toBe('external')
      expect(store.observations.getSession(objectId(claudeSession(inside)))).toMatchObject({ cwd: workspace })
    },
  )

  test('watch and unwatch refuse paths that are not absolute directories or not watched', async ({
    expect,
    onTestFinished,
  }) => {
    const { home } = await watchedHome(onTestFinished)
    const file = join(home.root, 'file.txt')
    await writeFile(file, '')
    const daemon = await spawnDaemon(home, onTestFinished)

    const answers = [
      await admin(home, daemon.base, 'watch', { scope: 'path', path: 'relative/project', lookback_days: null }),
      await admin(home, daemon.base, 'watch', { scope: 'path', path: file, lookback_days: null }),
      await admin(home, daemon.base, 'watch', { scope: 'path', path: join(home.root, 'missing'), lookback_days: 0 }),
      await admin(home, daemon.base, 'unwatch', { scope: 'path', path: join(home.root, 'elsewhere') }),
    ]
    expect(await daemon.shutdown()).toBe(0)

    expect(answers.map(({ status, body }) => [status, (body as { error: { code: string } }).error.code])).toEqual([
      [400, 'invalid_request'],
      [400, 'invalid_request'],
      [400, 'invalid_request'],
      [404, 'not_found'],
    ])
    const store = openFinished(home, onTestFinished)
    expect(store.settings.get('watch')).toBeUndefined()
  })
})
