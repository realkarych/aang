import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, test } from 'vitest'
import { createSandbox } from './sandbox.js'

describe.concurrent('aang watch, unwatch and prune talk to the running daemon', () => {
  test('a relative directory is watched and unwatched, and prune reports what it removed', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    const project = join(dirname(sandbox.aangHome), 'project')
    await mkdir(project)
    expect((await sandbox.aang('start')).code).toBe(0)

    const watched = await sandbox.aang('watch', 'project', '--lookback', '30d')
    const again = await sandbox.aang('watch', project)
    const unwatched = await sandbox.aang('unwatch', 'project')
    const notWatched = await sandbox.aang('unwatch', 'project')
    const nothing = await sandbox.aang('prune', '--before', '2020-01-01')
    const unknown = await sandbox.aang('prune', '--run', '0'.repeat(32))
    expect((await sandbox.aang('stop')).code).toBe(0)

    expect(watched).toEqual({
      code: 0,
      stdout: `watching: 1 root\n  ${project}\nlookback: 7 days\nstreams to reread: 0\n`,
      stderr: '',
    })
    expect(again.stdout).toContain('watching: 1 root\n')
    expect(unwatched).toEqual({ code: 0, stdout: 'watching: 0 roots\nlookback: 7 days\n', stderr: '' })
    expect(notWatched.code).toBe(1)
    expect(notWatched.stderr).toContain(`aang unwatch: ${project} is not a watched root`)
    expect(nothing).toEqual({ code: 0, stdout: 'no runs to prune\n', stderr: '' })
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain(`aang prune: no run ${'0'.repeat(32)}`)
  })

  test('the commands refuse to run without a daemon', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.aang('watch', '--all')

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('aang watch: aang is not running; start it with `aang start`')
  })

  test.for([
    { args: ['watch'], message: 'aang watch takes one directory or --all' },
    { args: ['watch', 'a', 'b'], message: 'aang watch takes one directory or --all' },
    { args: ['watch', 'a', '--all'], message: 'aang watch takes one directory or --all' },
    { args: ['watch', 'a', '--lookback', '0'], message: "--lookback takes a positive number of days, got '0'" },
    { args: ['unwatch'], message: 'aang unwatch takes one directory or --all' },
    { args: ['prune'], message: 'aang prune takes --run <id> or --before <date>' },
    { args: ['prune', '--run', 'r', '--before', '2020-01-01'], message: 'aang prune takes --run <id> or --before <date>' },
    { args: ['prune', '--run', 'not-a-run'], message: "'not-a-run' is not a run id" },
    { args: ['prune', '--before', 'yesterday'], message: "'yesterday' is not a date" },
  ])('aang $args is a usage error', async ({ args, message }, { expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.aang(...args)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
  })
})
