import { describe, test } from 'vitest'
import { createSandbox } from './sandbox.js'

describe.concurrent('aang rejects malformed command lines with usage', () => {
  test.for([
    { args: [], message: 'a command is required' },
    { args: ['launch'], message: "unknown command 'launch'" },
    { args: ['stop', 'now'], message: 'aang stop takes no arguments' },
    { args: ['start', 'now'], message: 'aang start takes no positional arguments' },
    { args: ['start', '--port', '1'], message: "Unknown option '--port'" },
    { args: ['token'], message: 'usage: aang token rotate' },
  ])('aang $args', async ({ args, message }, { expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.aang(...args)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(message)
    expect(result.stderr).toContain('usage: aang <command>')
    expect(await sandbox.daemonState()).toBeNull()
  })

  test('aang help prints the commands', async ({ expect, onTestFinished }) => {
    const sandbox = await createSandbox(onTestFinished)

    const result = await sandbox.aang('help')

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('start [--foreground] [--bind <address>]')
  })
})
