import { describe, test } from 'vitest'
import { createSandbox } from './sandbox.js'

describe.concurrent('catacomb rejects malformed command lines with usage', () => {
  test.for([
    { args: [], message: 'a command is required' },
    { args: ['launch'], message: "unknown command 'launch'" },
    { args: ['stop', 'now'], message: 'catacomb stop takes no arguments' },
    { args: ['start', 'now'], message: 'catacomb start takes no positional arguments' },
    { args: ['start', '--port', '1'], message: "Unknown option '--port'" },
    { args: ['token'], message: 'usage: catacomb token rotate' },
    { args: ['reparse', 'now'], message: 'catacomb reparse takes no arguments' },
  ])('catacomb $args', async ({ args, message }, { expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.catacomb(...args)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
    expect(result.stderr).toContain('usage: catacomb <command>')
    expect(await sandbox.daemonState()).toBeNull()
  })

  test('catacomb help prints the commands', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.catacomb('help')

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('start [--foreground] [--bind <address>]')
  })
})
