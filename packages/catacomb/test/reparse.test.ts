import { describe, test } from 'vitest'
import { createSandbox } from './sandbox.js'

describe.concurrent('catacomb reparse asks the running daemon to parse the stored records again', () => {
  test('reparse prints the tally of the daemon, and a repeated call prints the same', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await sandbox.catacomb('start')).code).toBe(0)

    const first = await sandbox.catacomb('reparse')
    const again = await sandbox.catacomb('reparse')
    expect((await sandbox.catacomb('stop')).code).toBe(0)

    expect(first).toEqual({
      code: 0,
      stdout: 'records reparsed: 0\nfacts added: 0\nfacts kept: 0\nfacts no longer produced: 0\n',
      stderr: '',
    })
    expect(again).toEqual(first)
  })

  test('reparse refuses to run without a daemon', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.catacomb('reparse')

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('catacomb reparse: catacomb is not running; start it with `catacomb start`')
  })
})
