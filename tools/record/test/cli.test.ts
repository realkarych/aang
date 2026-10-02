import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url))

test('CLI runs an explicit scenario module and verifies the published recording', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'aang-record-cli-'))
  try {
    const scenario = join(temporary, 'scenario.mjs')
    const options = {
      runtime: 'claude', engineVersion: 'test', surface: 'claude_cli', scenario: 'cli',
      expectedFacts: ['An action completes'], fixturesRoot: join(temporary, 'sessions'),
      hookBinary: resolve('packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook'),
    }
    const fake = fileURLToPath(new URL('./runtime.ts', import.meta.url))
    await writeFile(scenario, `export const options = ${JSON.stringify(options)}\nexport const run = async (session) => { await session.run(${JSON.stringify(process.execPath)}, [${JSON.stringify(fake)}, 'claude', 'first']) }\n`)
    const recorded = await exec(process.execPath, [cli, 'record', scenario])
    const directory = recorded.stdout.trim()
    expect(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).toMatchObject({ scenario: 'cli' })
    await expect(exec(process.execPath, [cli, 'verify', directory])).resolves.toMatchObject({ stderr: '' })
    await writeFile(join(directory, 'private.txt'), 'someone@example.org')
    await expect(exec(process.execPath, [cli, 'verify', directory])).rejects.toMatchObject({ code: 1 })
    await expect(exec(process.execPath, [cli])).rejects.toMatchObject({ code: 1 })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
