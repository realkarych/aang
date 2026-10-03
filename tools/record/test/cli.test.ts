import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadManifest } from '@aang/testkit'
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

test('CLI passes the regular Codex home option of a scenario module to the recorder', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'aang-record-cli-'))
  try {
    const codexHome = join(temporary, 'codex-home')
    await mkdir(join(codexHome, 'sessions'), { recursive: true })
    const scenario = join(temporary, 'scenario.mjs')
    const options = {
      runtime: 'codex', engineVersion: 'test', surface: 'codex_exec', scenario: 'regular', model: 'live', codexHome: 'regular',
      expectedFacts: ['A rollout appears in the regular Codex home'], fixturesRoot: join(temporary, 'sessions'),
      hookBinary: resolve('packages/hook/bin', process.platform === 'win32' ? 'aang-hook.exe' : 'aang-hook'),
    }
    const fake = fileURLToPath(new URL('./scenario-runtime.ts', import.meta.url))
    const module = (mode: string): string => `export const options = ${JSON.stringify({ ...options, codexHome: mode })}\nexport const run = async (session) => { await session.run(${JSON.stringify(process.execPath)}, [${JSON.stringify(fake)}, 'regular', 'thread-cli-1']) }\n`
    await writeFile(scenario, module('regular'))
    const env = { ...process.env, CODEX_HOME: codexHome }
    const recorded = await exec(process.execPath, [cli, 'record', scenario], { env })
    await access(join(codexHome, 'sessions', '2026', '10', '03', 'rollout-own.jsonl'))
    const playback = await loadManifest(join(recorded.stdout.trim(), 'playback.json'))
    expect(playback.steps.flatMap((step) => 'target' in step ? [step.target.path] : [])).toEqual(['sessions/2026/10/03/rollout-own.jsonl'])
    await writeFile(scenario, module('shared'))
    await expect(exec(process.execPath, [cli, 'record', scenario], { env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('codexHome') as unknown })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
