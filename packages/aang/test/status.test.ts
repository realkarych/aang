import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { installFakeClaude, installFakeCodex } from '@aang/testkit'
import { describe, test } from 'vitest'
import { createSandbox } from './sandbox.js'

const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const notObservable = 'not observable: claude_cowork, claude_cloud, codex_cloud, work_cloud\n'

describe.concurrent('aang status shows the connection state of the running daemon', () => {
  test('without runtime CLIs the hooks state is unknown, and a stopped daemon shows no connection state', async ({
    expect,
    onTestFinished,
  }) => {
    const sandbox = await createSandbox(onTestFinished)
    expect((await sandbox.aang('start')).code).toBe(0)

    const running = await sandbox.aang('status')
    expect((await sandbox.aang('stop')).code).toBe(0)
    const stopped = await sandbox.aang('status')

    expect(running.code).toBe(0)
    expect(running.stdout).toContain(
      `claude hooks: unknown, the check did not succeed\ncodex hooks: unknown, the check did not succeed\n${notObservable}`,
    )
    expect(stopped.code).toBe(0)
    expect(stopped.stdout).not.toContain('hooks:')
    expect(stopped.stdout).not.toContain('not observable')
  })

  test.skipIf(process.platform === 'win32')(
    'each aang status checks the hooks again, so a trust change outside the watched files shows at once',
    async ({ expect, onTestFinished }) => {
      const sandbox = await createSandbox(onTestFinished)
      const root = dirname(sandbox.aangHome)
      const claude = installFakeClaude(join(root, 'fakes'))
      const codex = installFakeCodex(join(root, 'fakes'))
      const codexHome = join(root, '.codex')
      const command = `${quoted(join(sandbox.aangHome, 'bin', 'aang-hook'))} codex user ${quoted(sandbox.spool)}`
      await mkdir(codexHome, { recursive: true })
      await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }))
      await writeFile(
        join(sandbox.aangHome, 'config.json'),
        JSON.stringify({ cli: { claude: claude.command, codex: codex.command }, api: { port: 0 }, otel: { port: 0 } }),
      )
      expect((await sandbox.aang('start')).code).toBe(0)

      const untrusted = await sandbox.aang('status')
      const checks = codex.calls().filter((call) => call.command === 'app_server').length
      codex.setScenario({ hooks: 'trusted' })
      const trusted = await sandbox.aang('status')
      expect((await sandbox.aang('stop')).code).toBe(0)

      expect(untrusted.stdout).toContain(
        `claude hooks: not installed\ncodex hooks: not trusted; trust them in Codex with /hooks\n${notObservable}`,
      )
      expect(trusted.stdout).toContain(`claude hooks: not installed\ncodex hooks: active\n${notObservable}`)
      expect(codex.calls().filter((call) => call.command === 'app_server')).toHaveLength(checks + 1)
    },
  )
})
